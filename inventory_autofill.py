# inventory_autofill.py
# Fill Detail Inventory template from a merged/return CSV using:
# - same style + same size
# - best similarity color within that style+size
# - append anything unmapped at the end (reconciled)
# - special rules:
#   * 5010071 -> 5020071
#   * 2010105 -> 2010015
#   * 53777   -> 95537
#   * 5010130 numeric sizes -> "5010130 stock"
#   * 95361 numeric 8/10/12/14/16 -> S/M/L/XL/XL
#   * 5020055 + denim + non-numeric size -> append (don't force into template)

from __future__ import annotations

import re
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from difflib import SequenceMatcher

STYLE_MAP = {
    "5010071": "5020071",
    "2010105": "2010015",
    "53777":   "95537",
    "7010015": "5010015",        # plus-size version — shares style key, matched by size bin
}

# Template has no header row — columns are positional.
TEMPLATE_COLS = ["Style", "Color", "Size", "Quantity"]


def extract_style_candidates(val) -> List[str]:
    if pd.isna(val):
        return []
    return re.findall(r"\d+", str(val))


# Words that meaningfully distinguish two otherwise-identical style numbers.
# These are appended to the style key so they get separate template bins.
# (M022 Missy/Petite/Plus are NOT listed here — their sizes already differ.)
_STYLE_QUALIFIERS = re.compile(r"\b(capri|short)\b", re.IGNORECASE)

def pick_style(val) -> str:
    """
    Extract style number robustly.
    Prefer 6-7 digit groups; else pick longest group.
    Appends a lowercase qualifier (e.g. 'capri', 'short') when two styles
    share the same number but differ by cut/variant word.
    """
    if pd.isna(val):
        return ""
    s = str(val).strip()
    groups = re.findall(r"\d+", s)
    if not groups:
        return ""
    preferred = [g for g in groups if len(g) in (6, 7)]
    base = (preferred[0].lstrip("0") or "0") if preferred else (max(groups, key=len).lstrip("0") or "0")
    m = _STYLE_QUALIFIERS.search(s)
    return (base + " " + m.group(1).lower()) if m else base


def norm_size(val) -> str:
    if pd.isna(val):
        return ""
    s = str(val).strip().upper().replace(" ", "")
    s = s.replace("1XL", "1X").replace("2XL", "2X").replace("3XL", "3X")
    s = s.replace("1/XL", "1X").replace("2/XL", "2X").replace("3/XL", "3X")
    return s


def norm_color_key(val) -> str:
    """
    Normalize color for matching:
    - split camelCase
    - lowercase
    - remove non-alphanumeric
    - strip embedded size tokens (xl, 1x, etc.)
    """
    if pd.isna(val):
        return ""
    s = str(val).strip()
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", s)
    s = s.lower().replace("&", "and")
    s = re.sub(r"[^a-z0-9]+", "", s)
    s = re.sub(r"(xxs|xxxl|xxl|xl|xs|ps|pm|pl|pxl|1x|2x|3x|4x|size)", "", s)
    return s


def is_numeric_like(size_n: str) -> bool:
    return bool(re.fullmatch(r"\d+(P|W)?", str(size_n))) or bool(re.fullmatch(r"\d+W", str(size_n)))


def color_score(src_c: str, tmpl_c: str) -> float:
    if not src_c or not tmpl_c:
        return 0.0
    if src_c == tmpl_c:
        return 1.0
    if src_c in tmpl_c or tmpl_c in src_c:
        return 0.95
    return SequenceMatcher(None, src_c, tmpl_c).ratio()


def size_fix_for_style(style_n: str, size_n: str) -> str:
    # Special rule: 95361 numeric -> alpha
    if style_n == "95361" and size_n in {"8", "10", "12", "14", "16"}:
        mapping = {"8": "S", "10": "M", "12": "L", "14": "XL", "16": "XL"}
        return mapping.get(size_n, size_n)
    return size_n


def detect_col(cols: List[str], candidates: List[str], default_idx: Optional[int] = None) -> str:
    lower = {c.lower(): c for c in cols}
    for cand in candidates:
        if cand in lower:
            return lower[cand]
    if default_idx is None:
        raise ValueError("Could not detect column among %s" % candidates)
    return cols[default_idx]


