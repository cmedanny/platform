"""Institutional Lens: Streamlit entry point.  Run:  streamlit run app.py

The UI only reads the SQLite database written by update.py, so it loads instantly.
"""
import os
from pathlib import Path

import streamlit as st

st.set_page_config(page_title="Institutional Lens", page_icon="◐", layout="wide", initial_sidebar_state="collapsed")

from lens.ui import components, detail, scanner  # noqa: E402

st.markdown(f"<style>{(Path(__file__).parent / 'lens' / 'ui' / 'style.css').read_text(encoding='utf-8')}</style>",
            unsafe_allow_html=True)


def _scanner():
    if _guard():
        scanner.render(PAGES["detail"])
    components.footer()


def _detail():
    if _guard():
        detail.render(PAGES["scanner"])
    components.footer()


def _guard() -> bool:
    if components.has_data():
        if os.environ.get("LENS_DEMO"):
            components.md('<div class="il-meta" style="border:1px solid var(--line);border-radius:6px;padding:8px 12px;'
                          'margin-bottom:1.2rem">DEMO DATA: SEC, 13F and FRED figures are real; prices, estimates, '
                          'ratings, holders, options and headlines are test placeholders. Not for decisions.</div>')
        return True
    components.md('<div class="il-brand">Institutional Lens</div><h1 class="il-h1">No data yet</h1>'
                  '<p class="il-note" style="margin-top:1rem">Run the updater once to download data '
                  '(double-click <b>run_update.bat</b>, or <code>python update.py</code>). A full run takes 1.5–3 hours; '
                  'for a quick look first, run <code>run_update.bat --tickers AAPL,MSFT,JPM</code>.</p>')
    return False


PAGES = {
    "scanner": st.Page(_scanner, title="Scanner", url_path="scanner", default=True),
    "detail": st.Page(_detail, title="Ticker Detail", url_path="ticker"),
}
st.navigation(list(PAGES.values()), position="hidden").run()
