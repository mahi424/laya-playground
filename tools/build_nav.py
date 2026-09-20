"""Stamp the one shared top bar (tools/nav.html) into every page, marking the current page.

    python tools/build_nav.py
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAV = open(os.path.join(ROOT, "tools", "nav.html"), encoding="utf-8").read().strip()
for page, current in (("index.html", "./"), ("playground.html", "playground"), ("about.html", "about")):
    path = os.path.join(ROOT, page)
    html = open(path, encoding="utf-8").read()
    nav = NAV.replace('<a href="%s">' % current, '<a href="%s" aria-current="page">' % current, 1)
    html, n = re.subn(r'<div class="bar-top">.*?\n</div>', lambda m: nav, html, count=1, flags=re.S)
    assert n == 1, page
    open(path, "w", encoding="utf-8").write(html)
    print("nav stamped into", page)