def load_template(template_csv: str) -> pd.DataFrame:
    """
    Load template CSV. Handles three formats:
    1. Simple 4-column (no header): positional Style, Color, Size, Quantity
    2. Simple 4-column (with header row): Style, Color, Size, Quantity
    3. Master inventory spreadsheet: multi-column file where a header row
       somewhere contains STYLE / COLOR / SIZE labels — extracts just those
       columns and leaves Quantity blank.
    """
    raw = pd.read_csv(template_csv, header=None, dtype=str)

    # ── Find the header row that contains STYLE, COLOR, SIZE ─────────────────
    header_row_idx = None
    style_col_idx = color_col_idx = size_col_idx = None

    for i, row in raw.iterrows():
        vals = [str(v).strip().upper() for v in row.fillna("").tolist()]
        if "STYLE" in vals and "COLOR" in vals and "SIZE" in vals:
            header_row_idx  = i
            style_col_idx   = vals.index("STYLE")
            color_col_idx   = vals.index("COLOR")
            size_col_idx    = vals.index("SIZE")
            break

    if header_row_idx is None:
        # Fallback: no header found — assume positional 4-column template
        df = raw.copy()
        df.columns = list(TEMPLATE_COLS) + list(df.columns[4:])
    elif raw.shape[1] <= 4:
        # Small file with a header row
        df = pd.read_csv(template_csv, dtype=str)
        rename = {}
        for col in df.columns:
            cl = col.strip().lower()
            if cl in ("style", "style#", "style no", "sku"):     rename[col] = "Style"
            elif cl in ("color", "colour"):                       rename[col] = "Color"
            elif cl == "size":                                     rename[col] = "Size"
            elif cl in ("qty", "quantity", "count"):              rename[col] = "Quantity"
        df = df.rename(columns=rename)
    else:
        # Multi-column master spreadsheet — extract Style/Color/Size columns.
        # Data starts two rows after the header (one sub-header row in between).
        data_start = header_row_idx + 2
        df = raw.iloc[data_start:, [style_col_idx, color_col_idx, size_col_idx]].copy()
        df.columns = ["Style", "Color", "Size"]
        df["Quantity"] = None

    # Ensure required columns exist
    for col in TEMPLATE_COLS:
        if col not in df.columns:
            df[col] = None

    # Drop blank/summary rows
    df = df[df["Style"].notna() & (df["Style"].str.strip() != "")].reset_index(drop=True)
    return df[["Style", "Color", "Size", "Quantity"]].copy()


