"""
Unified Feiya ERP App
- Auto-Fill & Inventory Balance
- Inventory Check (主库存表)
- Tracking
- Note for low inventory
"""
import json
import random
import time
from pathlib import Path

import pandas as pd
import streamlit as st
from streamlit_autorefresh import st_autorefresh

from inventory_autofill import fill_detail_inventory_inmemory, result_to_excel_bytes
from inventory_balance import (
    apply_transaction,
    balance_is_initialized,
    initialize_balance,
    load_balance,
    load_transaction_log,
    log_transaction,
    save_balance,
    BALANCE_FILE,
)

# =============================================================================
# CONFIG
# =============================================================================
BASE_DIR       = Path(__file__).resolve().parent
SHARED_DIR     = BASE_DIR / "data"
INVENTORY_FILE = SHARED_DIR / "主库存表.xlsx"
APP_CONFIG     = SHARED_DIR / "app_config.json"

HEADER_ROW   = 3
COL_STYLE    = "Style#"
COL_COLOR    = "color"
COL_SIZE     = "Size break"
COL_LOCATION = "LOCATION"
DISPLAY_COLS = [COL_STYLE, COL_COLOR, COL_SIZE, COL_LOCATION]
QTY_COLS     = ["Qty", "Quantity", "QTY", "数量", "qty", "quantity"]
SHARED_FILE  = SHARED_DIR / "current.csv"
CHAT_FILE    = SHARED_DIR / "low_inventory_notes.json"

DEFAULT_TEMPLATE = str(
    Path.home() / "Desktop/Feiya/销售考核表/Detail Inventory template.csv"
)


# =============================================================================
# APP CONFIG HELPERS
# =============================================================================
def load_app_config() -> dict:
    if APP_CONFIG.exists():
        try:
            return json.loads(APP_CONFIG.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"template_csv": DEFAULT_TEMPLATE}


def save_app_config(cfg: dict) -> None:
    SHARED_DIR.mkdir(parents=True, exist_ok=True)
    APP_CONFIG.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")


# =============================================================================
# EXISTING HELPERS
# =============================================================================
def file_mtime(path: Path) -> float:
    return path.stat().st_mtime if path.exists() else 0.0


@st.cache_data(show_spinner=False)
def load_inventory(path_str: str, mtime: float) -> pd.DataFrame:
    df = pd.read_excel(path_str, header=HEADER_ROW)
    missing = [c for c in DISPLAY_COLS if c not in df.columns]
    if missing:
        raise KeyError(f"Missing required columns in Excel: {missing}")
    qty_col = next((c for c in QTY_COLS if c in df.columns), None)
    cols = list(DISPLAY_COLS)
    if qty_col:
        df["Quantity"] = pd.to_numeric(df[qty_col], errors="coerce").fillna(0).astype(int)
        cols = [COL_STYLE, COL_COLOR, COL_SIZE, "Quantity", COL_LOCATION]
    df[COL_STYLE] = df[COL_STYLE].astype(str).fillna("").str.strip()
    for c in [COL_COLOR, COL_SIZE, COL_LOCATION]:
        if c in df.columns:
            df[c] = df[c].astype(str).replace("nan", "").fillna("").str.strip()
    df = df[[c for c in cols if c in df.columns]].copy()
    df["_style_search"] = df[COL_STYLE].str.lower()
    return df


def norm(s: str) -> str:
    return str(s).strip().replace(" ", "").lower()


def save_shared_csv(uploaded_file) -> None:
    SHARED_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SHARED_FILE.with_suffix(".tmp")
    tmp.write_bytes(uploaded_file.getbuffer())
    tmp.replace(SHARED_FILE)


def save_inventory_excel(uploaded_file) -> None:
    SHARED_DIR.mkdir(parents=True, exist_ok=True)
    if INVENTORY_FILE.exists():
        INVENTORY_FILE.unlink()
    INVENTORY_FILE.write_bytes(uploaded_file.getbuffer())


def mtime_or_zero(path: Path) -> float:
    return path.stat().st_mtime if path.exists() else 0.0


