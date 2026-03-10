"""
Unified Feiya ERP App
- Inventory Check, Tracking, Note for low inventory
"""
import json
import random
import time
from pathlib import Path

import pandas as pd
import streamlit as st
from streamlit_autorefresh import st_autorefresh

# =========================
# CONFIG
# =========================
BASE_DIR = Path(__file__).resolve().parent
SHARED_DIR = BASE_DIR / "data"
INVENTORY_FILE = SHARED_DIR / "主库存表.xlsx"
HEADER_ROW = 3
COL_STYLE = "Style#"
COL_COLOR = "color"
COL_SIZE = "Size break"
COL_LOCATION = "LOCATION"
DISPLAY_COLS = [COL_STYLE, COL_COLOR, COL_SIZE, COL_LOCATION]
# Optional quantity column (if exists in Excel)
QTY_COLS = ["Qty", "Quantity", "QTY", "数量", "qty", "quantity"]
SHARED_FILE = SHARED_DIR / "current.csv"
CHAT_FILE = SHARED_DIR / "low_inventory_notes.json"

# =========================
# HELPERS
# =========================
def file_mtime(path: Path) -> float:
    return path.stat().st_mtime if path.exists() else 0.0


@st.cache_data(show_spinner=False)
def load_inventory(path_str: str, mtime: float) -> pd.DataFrame:
    df = pd.read_excel(path_str, header=HEADER_ROW)
    missing = [c for c in DISPLAY_COLS if c not in df.columns]
    if missing:
        raise KeyError(f"Missing required columns in Excel: {missing}")
    # Include quantity if column exists
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
    """Save uploaded 主库存表. Deletes old file if exists."""
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
    df["Tracking"] = df["Tracking"].astype(str).fillna("").str.strip()
    df["SKU"] = df["SKU"].astype(str).fillna("").str.strip()
    df["Actual Size On TEMU"] = df["Actual Size On TEMU"].astype(str).fillna("").str.strip()
    df["Quantity"] = pd.to_numeric(df["Quantity"], errors="coerce")
    df["_tracking_norm"] = df["Tracking"].map(norm)
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


# =========================
# APP
# =========================
st.set_page_config(page_title="Feiya ERP", layout="wide", initial_sidebar_state="collapsed")

# ----- Top bar: hide sidebar -----
st.markdown("""
<style>
[data-testid="stSidebar"] { display: none; }
.stNavButtons { margin: 0.5rem 0 1rem 0; }
.stNavButtons > div { gap: 0.5rem !important; }
.stNavButtons label { padding: 0.5rem 1rem !important; border-radius: 8px !important; }
</style>
""", unsafe_allow_html=True)

# ----- Top bar: title -----
st.markdown("### Feiya ERP")

# ----- Page switcher (button-style) -----
page_options = ["Inventory Check (主库存表)", "Tracking", "Note for low inventory"]
page = st.radio(
    "Navigate",
    page_options,
    horizontal=True,
    label_visibility="collapsed",
    key="page_switcher",
    index=0,
)
st.divider()

# ----- Page: 主库存表 (admin only) -----
def render_inventory():
    st.header("Inventory Check – 主库存表")

    # Upload 主库存表
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
        st.info("Upload a 主库存表 Excel file (with columns: Style#, color, Size break, LOCATION) to get started.")
        return

    query = st.text_input("", placeholder="Search style (e.g., m017, 50154, LT366)...", key="style_q").strip().lower()

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

    result = result.sort_values(by=[COL_STYLE, COL_LOCATION, COL_COLOR, COL_SIZE], na_position="last")
    display_cols = [c for c in result.columns if not c.startswith("_")]
    st.dataframe(result[display_cols], use_container_width=True, height=600)
    st.caption(f"Matches: {len(result):,} | 主库存表 updated: {time.ctime(mtime)}")
    csv_bytes = result[display_cols].to_csv(index=False).encode("utf-8")
    st.download_button("Download results as CSV", data=csv_bytes, file_name="style_search_results.csv", mime="text/csv")

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
        query = st.text_input("", placeholder="Search tracking (partial ok)...", key="tr_q", label_visibility="collapsed").strip()

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

    trackings = sorted(matches["Tracking"].unique().tolist())
    selected_tracking = trackings[0] if len(trackings) == 1 else st.selectbox("Matched tracking numbers", trackings)
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
        st.dataframe(sel[["Tracking", "SKU", "Actual Size On TEMU", "Quantity"]].sort_values(["SKU", "Actual Size On TEMU"]), use_container_width=True, height=320)

def render_chat():
    st.header("Note for low inventory")
    st.caption("Live chat for team notes about low inventory. Enter your name to join.")

    # Session state for user name
    if "chat_name" not in st.session_state:
        st.session_state.chat_name = ""
    if "editing_id" not in st.session_state:
        st.session_state.editing_id = None
    if "show_clear_confirm" not in st.session_state:
        st.session_state.show_clear_confirm = False

    if not st.session_state.chat_name:
        name = st.text_input("Enter your name to join the chat", key="chat_name_input", placeholder="Enter your name...")
        if st.button("Join", key="join_chat") and name.strip():
            st.session_state.chat_name = name.strip()
            st.rerun()
        return

    # Live refresh: auto-update every 5 seconds
    st_autorefresh(interval=5000, limit=100, key="chat_refresh")

    # Action buttons row
    btn_save, btn_clear, _ = st.columns([1, 1, 4])
    with btn_save:
        messages = load_chat_messages()
        if messages:
            chat_json = json.dumps(messages, ensure_ascii=False, indent=2)
            st.download_button("💾 Save notes", data=chat_json, file_name="low_inventory_notes.json", mime="application/json", key="save_notes")
    with btn_clear:
        if st.button("🗑️ Clear all", key="btn_clear"):
            st.session_state.show_clear_confirm = True

    # Clear confirmation
    if st.session_state.show_clear_confirm:
        st.error("⚠️ **Warning: This will permanently delete ALL chat messages.**")
        st.warning("This action cannot be undone. Important team notes about low inventory may be lost forever. Other team members may lose critical information.")
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

    # Chat messages with edit/delete for own messages
    messages = load_chat_messages()
    chat_container = st.container()
    with chat_container:
        if not messages:
            st.info("No messages yet. Be the first to add a note!")
        else:
            for m in messages:
                msg_id = m.get("id", "")
                is_own = m.get("name") == st.session_state.chat_name

                if st.session_state.editing_id == msg_id:
                    new_text = st.text_input("Edit your message", value=m.get("text", ""), key=f"edit_{msg_id}")
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
                    st.markdown(f"**{m['name']}:** {m['text']}")
                    st.caption(time.strftime("%Y-%m-%d %H:%M", time.localtime(m.get("ts", 0))))
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

    # Send message
    msg = st.text_input("Type your message", key="chat_msg", placeholder="Type your note for low inventory...")
    if st.button("Send", key="send_chat") and msg.strip():
        save_chat_message(st.session_state.chat_name, msg.strip())
        st.rerun()

# ----- Render page content -----
if page == "Inventory Check (主库存表)":
    render_inventory()
elif page == "Tracking":
    render_tracking()
elif page == "Note for low inventory":
    render_chat()