def fill_detail_inventory(
    template_csv: str,
    source_csv: str,
    out_prefix: str = "Detail_Inventory_filled",
) -> dict:
    # ── Load & normalize template ─────────────────────────────────────────────
    tmpl = load_template(template_csv)

    t = tmpl.copy()
    t["style_n"] = t["Style"].apply(pick_style)
    t["size_n"]  = t["Size"].apply(norm_size)
    t["color_n"] = t["Color"].apply(norm_color_key)

    # Lookup: (style_n, size_n) -> [(row_index, color_n), ...]
    tmpl_lookup: Dict[Tuple[str, str], List[Tuple[int, str]]] = {}
    for (st, sz), g in t.groupby(["style_n", "size_n"]):
        tmpl_lookup[(st, sz)] = [(idx, t.at[idx, "color_n"]) for idx in g.index]

    # ── Load & normalize source ───────────────────────────────────────────────
    src = pd.read_csv(source_csv, dtype=str)
    cols = list(src.columns)
    style_col = detect_col(cols, ["style", "style#", "styleno", "style no", "sku"], default_idx=0)
    color_col = detect_col(cols, ["color", "colour"],  default_idx=1 if len(cols) > 1 else 0)
    size_col  = detect_col(cols, ["size"],             default_idx=2 if len(cols) > 2 else 0)
    qty_col   = detect_col(cols, ["qty", "quantity", "q", "count"], default_idx=len(cols) - 1)

    print("  source columns -> style=%r, color=%r, size=%r, qty=%r"
          % (style_col, color_col, size_col, qty_col))

    s = src.copy()
    s["style_n"]   = s[style_col].apply(pick_style).apply(lambda x: STYLE_MAP.get(x, x))
    s["size_n"]    = s[size_col].apply(norm_size)
    s["color_n"]   = s[color_col].apply(norm_color_key)
    s["color_raw"] = s[color_col].fillna("").astype(str)
    s["QTY"]       = pd.to_numeric(s[qty_col], errors="coerce").fillna(0).astype(int)

    # 5010130 numeric sizes -> "5010130 stock"
    s["style_n"] = s.apply(
        lambda r: "5010130 stock"
        if (r["style_n"] == "5010130" and is_numeric_like(r["size_n"]))
        else r["style_n"],
        axis=1,
    )

    # Special size fix (95361)
    s["size_n"] = s.apply(lambda r: size_fix_for_style(r["style_n"], r["size_n"]), axis=1)

    # Denim flag: 5020055 + denim + non-numeric size => append
    s["flag_append_denim"] = s.apply(
        lambda r: (
            r["style_n"] == "5020055"
            and "denim" in r["color_n"]
            and not is_numeric_like(r["size_n"])
        ),
        axis=1,
    )

    # Keep nonzero (returns can be negative)
    s_nonzero = s[s["QTY"] != 0].copy()
    for col in ["style_n", "size_n", "color_n", "color_raw"]:
        s_nonzero[col] = s_nonzero[col].fillna("").astype(str)

    src_total = int(s_nonzero["QTY"].sum())

    # Aggregate to avoid double-counting
    s_agg = (
        s_nonzero
        .groupby(["style_n", "size_n", "color_n", "color_raw", "flag_append_denim"], as_index=False)
        ["QTY"]
        .sum()
    )

    # ── Assign into template rows ─────────────────────────────────────────────
    qty_out = np.zeros(len(t), dtype=int)
    audit = []

    for _, r in s_agg.iterrows():
        st         = r["style_n"]
        sz         = r["size_n"]
        sc         = r["color_n"]
        sc_raw     = r["color_raw"]
        q          = int(r["QTY"])
        flag_denim = bool(r["flag_append_denim"])

        if flag_denim:
            audit.append((st, sz, sc_raw, q, None, None, 0.0, "append_denim_non_numeric"))
            continue

        candidates = tmpl_lookup.get((st, sz), [])
        if not candidates:
            audit.append((st, sz, sc_raw, q, None, None, 0.0, "append_no_style_size_bin"))
            continue

        best_idx, best_score = None, -1.0
        for idx, tc in candidates:
            score = color_score(sc, tc)
            if score > best_score:
                best_score, best_idx = score, idx

        qty_out[best_idx] += q
        audit.append((st, sz, sc_raw, q, int(best_idx), tmpl.loc[best_idx, "Color"], best_score, "assigned"))

    # ── Build filled template ─────────────────────────────────────────────────
    filled = tmpl.copy()
    filled["Quantity"] = qty_out.astype(float)
    filled.loc[filled["Quantity"] == 0, "Quantity"] = np.nan

    filled_total = int(pd.to_numeric(filled["Quantity"], errors="coerce").fillna(0).sum())

    audit_df = pd.DataFrame(
        audit,
        columns=["style_n", "src_size", "src_color", "src_qty",
                 "template_row", "template_color", "score", "status"],
    )

    append_rows = audit_df[audit_df["status"].str.startswith("append")].copy()
    append_total = int(append_rows["src_qty"].sum())

    # ── Reconciled output ─────────────────────────────────────────────────────
    extra_rows = append_rows.rename(columns={
        "style_n":  "Style",
        "src_color": "Color",
        "src_size":  "Size",
        "src_qty":   "Quantity",
    })[["Style", "Color", "Size", "Quantity"]]

    reconciled = pd.concat([filled, extra_rows], ignore_index=True)
    reconciled_total = int(pd.to_numeric(reconciled["Quantity"], errors="coerce").fillna(0).sum())

    # ── Save outputs ──────────────────────────────────────────────────────────
    out_csv   = out_prefix + ".csv"
    out_csv2  = out_prefix + "_reconciled.csv"
    out_xlsx  = out_prefix + ".xlsx"
    out_xlsx2 = out_prefix + "_reconciled.xlsx"

    filled.to_csv(out_csv, index=False)
    reconciled.to_csv(out_csv2, index=False)

    with pd.ExcelWriter(out_xlsx, engine="openpyxl") as writer:
        filled.to_excel(writer, sheet_name="Filled_Template", index=False)
        s_agg.sort_values(["style_n", "size_n", "color_n"]).to_excel(
            writer, sheet_name="Source_Aggregated", index=False)
        audit_df.sort_values(["status", "score", "src_qty"],
                              ascending=[True, True, False]).to_excel(
            writer, sheet_name="Assignment_Audit", index=False)
        extra_rows.to_excel(writer, sheet_name="Appended_Unmapped", index=False)

    with pd.ExcelWriter(out_xlsx2, engine="openpyxl") as writer:
        filled.to_excel(writer, sheet_name="Filled_Template", index=False)
        extra_rows.to_excel(writer, sheet_name="Appended_Unmapped", index=False)
        reconciled.to_excel(writer, sheet_name="Filled_plus_appended", index=False)
        s_agg.sort_values(["style_n", "size_n", "color_n"]).to_excel(
            writer, sheet_name="Source_Aggregated", index=False)
        audit_df.sort_values(["status", "score", "src_qty"],
                              ascending=[True, True, False]).to_excel(
            writer, sheet_name="Assignment_Audit", index=False)

    # ── Print reconciliation ──────────────────────────────────────────────────
    ok = "OK" if reconciled_total == src_total else "MISMATCH (diff=%d)" % (reconciled_total - src_total)
    print("\n--- Reconciliation -------------------------------------------")
    print("  Source total        : %d" % src_total)
    print("  Template filled     : %d" % filled_total)
    print("  Appended (unmatched): %d" % append_total)
    print("  Reconciled total    : %d  [%s]" % (reconciled_total, ok))
    print("--------------------------------------------------------------\n")
    print("Saved: %s" % out_xlsx)
    print("Saved: %s\n" % out_xlsx2)

    return {
        "source_total":      src_total,
        "filled_total":      filled_total,
        "appended_total":    append_total,
        "reconciled_total":  reconciled_total,
        "out_csv":           out_csv,
        "out_xlsx":          out_xlsx,
        "out_csv_reconciled": out_csv2,
        "out_xlsx_reconciled": out_xlsx2,
    }