@st.cache_data(show_spinner=False)
def load_shared_csv(shared_path: str, mtime: float) -> pd.DataFrame:
    df = pd.read_csv(shared_path)
    required = {"Tracking", "SKU", "Quantity", "Actual Size On TEMU"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"CSV must contain columns: {sorted(required)}. Missing: {sorted(missing)}")
    df["Tracking"]           = df["Tracking"].astype(str).fillna("").str.strip()
    df["SKU"]                = df["SKU"].astype(str).fillna("").str.strip()
    df["Actual Size On TEMU"] = df["Actual Size On TEMU"].astype(str).fillna("").str.strip()
    df["Quantity"]           = pd.to_numeric(df["Quantity"], errors="coerce")
    df["_tracking_norm"]     = df["Tracking"].map(norm)
    return df


def load_chat_messages() -> list:
    if not CHAT_FILE.exists():
        return []
    try:
        msgs = json.loads(CHAT_FILE.read_text(encoding="utf-8"))
        for m in msgs:
            if "id" not in m:
                m["id"] = f"{m.get('ts', time.time())}_{random.randint(1000, 9999)}"
        return msgs
    except Exception:
        return []


def save_chat_messages(messages: list) -> None:
    SHARED_DIR.mkdir(parents=True, exist_ok=True)
    CHAT_FILE.write_text(json.dumps(messages, ensure_ascii=False, indent=2), encoding="utf-8")


def save_chat_message(name: str, text: str) -> None:
    messages = load_chat_messages()
    msg_id = f"{time.time():.6f}_{random.randint(1000, 9999)}"
    messages.append({"id": msg_id, "name": name, "text": text, "ts": time.time()})
    save_chat_messages(messages)


def delete_chat_message(msg_id: str) -> None:
    messages = [m for m in load_chat_messages() if m.get("id") != msg_id]
    save_chat_messages(messages)


def update_chat_message(msg_id: str, new_text: str) -> None:
    messages = load_chat_messages()
    for m in messages:
        if m.get("id") == msg_id:
            m["text"] = new_text
            m["ts"] = time.time()
            break
    save_chat_messages(messages)


