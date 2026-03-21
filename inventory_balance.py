"""
inventory_balance.py
--------------------
Running inventory balance tracker backed by PostgreSQL (Neon).
All state lives in the database — no local files required.

Environment variable required:
  DATABASE_URL  – PostgreSQL connection string
                  e.g. postgresql://user:pass@host.neon.tech/db?sslmode=require
"""
from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from typing import Optional, Tuple

import pandas as pd
import psycopg2
import psycopg2.extras

from inventory_autofill import pick_style, norm_size, norm_color_key

BALANCE_COLS  = ["Style", "Color", "Size", "Quantity", "style_n", "size_n", "color_n"]
MAX_SNAPSHOTS = 5


# ── Database connection ────────────────────────────────────────────────────────

def _get_conn():
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        raise RuntimeError("DATABASE_URL environment variable is not set")
    return psycopg2.connect(url)


@contextmanager
def _db():
    conn = _get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def ensure_tables() -> None:
    """Create all required tables if they don't exist. Called once at server start."""
    with _db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS inventory_balance_rows (
                    id        SERIAL  PRIMARY KEY,
                    style_n   TEXT    NOT NULL,
                    size_n    TEXT    NOT NULL,
                    color_n   TEXT    NOT NULL,
                    style     TEXT    NOT NULL DEFAULT '',
                    color     TEXT    NOT NULL DEFAULT '',
                    size      TEXT    NOT NULL DEFAULT '',
                    quantity  INTEGER NOT NULL DEFAULT 0,
                    UNIQUE (style_n, size_n, color_n)
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS inventory_snapshots (
                    snap_id     TEXT    PRIMARY KEY,
                    label       TEXT    NOT NULL DEFAULT '',
                    source_name TEXT    NOT NULL DEFAULT '',
                    ts          TEXT    NOT NULL,
                    total_units INTEGER NOT NULL DEFAULT 0,
                    total_rows  INTEGER NOT NULL DEFAULT 0,
                    data        JSONB   NOT NULL DEFAULT '[]'
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS inventory_transactions (
                    id               SERIAL  PRIMARY KEY,
                    ts               TEXT    NOT NULL,
                    source_file      TEXT    NOT NULL DEFAULT '',
                    transaction_type TEXT    NOT NULL,
                    applied_rows     INTEGER NOT NULL DEFAULT 0,
                    applied_units    INTEGER NOT NULL DEFAULT 0
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS inventory_template (
                    id         INTEGER PRIMARY KEY DEFAULT 1,
                    content    TEXT    NOT NULL,
                    filename   TEXT    NOT NULL DEFAULT 'template.csv',
                    updated_at TEXT    NOT NULL
                )
            """)


# ── Key normalization ─────────────────────────────────────────────────────────

def _add_keys(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["style_n"] = df["Style"].apply(pick_style)
    df["size_n"]  = df["Size"].apply(norm_size)
    df["color_n"] = df["Color"].apply(norm_color_key)
    return df


# ── Load / Save ───────────────────────────────────────────────────────────────

def load_balance() -> pd.DataFrame:
    with _db() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute("""
                SELECT style    AS "Style",
                       color    AS "Color",
                       size     AS "Size",
                       quantity AS "Quantity",
                       style_n, size_n, color_n
                FROM inventory_balance_rows
                ORDER BY id
            """)
            rows = cur.fetchall()
    if not rows:
        return pd.DataFrame(columns=BALANCE_COLS)
    df = pd.DataFrame([dict(r) for r in rows])
    df["Quantity"] = pd.to_numeric(df["Quantity"], errors="coerce").fillna(0)
    return df[BALANCE_COLS].copy()


def save_balance(df: pd.DataFrame) -> None:
    """Replace the entire balance table with the given DataFrame."""
    records = [
        (
            str(row.get("style_n", "") or ""),
            str(row.get("size_n",  "") or ""),
            str(row.get("color_n", "") or ""),
            str(row.get("Style",   "") or ""),
            str(row.get("Color",   "") or ""),
            str(row.get("Size",    "") or ""),
            int(pd.to_numeric(row.get("Quantity", 0), errors="coerce") or 0),
        )
        for _, row in df.iterrows()
    ]
    with _db() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM inventory_balance_rows")
            if records:
                psycopg2.extras.execute_values(cur, """
                    INSERT INTO inventory_balance_rows
                        (style_n, size_n, color_n, style, color, size, quantity)
                    VALUES %s
                    ON CONFLICT (style_n, size_n, color_n) DO UPDATE
                        SET quantity = EXCLUDED.quantity,
                            style    = EXCLUDED.style,
                            color    = EXCLUDED.color,
                            size     = EXCLUDED.size
                """, records)


def balance_is_initialized() -> bool:
    with _db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM inventory_balance_rows")
            return cur.fetchone()[0] > 0


# ── Snapshot system ───────────────────────────────────────────────────────────

def save_snapshot(label: str = "", source_name: str = "") -> str:
    if not balance_is_initialized():
        return ""
    bal = load_balance()
    if bal.empty:
        return ""

    snapshot_id = time.strftime("%Y%m%d_%H%M%S")
    ts          = time.strftime("%Y-%m-%d %H:%M:%S")
    data_json   = json.dumps(bal.to_dict(orient="records"), ensure_ascii=False)

    with _db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO inventory_snapshots
                    (snap_id, label, source_name, ts, total_units, total_rows, data)
                VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)
                ON CONFLICT (snap_id) DO NOTHING
            """, (
                snapshot_id, label, source_name, ts,
                int(bal["Quantity"].sum()), len(bal), data_json,
            ))
            # Prune to MAX_SNAPSHOTS
            cur.execute("""
                DELETE FROM inventory_snapshots
                WHERE snap_id NOT IN (
                    SELECT snap_id FROM inventory_snapshots
                    ORDER BY ts DESC
                    LIMIT %s
                )
            """, (MAX_SNAPSHOTS,))
    return snapshot_id


def list_snapshots() -> list:
    with _db() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute("""
                SELECT snap_id AS id, label, source_name, ts AS timestamp,
                       total_units, total_rows
                FROM inventory_snapshots
                ORDER BY ts DESC
                LIMIT %s
            """, (MAX_SNAPSHOTS,))
            return [dict(r) for r in cur.fetchall()]


def restore_snapshot(snapshot_id: str) -> Tuple[Optional[pd.DataFrame], dict]:
    with _db() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute(
                "SELECT data FROM inventory_snapshots WHERE snap_id = %s",
                (snapshot_id,),
            )
            row = cur.fetchone()
    if not row:
        return None, {"error": f"Snapshot '{snapshot_id}' not found"}

    save_snapshot(label="pre_restore", source_name=f"before restoring {snapshot_id}")

    data = row["data"]
    if isinstance(data, str):
        data = json.loads(data)
    df = pd.DataFrame(data)
    for col in BALANCE_COLS:
        if col not in df.columns:
            df[col] = ""
    df["Quantity"] = pd.to_numeric(df["Quantity"], errors="coerce").fillna(0)
    save_balance(df)

    return df, {
        "ok":          True,
        "restored_id": snapshot_id,
        "total_units": int(df["Quantity"].sum()),
        "total_rows":  len(df),
    }


# ── Initialize ────────────────────────────────────────────────────────────────

def initialize_balance(df: pd.DataFrame) -> pd.DataFrame:
    if balance_is_initialized():
        save_snapshot(label="pre_init", source_name="before re-initialize")
    bal = df[["Style", "Color", "Size", "Quantity"]].copy()
    bal["Quantity"] = pd.to_numeric(bal["Quantity"], errors="coerce").fillna(0)
    bal = _add_keys(bal)
    bal = bal[bal["Style"].notna() & (bal["Style"].str.strip() != "")]
    # Merge rows that normalise to the same key — sum their quantities
    bal = (
        bal.groupby(["style_n", "size_n", "color_n"], as_index=False)
        .agg(Style=("Style", "first"), Color=("Color", "first"),
             Size=("Size", "first"), Quantity=("Quantity", "sum"))
    )
    bal = bal[BALANCE_COLS].reset_index(drop=True)
    save_balance(bal)
    return bal


# ── Apply Transaction ─────────────────────────────────────────────────────────

def apply_transaction(
    filled_df: pd.DataFrame,
    transaction_type: str,
    source_name: str = "",
) -> Tuple[Optional[pd.DataFrame], dict]:
    if not balance_is_initialized():
        return None, {"error": "Balance not initialized. Please set initial inventory first."}

    save_snapshot(label=transaction_type, source_name=source_name)

    txn = _add_keys(filled_df[["Style", "Color", "Size", "Quantity"]].copy())
    txn["Quantity"] = pd.to_numeric(txn["Quantity"], errors="coerce").fillna(0).astype(int)
    sign          = -1 if transaction_type == "sales" else +1
    applied_units = 0
    unmatched     = 0

    with _db() as conn:
        with conn.cursor() as cur:
            for _, row in txn[txn["Quantity"] != 0].iterrows():
                cur.execute("""
                    UPDATE inventory_balance_rows
                       SET quantity = quantity + %s
                     WHERE style_n = %s AND size_n = %s AND color_n = %s
                    RETURNING id
                """, (sign * int(row["Quantity"]), row["style_n"], row["size_n"], row["color_n"]))
                if cur.fetchone():
                    applied_units += abs(int(row["Quantity"]))
                else:
                    unmatched += 1

    balance = load_balance()
    return balance, {"applied_units": applied_units, "unmatched_rows": unmatched}


# ── Edit single quantity ──────────────────────────────────────────────────────

def edit_quantity(style_n: str, size_n: str, color_n: str, new_quantity: int) -> dict:
    if not balance_is_initialized():
        return {"error": "Balance not initialized"}
    save_snapshot(label="edit", source_name=f"manual edit {style_n}/{color_n}/{size_n}")
    with _db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT quantity FROM inventory_balance_rows
                WHERE style_n = %s AND size_n = %s AND color_n = %s
            """, (style_n, size_n, color_n))
            row = cur.fetchone()
            if not row:
                return {"error": f"Row not found: {style_n} / {size_n} / {color_n}"}
            old_qty = int(row[0])
            cur.execute("""
                UPDATE inventory_balance_rows SET quantity = %s
                WHERE style_n = %s AND size_n = %s AND color_n = %s
            """, (new_quantity, style_n, size_n, color_n))
    return {"ok": True, "old_quantity": old_qty, "new_quantity": new_quantity}


# ── Add rows ──────────────────────────────────────────────────────────────────

def preview_add_rows(df: pd.DataFrame) -> dict:
    bal = load_balance()
    df  = df[["Style", "Color", "Size", "Quantity"]].copy()
    df["Quantity"] = pd.to_numeric(df["Quantity"], errors="coerce").fillna(0)
    df  = _add_keys(df)
    existing_keys = set(zip(bal["style_n"], bal["size_n"], bal["color_n"]))
    to_add, already_exists = [], []
    for _, row in df.iterrows():
        key   = (row["style_n"], row["size_n"], row["color_n"])
        entry = {
            "Style":    row["Style"],
            "Color":    row["Color"],
            "Size":     row["Size"],
            "Quantity": int(row["Quantity"]),
            "style_n":  row["style_n"],
            "size_n":   row["size_n"],
            "color_n":  row["color_n"],
        }
        if key in existing_keys:
            m = (bal["style_n"] == key[0]) & (bal["size_n"] == key[1]) & (bal["color_n"] == key[2])
            entry["current_quantity"] = int(bal.loc[m, "Quantity"].iloc[0]) if m.any() else 0
            already_exists.append(entry)
        else:
            to_add.append(entry)
    return {"to_add": to_add, "already_exists": already_exists}


def confirm_add_rows(rows: list) -> dict:
    if not rows:
        return {"error": "No rows to add"}
    save_snapshot(label="add_rows", source_name="add styles via CSV")
    records = []
    for row in rows:
        style_n = row.get("style_n") or pick_style(str(row.get("Style", "")))
        size_n  = row.get("size_n")  or norm_size(str(row.get("Size", "")))
        color_n = row.get("color_n") or norm_color_key(str(row.get("Color", "")))
        records.append((
            style_n, size_n, color_n,
            str(row.get("Style", "")),
            str(row.get("Color", "")),
            str(row.get("Size",  "")),
            int(row.get("Quantity", 0)),
        ))
    with _db() as conn:
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(cur, """
                INSERT INTO inventory_balance_rows
                    (style_n, size_n, color_n, style, color, size, quantity)
                VALUES %s
                ON CONFLICT (style_n, size_n, color_n) DO NOTHING
            """, records)
    return {"ok": True, "added": len(rows)}


# ── Remove rows ───────────────────────────────────────────────────────────────

def preview_remove_rows(df: pd.DataFrame) -> dict:
    bal = load_balance()
    df  = _add_keys(df[["Style", "Color", "Size"]].copy())
    existing_keys = set(zip(bal["style_n"], bal["size_n"], bal["color_n"]))
    to_remove, not_found = [], []
    for _, row in df.iterrows():
        key   = (row["style_n"], row["size_n"], row["color_n"])
        entry = {
            "Style":   row["Style"],
            "Color":   row["Color"],
            "Size":    row["Size"],
            "style_n": row["style_n"],
            "size_n":  row["size_n"],
            "color_n": row["color_n"],
        }
        if key in existing_keys:
            m = (bal["style_n"] == key[0]) & (bal["size_n"] == key[1]) & (bal["color_n"] == key[2])
            entry["Quantity"] = int(bal.loc[m, "Quantity"].iloc[0]) if m.any() else 0
            to_remove.append(entry)
        else:
            not_found.append(entry)
    return {"to_remove": to_remove, "not_found": not_found}


def confirm_remove_rows(keys: list) -> dict:
    if not keys:
        return {"error": "No rows to remove"}
    save_snapshot(label="remove_rows", source_name="remove styles via CSV")
    removed = 0
    with _db() as conn:
        with conn.cursor() as cur:
            for k in keys:
                cur.execute("""
                    DELETE FROM inventory_balance_rows
                    WHERE style_n = %s AND size_n = %s AND color_n = %s
                """, (k["style_n"], k["size_n"], k["color_n"]))
                removed += cur.rowcount
    return {"ok": True, "removed": removed}


# ── Transaction Log ───────────────────────────────────────────────────────────

def log_transaction(source_name: str, transaction_type: str, stats: dict) -> None:
    ts            = time.strftime("%Y-%m-%d %H:%M:%S")
    applied_units = int(stats.get("applied_units", 0))
    applied_rows  = int(stats.get("applied_rows",  0))
    with _db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO inventory_transactions
                    (ts, source_file, transaction_type, applied_rows, applied_units)
                VALUES (%s, %s, %s, %s, %s)
            """, (ts, source_name, transaction_type, applied_rows, applied_units))


def load_transaction_log() -> list:
    with _db() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute("""
                SELECT ts AS timestamp, source_file, transaction_type,
                       applied_rows, applied_units
                FROM inventory_transactions
                ORDER BY id DESC
                LIMIT 100
            """)
            return [dict(r) for r in cur.fetchall()]


# ── Template storage ──────────────────────────────────────────────────────────

def save_template(content: str, filename: str = "template.csv") -> None:
    """Store the template CSV content in the database."""
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    with _db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO inventory_template (id, content, filename, updated_at)
                VALUES (1, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE
                    SET content    = EXCLUDED.content,
                        filename   = EXCLUDED.filename,
                        updated_at = EXCLUDED.updated_at
            """, (content, filename, ts))


def load_template_from_db() -> Optional[Tuple[str, str]]:
    """Returns (content, filename) or None if no template has been uploaded."""
    with _db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT content, filename FROM inventory_template WHERE id = 1")
            row = cur.fetchone()
    return (row[0], row[1]) if row else None
