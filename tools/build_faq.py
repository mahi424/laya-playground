"""Regenerate the FAQPage JSON-LD in index.html from the Q&As that are visible on the page.

    python tools/build_faq.py

Search engines expect FAQ markup to match the visible text exactly, so it is generated, not typed.
"""
import html
import json
import os
import re

PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "index.html")
page = open(PATH, encoding="utf-8").read()

text = lambda s: re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", s))).strip()
pairs = re.findall(r"<div><h3>(.*?)</h3>\s*<p>(.*?)</p></div>", page, flags=re.S)
faq = {"@context": "https://schema.org", "@type": "FAQPage", "@id": "https://brainfunctioncollapse.com/laya#faq",
       "mainEntity": [{"@type": "Question", "name": text(q), "acceptedAnswer": {"@type": "Answer", "text": text(a)}} for q, a in pairs]}

block = '<script type="application/ld+json" id="ld-faq">\n%s\n</script>' % json.dumps(faq, ensure_ascii=False, indent=1)
if 'id="ld-faq"' in page:
    page = re.sub(r'<script type="application/ld\+json" id="ld-faq">.*?</script>', lambda m: block, page, flags=re.S)
else:
    page = page.replace("</head>", block + "\n</head>", 1)
open(PATH, "w", encoding="utf-8").write(page)
print("FAQPage markup written for %d questions" % len(pairs))