# =============================================================================
# PAGE: AUTO-FILL & INVENTORY BALANCE
# =============================================================================
def render_autofill_balance():
    st.header("Auto-Fill & Inventory Balance")

    tab_process, tab_balance, tab_init = st.tabs([
        "📤 Process Transaction",
        "📊 Current Balance",
        "⚙️ Initialize Balance",
    ])

    # ── Tab 1: Process Transaction ────────────────────────────────────────────
    with tab_process:
        cfg = load_app_config()

        with st.expander("⚙️ Template Settings", expanded=not Path(cfg.get("template_csv", "")).exists()):
            tmpl_input = st.text_input(
                "Template CSV path",
                value=cfg.get("template_csv", DEFAULT_TEMPLATE),
                key="tmpl_path_input",
            )
            if st.button("Save template path", key="save_tmpl_btn"):
                cfg["template_csv"] = tmpl_input.strip()
                save_app_config(cfg)
                st.success("Template path saved!")

        tmpl_path = cfg.get("template_csv", "")
        tmpl_ok   = bool(tmpl_path) and Path(tmpl_path).exists()

        if not tmpl_ok:
            st.warning("⚠️ Template CSV not found. Set the correct path above.")

        src_file = st.file_uploader(
            "Upload source CSV (consolidated / merged / return)",
            type=["csv"],
            key="src_upload",
        )

        txn_label = st.radio(
            "Transaction type",
            ["📉  Sales — deduct from inventory", "📈  Return / Restock — add to inventory"],
            horizontal=True,
            key="txn_type_radio",
        )
        txn_type = "sales" if "Sales" in txn_label else "return"

        run_disabled = src_file is None or not tmpl_ok
        if st.button("▶  Run", type="primary", disabled=run_disabled, key="run_btn"):
            with st.spinner("Processing…"):
                try:
                    result = fill_detail_inventory_inmemory(tmpl_path, src_file)
                    st.session_state["fill_result"]   = result
                    st.session_state["fill_filename"] = src_file.name
                    st.session_state["fill_txn_type"] = txn_type
                    st.session_state["fill_applied"]  = False
                except Exception as e:
                    st.error(f"Processing failed: {e}")

        # ── Results ───────────────────────────────────────────────────────────
        if "fill_result" in st.session_state:
            result   = st.session_state["fill_result"]
            txn_t    = st.session_state.get("fill_txn_type", "sales")
            fname    = st.session_state.get("fill_filename", "output")
            applied  = st.session_state.get("fill_applied", False)

            ok_flag  = result["reconciled_total"] == result["src_total"]

            st.divider()
            c1, c2, c3, c4 = st.columns(4)
            c1.metric("Source Total",   result["src_total"])
            c2.metric("Filled",         result["filled_total"])
            c3.metric("Appended",       result["append_total"])
            c4.metric("Status",         "✓ OK" if ok_flag else "⚠ Mismatch",
                      delta="reconciled" if ok_flag else "check audit",
                      delta_color="normal" if ok_flag else "inverse")

            # Download
            xlsx_bytes = result_to_excel_bytes(result)
            base = Path(fname).stem
            st.download_button(
                "📥 Download Filled Template (.xlsx)",
                data=xlsx_bytes,
                file_name=f"Detail_Inventory_filled_{base}.xlsx",
                mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                key="dl_filled",
            )

            st.divider()

            # Apply to balance
            if balance_is_initialized():
                if applied:
                    st.success("✓ Already applied to inventory balance.")
                else:
                    icon = "📉" if txn_t == "sales" else "📈"
                    label = "Sales" if txn_t == "sales" else "Return / Restock"
                    if st.button(
                        f"{icon} Apply to Inventory Balance as {label}",
                        type="primary",
                        key="apply_bal_btn",
                    ):
                        with st.spinner("Updating balance…"):
                            _, summary = apply_transaction(result["filled"], txn_t)
                        if summary.get("error"):
                            st.error(summary["error"])
                        else:
                            log_transaction(fname, txn_t, {
                                "source_total":   result["src_total"],
                                "filled_total":   result["filled_total"],
                                "appended_total": result["append_total"],
                                "applied_units":  summary["applied_units"],
                                "unmatched_rows": summary["unmatched_rows"],
                            })
                            st.session_state["fill_applied"] = True
                            st.success(
                                f"✓ Balance updated! "
                                f"{summary['applied_units']:,} units {'deducted' if txn_t == 'sales' else 'added'}."
                            )
                            st.rerun()
            else:
                st.info("💡 Go to **⚙️ Initialize Balance** tab to set your starting inventory, "
                        "then every transaction will automatically update the running balance.")

    # ── Tab 2: Current Balance ────────────────────────────────────────────────
    with tab_balance:
        bal = load_balance()

        if bal.empty:
            st.info("No balance initialized yet. Go to ⚙️ Initialize Balance to get started.")
        else:
            total_qty  = int(bal["Quantity"].sum())
            skus_with  = int((bal["Quantity"] > 0).sum())
            skus_zero  = int((bal["Quantity"] <= 0).sum())

            m1, m2, m3 = st.columns(3)
            m1.metric("Total Units in Stock", f"{total_qty:,}")
            m2.metric("SKUs with Stock",      f"{skus_with:,}")
            m3.metric("SKUs at / Below Zero", f"{skus_zero:,}")

            st.divider()

            f1, f2, f3 = st.columns([2, 1, 1])
            with f1:
                search = st.text_input(
                    "Search",
                    placeholder="Style, color, size…",
                    key="bal_search",
                ).strip().lower()
            with f2:
                show_filter = st.selectbox(
                    "Filter",
                    ["All", "Low stock (< 5)", "Out of stock (≤ 0)"],
                    key="bal_filter",
                )
            with f3:
                sort_by = st.selectbox(
                    "Sort by",
                    ["Style", "Quantity ↑", "Quantity ↓"],
                    key="bal_sort",
                )

            display = bal[["Style", "Color", "Size", "Quantity"]].copy()
            display["Quantity"] = display["Quantity"].astype(int)

            if search:
                mask = (
                    display["Style"].str.lower().str.contains(search, na=False) |
                    display["Color"].str.lower().str.contains(search, na=False) |
                    display["Size"].str.lower().str.contains(search, na=False)
                )
                display = display[mask]

            if show_filter == "Low stock (< 5)":
                display = display[display["Quantity"] < 5]
            elif show_filter == "Out of stock (≤ 0)":
                display = display[display["Quantity"] <= 0]

            if sort_by == "Quantity ↑":
                display = display.sort_values("Quantity")
            elif sort_by == "Quantity ↓":
                display = display.sort_values("Quantity", ascending=False)
            else:
                display = display.sort_values(["Style", "Color", "Size"])

            st.dataframe(display, use_container_width=True, height=520)
            st.caption(f"Showing {len(display):,} of {len(bal):,} rows  |  "
                       f"Balance file: {BALANCE_FILE.name}")

            dl1, dl2 = st.columns(2)
            with dl1:
                csv_bytes = display.to_csv(index=False).encode()
                st.download_button(
                    "📥 Export view as CSV",
                    data=csv_bytes,
                    file_name="inventory_balance.csv",
                    mime="text/csv",
                    key="dl_bal_csv",
                )
            with dl2:
                from io import BytesIO
                buf = BytesIO()
                with pd.ExcelWriter(buf, engine="openpyxl") as writer:
                    display.to_excel(writer, sheet_name="Inventory Balance", index=False)
                buf.seek(0)
                st.download_button(
                    "📥 Export view as Excel",
                    data=buf.getvalue(),
                    file_name="inventory_balance.xlsx",
                    mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    key="dl_bal_xlsx",
                )

            # Transaction history
            log = load_transaction_log()
            if log:
                with st.expander(f"📋 Transaction History ({len(log)} transactions)"):
                    log_df = pd.DataFrame(reversed(log))
                    st.dataframe(log_df, use_container_width=True)

    # ── Tab 3: Initialize Balance ─────────────────────────────────────────────
    with tab_init:
        st.markdown("### Set Starting Inventory Balance")
        st.write(
            "Upload a **CSV or Excel** file with **Style, Color, Size, Quantity** columns "
            "to set the starting inventory level. This overwrites the current balance."
        )

        # Current status
        if balance_is_initialized():
            bal = load_balance()
            total_qty = int(bal["Quantity"].sum())
            mtime_str = time.ctime(BALANCE_FILE.stat().st_mtime)
            st.info(
                f"**Current balance:** {len(bal):,} rows · "
                f"{total_qty:,} total units · last updated {mtime_str}"
            )

        init_file = st.file_uploader(
            "Upload initial inventory (CSV or Excel)",
            type=["csv", "xlsx", "xls"],
            key="init_upload",
        )

        if init_file:
            if st.button("✅ Set as Starting Balance", type="primary", key="init_btn"):
                try:
                    if init_file.name.lower().endswith(".csv"):
                        df = pd.read_csv(init_file)
                    else:
                        df = pd.read_excel(init_file)

                    # Flexible column rename
                    rename = {}
                    for col in df.columns:
                        cl = col.strip().lower()
                        if cl in ("style", "style#", "style no", "sku"):
                            rename[col] = "Style"
                        elif cl in ("color", "colour"):
                            rename[col] = "Color"
                        elif cl == "size":
                            rename[col] = "Size"
                        elif cl in ("qty", "quantity", "count"):
                            rename[col] = "Quantity"
                    df = df.rename(columns=rename)

                    required = {"Style", "Color", "Size", "Quantity"}
                    missing  = required - set(df.columns)
                    if missing:
                        st.error(f"Missing columns: {sorted(missing)}")
                    else:
                        bal = initialize_balance(df)
                        total_qty = int(pd.to_numeric(bal["Quantity"], errors="coerce").fillna(0).sum())
                        st.success(
                            f"✓ Balance initialized: {len(bal):,} rows, {total_qty:,} total units."
                        )
                        st.rerun()
                except Exception as e:
                    st.error(f"Failed to initialize: {e}")

        # Danger zone
        if balance_is_initialized():
            st.divider()
            with st.expander("⚠️ Danger Zone"):
                st.warning("Resetting will zero-out all quantities but keep the row structure.")
                if st.button("Reset all quantities to zero", key="reset_bal_btn"):
                    bal = load_balance()
                    bal["Quantity"] = 0
                    save_balance(bal)
                    st.success("All quantities reset to zero.")
                    st.rerun()