# ── In-memory API (for Streamlit / web use) ───────────────────────────────────

def _core_fill(tmpl: pd.DataFrame, src: pd.DataFrame) -> dict:
    """
    Core fill logic shared by fill_detail_inventory and fill_detail_inventory_inmemory.
    tmpl : template DataFrame (Style, Color, Size, Quantity)
    src  : raw source DataFrame — columns are auto-detected
    Returns a dict with DataFrames + stats.  No files are written.
    """
    # Normalize template
    t = tmpl.copy()
    t["style_n"] = t["Style"].apply(pick_style)
    t["size_n"]  = t["Size"].apply(norm_size)
    t["color_n"] = t["Color"].apply(norm_color_key)

    tmpl_lookup: Dict[Tuple[str, str], List[Tuple[int, str]]] = {}
    for (st, sz), g in t.groupby(["style_n", "size_n"]):
        tmpl_lookup[(st, sz)] = [(idx, t.at[idx, "color_n"]) for idx in g.index]

    # Detect source columns
    cols       = list(src.columns)
    style_col  = detect_col(cols, ["style", "style#", "styleno", "style no", "sku"], default_idx=0)
    color_col  = detect_col(cols, ["color", "colour"],  default_idx=1 if len(cols) > 1 else 0)
    size_col   = detect_col(cols, ["size"],             default_idx=2 if len(cols) > 2 else 0)
    qty_col    = detect_col(cols, ["qty", "quantity", "q", "count"], default_idx=len(cols) - 1)

    # Normalize source
    s = src.copy()
    s["style_n"]   = s[style_col].apply(pick_style).apply(lambda x: STYLE_MAP.get(x, x))
    s["size_n"]    = s[size_col].apply(norm_size)
    s["color_n"]   = s[color_col].apply(norm_color_key)
    s["color_raw"] = s[color_col].fillna("").astype(str)
    s["QTY"]       = pd.to_numeric(s[qty_col], errors="coerce").fillna(0).astype(int)

    s["style_n"] = s.apply(
        lambda r: "5010130 stock"
        if (r["style_n"] == "5010130" and is_numeric_like(r["size_n"]))
        else r["style_n"], axis=1)
    s["size_n"] = s.apply(lambda r: size_fix_for_style(r["style_n"], r["size_n"]), axis=1)
    s["flag_append_denim"] = s.apply(
        lambda r: (r["style_n"] == "5020055"
                   and "denim" in r["color_n"]
                   and not is_numeric_like(r["size_n"])), axis=1)

    s_nonzero = s[s["QTY"] != 0].copy()
    for col in ["style_n", "size_n", "color_n", "color_raw"]:
        s_nonzero[col] = s_nonzero[col].fillna("").astype(str)

    src_total = int(s_nonzero["QTY"].sum())
    s_agg = (s_nonzero
             .groupby(["style_n", "size_n", "color_n", "color_raw", "flag_append_denim"], as_index=False)
             ["QTY"].sum())

    # Assign quantities into template rows
    qty_out = np.zeros(len(t), dtype=int)
    audit   = []

    for _, r in s_agg.iterrows():
        st, sz, sc = r["style_n"], r["size_n"], r["color_n"]
        sc_raw, q  = r["color_raw"], int(r["QTY"])
        flag_denim = bool(r["flag_append_denim"])

        if flag_denim:
            audit.append((st, sz, sc_raw, q, None, None, 0.0, "append_denim_non_numeric"))
            continue
        candidates = tmpl_lookup.get((st, sz), [])
        if not candidates:
            audit.append((st, sz, sc_raw, q, None, None, 0.0, "append_no_style_size_bin"))
            continue

        best_idx, best_score = None, -1.0
        for idx, tc in candidates:
            score = color_score(sc, tc)
            if score > best_score:
                best_score, best_idx = score, idx

        qty_out[best_idx] += q
        audit.append((st, sz, sc_raw, q, int(best_idx), tmpl.loc[best_idx, "Color"],
                      best_score, "assigned"))

    filled = tmpl.copy()
    filled["Quantity"] = qty_out.astype(float)
    filled.loc[filled["Quantity"] == 0, "Quantity"] = np.nan
    filled_total = int(pd.to_numeric(filled["Quantity"], errors="coerce").fillna(0).sum())

    audit_df = pd.DataFrame(audit, columns=[
        "style_n", "src_size", "src_color", "src_qty",
        "template_row", "template_color", "score", "status"])

    append_rows  = audit_df[audit_df["status"].str.startswith("append")].copy()
    append_total = int(append_rows["src_qty"].sum())

    extra_rows = append_rows.rename(columns={
        "style_n": "Style", "src_color": "Color",
        "src_size": "Size", "src_qty": "Quantity",
    })[["Style", "Color", "Size", "Quantity"]]

    reconciled       = pd.concat([filled, extra_rows], ignore_index=True)
    reconciled_total = int(pd.to_numeric(reconciled["Quantity"], errors="coerce").fillna(0).sum())

    return {
        "filled":           filled,
        "reconciled":       reconciled,
        "audit_df":         audit_df,
        "source_agg":       s_agg,
        "src_total":        src_total,
        "filled_total":     filled_total,
        "append_total":     append_total,
        "reconciled_total": reconciled_total,
        "col_info": {
            "style_col": style_col, "color_col": color_col,
            "size_col":  size_col,  "qty_col":   qty_col,
        },
    }


