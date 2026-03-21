"""
inventory_server.py
-------------------
Flask API server — bridges the React frontend to the Python inventory logic.
Designed to run on Railway (or any cloud host) with a PostgreSQL (Neon) backend.

Environment variables:
  DATABASE_URL    – PostgreSQL connection string (required)
  PORT            – Port to listen on (Railway sets this automatically; default 8502)
  ALLOWED_ORIGIN  – Comma-separated allowed CORS origins, or * (default *)
"""
from __future__ import annotations

import base64
import os
import tempfile
import traceback

import pandas as pd
from flask import Flask, jsonify, request
from flask_cors import CORS

from inventory_autofill import fill_detail_inventory_inmemory, result_to_excel_bytes
from inventory_balance import (
    apply_transaction,
    balance_is_initialized,
    confirm_add_rows,
    confirm_remove_rows,
    edit_quantity,
    ensure_tables,
    initialize_balance,
    list_snapshots,
    load_balance,
    load_template_from_db,
    load_transaction_log,
    log_transaction,
    preview_add_rows,
    preview_remove_rows,
    restore_snapshot,
    save_balance,
    save_snapshot,
    save_template,
)

# ── App setup ─────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app, origins=os.environ.get("ALLOWED_ORIGIN", "*"))

# Initialise DB tables on startup
try:
    ensure_tables()
    print("  ✓ Database tables ready")
except Exception as _e:
    print(f"  ✗ Database init failed: {_e}")
    print("    → Make sure DATABASE_URL is set correctly")


# ── Health ────────────────────────────────────────────────────────────────────
@app.route("/")
def health():
    return jsonify({"status": "ok", "service": "Feiya Inventory API"})


# ── Template ──────────────────────────────────────────────────────────────────
@app.route("/config", methods=["GET"])
def get_config():
    """Returns whether the Detail Inventory template has been uploaded."""
    t = load_template_from_db()
    return jsonify({
        "template_exists": t is not None,
        "template_name":   t[1] if t else None,
    })


@app.route("/template/upload", methods=["POST"])
def upload_template():
    """Upload (or replace) the Detail Inventory template CSV."""
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "No file uploaded"}), 400
    try:
        content = f.read().decode("utf-8", errors="replace")
        save_template(content, f.filename)
        return jsonify({"ok": True, "filename": f.filename})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Fill ──────────────────────────────────────────────────────────────────────
@app.route("/fill", methods=["POST"])
def fill():
    """
    Accepts: multipart/form-data with a 'source' CSV file.
    Returns: JSON with stats, base64-encoded xlsx, and filled rows.
    """
    t = load_template_from_db()
    if not t:
        return jsonify({
            "error": (
                "Template not uploaded yet. "
                "Click the Settings button and upload the Detail Inventory template CSV."
            )
        }), 400

    src_file = request.files.get("source")
    if not src_file:
        return jsonify({"error": "No source file uploaded"}), 400

    content, filename = t
    suffix = ".csv" if filename.lower().endswith(".csv") else ".xlsx"

    # Write template to a temporary file so the autofill logic can read it
    tf = tempfile.NamedTemporaryFile(
        mode="w", suffix=suffix, delete=False, encoding="utf-8"
    )
    tf.write(content)
    tf.close()

    try:
        result     = fill_detail_inventory_inmemory(tf.name, src_file)
        xlsx_bytes = result_to_excel_bytes(result)
        xlsx_b64   = base64.b64encode(xlsx_bytes).decode("utf-8")

        filled_json = (
            result["filled"]
            .assign(Quantity=lambda df: pd.to_numeric(df["Quantity"], errors="coerce").fillna(0))
            .to_dict(orient="records")
        )
        return jsonify({
            "ok":    True,
            "stats": {
                "src_total":        result["src_total"],
                "filled_total":     result["filled_total"],
                "append_total":     result["append_total"],
                "reconciled_total": result["reconciled_total"],
            },
            "xlsx_b64":    xlsx_b64,
            "filled_rows": filled_json,
        })
    except Exception as e:
        return jsonify({"error": str(e), "detail": traceback.format_exc()}), 500
    finally:
        os.unlink(tf.name)


# ── Balance ───────────────────────────────────────────────────────────────────
@app.route("/balance", methods=["GET"])
def get_balance():
    bal  = load_balance()
    rows = (
        bal[["Style", "Color", "Size", "Quantity", "style_n", "size_n", "color_n"]]
        .assign(Quantity=lambda df: df["Quantity"].astype(int))
        .to_dict(orient="records")
    )
    return jsonify({
        "initialized":   balance_is_initialized(),
        "rows":          rows,
        "total_units":   int(bal["Quantity"].sum()),
        "total_rows":    len(bal),
        "skus_in_stock": int((bal["Quantity"] > 0).sum()),
        "skus_zero":     int((bal["Quantity"] <= 0).sum()),
    })