# =============================================================================
# PAGE: INVENTORY CHECK (主库存表)
# =============================================================================
def render_inventory():
    st.header("Inventory Check – 主库存表")

    uploaded = st.file_uploader("Upload 主库存表 Excel", type=["xlsx", "xls"], key="inv_upload")
    if uploaded is not None:
        try:
            save_inventory_excel(uploaded)
            st.cache_data.clear()
            st.success("Uploaded. Previous file replaced.")
            st.rerun()
        except Exception as e:
            st.error(f"Upload failed: {e}")

    if not INVENTORY_FILE.exists():
        st.info("Upload a 主库存表 Excel file (columns: Style#, color, Size break, LOCATION) to get started.")
        return

    query = st.text_input(
        "", placeholder="Search style (e.g., m017, 50154, LT366)…", key="style_q"
    ).strip().lower()

    mtime = file_mtime(INVENTORY_FILE)
    try:
        df = load_inventory(str(INVENTORY_FILE), mtime)
    except Exception as e:
        st.error(f"Failed to load Excel file: {e}")
        return

    if not query:
        st.info("Enter a style number or partial to search.")
        return

    result = df[df["_style_search"].str.contains(query, na=False)].copy()
    if result.empty:
        st.write("No matches.")
        return

    result       = result.sort_values(by=[COL_STYLE, COL_LOCATION, COL_COLOR, COL_SIZE], na_position="last")
    display_cols = [c for c in result.columns if not c.startswith("_")]
    st.dataframe(result[display_cols], use_container_width=True, height=600)
    st.caption(f"Matches: {len(result):,} | 主库存表 updated: {time.ctime(mtime)}")
    csv_bytes = result[display_cols].to_csv(index=False).encode("utf-8")
    st.download_button(
        "Download results as CSV",
        data=csv_bytes,
        file_name="style_search_results.csv",
        mime="text/csv",
    )