def fill_detail_inventory_inmemory(template_csv: str, source_io) -> dict:
    """
    Same as fill_detail_inventory but returns DataFrames instead of writing files.
    source_io : file path (str) or file-like object (e.g. Streamlit UploadedFile / BytesIO).
    """
    tmpl = load_template(template_csv)
    src  = pd.read_csv(source_io, dtype=str)
    return _core_fill(tmpl, src)


def result_to_excel_bytes(result: dict) -> bytes:
    """
    Convert a fill result dict (from fill_detail_inventory_inmemory) to Excel bytes
    ready for st.download_button.
    """
    from io import BytesIO
    buf = BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        result["filled"].to_excel(
            writer, sheet_name="Filled_Template", index=False)
        result["reconciled"].to_excel(
            writer, sheet_name="Filled_plus_appended", index=False)
        result["source_agg"].sort_values(
            ["style_n", "size_n", "color_n"]).to_excel(
            writer, sheet_name="Source_Aggregated", index=False)
        result["audit_df"].sort_values(
            ["status", "score", "src_qty"], ascending=[True, True, False]).to_excel(
            writer, sheet_name="Assignment_Audit", index=False)
    buf.seek(0)
    return buf.getvalue()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Fill Detail Inventory template")
    parser.add_argument("--template", required=True, help="Template CSV path")
    parser.add_argument("--source",   required=True, help="Source CSV path")
    parser.add_argument("--out",      default="Detail_Inventory_filled", help="Output filename prefix")
    args = parser.parse_args()

    result = fill_detail_inventory(
        template_csv=args.template,
        source_csv=args.source,
        out_prefix=args.out,
    )