@app.route("/balance/init", methods=["POST"])
def init_balance():
    """Upload initial inventory CSV/XLSX to set the starting balance."""
    init_file = request.files.get("file")
    if not init_file:
        return jsonify({"error": "No file uploaded"}), 400
    try:
        df = _read_upload(init_file)
        missing = {"Style", "Color", "Size", "Quantity"} - set(df.columns)
        if missing:
            return jsonify({"error": f"Missing columns: {sorted(missing)}"}), 400
        bal = initialize_balance(df)
        return jsonify({
            "ok":          True,
            "total_rows":  len(bal),
            "total_units": int(pd.to_numeric(bal["Quantity"], errors="coerce").fillna(0).sum()),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/balance/apply", methods=["POST"])
def apply_balance():
    """Apply a fill result (filled_rows JSON) to the running balance."""
    data        = request.get_json(force=True)
    txn_type    = data.get("txn_type", "sales")
    filled_rows = data.get("filled_rows", [])
    source_name = data.get("source_name", "unknown")
    if not filled_rows:
        return jsonify({"error": "No filled rows provided"}), 400
    try:
        filled_df  = pd.DataFrame(filled_rows)
        _, summary = apply_transaction(filled_df, txn_type, source_name=source_name)
        if summary.get("error"):
            return jsonify({"error": summary["error"]}), 400
        log_transaction(source_name, txn_type, summary)
        return jsonify({"ok": True, **summary})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/balance/reset", methods=["POST"])
def reset_balance():
    bal = load_balance()
    if bal.empty:
        return jsonify({"error": "No balance to reset"}), 400
    save_snapshot(label="pre_reset", source_name="before reset to zero")
    bal["Quantity"] = 0
    save_balance(bal)
    return jsonify({"ok": True})


@app.route("/balance/transactions", methods=["GET"])
def get_transactions():
    log = load_transaction_log()
    return jsonify({"transactions": log})  # already newest-first from query


@app.route("/balance/history", methods=["GET"])
def get_history():
    return jsonify({"snapshots": list_snapshots()})


@app.route("/balance/restore/<snapshot_id>", methods=["POST"])
def restore(snapshot_id):
    try:
        _, result = restore_snapshot(snapshot_id)
        if result.get("error"):
            return jsonify(result), 404
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Edit / Add rows / Remove rows ─────────────────────────────────────────────

def _rename_cols(df: pd.DataFrame) -> pd.DataFrame:
    """Normalise common column name variants to Style / Color / Size / Quantity."""
    rename = {}
    for col in df.columns:
        cl = col.strip().lower()
        if   cl in ("style", "style#", "style no", "sku"): rename[col] = "Style"
        elif cl in ("color", "colour"):                     rename[col] = "Color"
        elif cl == "size":                                  rename[col] = "Size"
        elif cl in ("qty", "quantity", "count"):            rename[col] = "Quantity"
    return df.rename(columns=rename)


def _read_upload(file_storage) -> pd.DataFrame:
    """Read a CSV or Excel FileStorage object into a normalised DataFrame."""
    name = file_storage.filename.lower()
    df   = pd.read_csv(file_storage) if name.endswith(".csv") else pd.read_excel(file_storage)
    return _rename_cols(df)


@app.route("/balance/edit", methods=["PATCH"])
def edit_qty():
    data         = request.get_json(force=True)
    style_n      = data.get("style_n", "")
    size_n       = data.get("size_n",  "")
    color_n      = data.get("color_n", "")
    new_quantity = data.get("new_quantity")
    if new_quantity is None:
        return jsonify({"error": "new_quantity is required"}), 400
    try:
        result = edit_quantity(style_n, size_n, color_n, int(new_quantity))
        if result.get("error"):
            return jsonify(result), 400
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/balance/preview-add", methods=["POST"])
def preview_add():
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "No file uploaded"}), 400
    try:
        df = _read_upload(f)
        missing = {"Style", "Color", "Size"} - set(df.columns)
        if missing:
            return jsonify({"error": f"Missing columns: {sorted(missing)}"}), 400
        if "Quantity" not in df.columns:
            df["Quantity"] = 0
        return jsonify(preview_add_rows(df))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/balance/confirm-add", methods=["POST"])
def confirm_add():
    data = request.get_json(force=True)
    rows = data.get("rows", [])
    if not rows:
        return jsonify({"error": "No rows provided"}), 400
    try:
        result = confirm_add_rows(rows)
        if result.get("error"):
            return jsonify(result), 400
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/balance/preview-remove", methods=["POST"])
def preview_remove():
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "No file uploaded"}), 400
    try:
        df = _read_upload(f)
        missing = {"Style", "Color", "Size"} - set(df.columns)
        if missing:
            return jsonify({"error": f"Missing columns: {sorted(missing)}"}), 400
        return jsonify(preview_remove_rows(df))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/balance/confirm-remove", methods=["POST"])
def confirm_remove():
    data = request.get_json(force=True)
    keys = data.get("keys", [])
    if not keys:
        return jsonify({"error": "No keys provided"}), 400
    try:
        result = confirm_remove_rows(keys)
        if result.get("error"):
            return jsonify(result), 400
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8502))
    print(f"\n  Feiya Inventory API  →  http://localhost:{port}\n")
    app.run(host="0.0.0.0", port=port, debug=False)