# =============================================================================
# PAGE: TRACKING
# =============================================================================
def render_tracking():
    st.header("Tracking → SKU")
    c1, c2 = st.columns([1, 2], vertical_alignment="center")
    with c1:
        uploaded = st.file_uploader(
            "", type=["csv"], label_visibility="collapsed",
            help="Upload CSV with columns: Tracking, SKU, Quantity, Actual Size On TEMU.",
        )
        if uploaded is not None:
            try:
                save_shared_csv(uploaded)
                st.cache_data.clear()
                st.success("Uploaded.")
            except Exception as e:
                st.error(str(e))
    with c2:
        query = st.text_input(
            "", placeholder="Search tracking (partial ok)…",
            key="tr_q", label_visibility="collapsed"
        ).strip()

    if not SHARED_FILE.exists():
        st.info("No shared CSV uploaded yet. Upload one to start.")
        return

    mtime = mtime_or_zero(SHARED_FILE)
    try:
        df = load_shared_csv(str(SHARED_FILE), mtime)
    except Exception as e:
        st.error(str(e))
        return

    q = norm(query)
    if not q:
        st.info("Enter a tracking number to search.")
        return

    matches = df[df["_tracking_norm"].str.contains(q, na=False)].copy()
    if matches.empty:
        st.write("No matches.")
        return

    trackings        = sorted(matches["Tracking"].unique().tolist())
    selected_tracking = (
        trackings[0] if len(trackings) == 1
        else st.selectbox("Matched tracking numbers", trackings)
    )
    sel = matches[matches["Tracking"] == selected_tracking].copy()
    summary = (
        sel.assign(Quantity=sel["Quantity"].fillna(0))
        .groupby(["SKU", "Actual Size On TEMU"], as_index=False)["Quantity"]
        .sum()
        .sort_values(["SKU", "Actual Size On TEMU"])
    )
    st.markdown(f"**Tracking:** {selected_tracking}")
    st.dataframe(summary[["SKU", "Actual Size On TEMU", "Quantity"]], use_container_width=True, height=520)
    with st.expander("Show raw matched rows"):
        st.dataframe(
            sel[["Tracking", "SKU", "Actual Size On TEMU", "Quantity"]].sort_values(
                ["SKU", "Actual Size On TEMU"]
            ),
            use_container_width=True, height=320,
        )


# =============================================================================
# PAGE: LOW INVENTORY NOTES (CHAT)
# =============================================================================
def render_chat():
    st.header("Note for low inventory")
    st.caption("Live chat for team notes about low inventory. Enter your name to join.")

    if "chat_name" not in st.session_state:
        st.session_state.chat_name = ""
    if "editing_id" not in st.session_state:
        st.session_state.editing_id = None
    if "show_clear_confirm" not in st.session_state:
        st.session_state.show_clear_confirm = False

    if not st.session_state.chat_name:
        name = st.text_input("Enter your name to join the chat", key="chat_name_input",
                             placeholder="Enter your name…")
        if st.button("Join", key="join_chat") and name.strip():
            st.session_state.chat_name = name.strip()
            st.rerun()
        return

    st_autorefresh(interval=5000, limit=100, key="chat_refresh")

    btn_save, btn_clear, _ = st.columns([1, 1, 4])
    with btn_save:
        messages = load_chat_messages()
        if messages:
            chat_json = json.dumps(messages, ensure_ascii=False, indent=2)
            st.download_button(
                "💾 Save notes", data=chat_json,
                file_name="low_inventory_notes.json", mime="application/json",
                key="save_notes",
            )
    with btn_clear:
        if st.button("🗑️ Clear all", key="btn_clear"):
            st.session_state.show_clear_confirm = True

    if st.session_state.show_clear_confirm:
        st.error("⚠️ **Warning: This will permanently delete ALL chat messages.**")
        st.warning("This action cannot be undone.")
        c1, c2 = st.columns(2)
        with c1:
            if st.button("Yes, clear everything", type="primary", key="confirm_clear"):
                save_chat_messages([])
                st.session_state.show_clear_confirm = False
                st.rerun()
        with c2:
            if st.button("Cancel", key="cancel_clear"):
                st.session_state.show_clear_confirm = False
                st.rerun()
        st.stop()

    st.markdown(f"**Signed in as:** {st.session_state.chat_name}")

    messages = load_chat_messages()
    with st.container():
        if not messages:
            st.info("No messages yet. Be the first to add a note!")
        else:
            for m in messages:
                msg_id = m.get("id", "")
                is_own = m.get("name") == st.session_state.chat_name

                if st.session_state.editing_id == msg_id:
                    new_text = st.text_input(
                        "Edit your message", value=m.get("text", ""), key=f"edit_{msg_id}"
                    )
                    e1, e2 = st.columns(2)
                    with e1:
                        if st.button("Save", key=f"save_edit_{msg_id}"):
                            if new_text.strip():
                                update_chat_message(msg_id, new_text.strip())
                                st.session_state.editing_id = None
                                st.rerun()
                    with e2:
                        if st.button("Cancel", key=f"cancel_edit_{msg_id}"):
                            st.session_state.editing_id = None
                            st.rerun()
                else:
                    ts_str = time.strftime("%Y-%m-%d %H:%M", time.localtime(m.get("ts", 0)))
                    st.markdown(f"**{m['name']}** ({ts_str}): {m['text']}")
                    if is_own:
                        be, bd = st.columns(2)
                        with be:
                            if st.button("✏️ Edit", key=f"edit_btn_{msg_id}"):
                                st.session_state.editing_id = msg_id
                                st.rerun()
                        with bd:
                            if st.button("🗑️ Delete", key=f"del_btn_{msg_id}"):
                                delete_chat_message(msg_id)
                                st.rerun()
                    st.markdown("---")

    msg = st.text_input(
        "Type your message", key="chat_msg",
        placeholder="Type your note for low inventory…"
    )
    if st.button("Send", key="send_chat") and msg.strip():
        save_chat_message(st.session_state.chat_name, msg.strip())
        st.rerun()


# =============================================================================
# APP SHELL
# =============================================================================
st.set_page_config(page_title="Feiya ERP", layout="wide", initial_sidebar_state="collapsed")

st.markdown("""
<style>
[data-testid="stSidebar"] { display: none; }
.stNavButtons { margin: 0.5rem 0 1rem 0; }
.stNavButtons > div { gap: 0.5rem !important; }
.stNavButtons label { padding: 0.5rem 1rem !important; border-radius: 8px !important; }
</style>
""", unsafe_allow_html=True)

st.markdown("### Feiya ERP")

page = st.radio(
    "Navigate",
    [
        "Auto-Fill & Inventory Balance",
        "Inventory Check (主库存表)",
        "Tracking",
        "Note for low inventory",
    ],
    horizontal=True,
    label_visibility="collapsed",
    key="page_switcher",
    index=0,
)
st.divider()

if page == "Auto-Fill & Inventory Balance":
    render_autofill_balance()
elif page == "Inventory Check (主库存表)":
    render_inventory()
elif page == "Tracking":
    render_tracking()
elif page == "Note for low inventory":
    render_chat()
