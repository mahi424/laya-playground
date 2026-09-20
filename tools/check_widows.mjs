// No text block may end on a single word. This loads every page at three widths in headless Chrome and lists
// each paragraph, list item, caption or heading whose last line holds exactly one word.
//
//     python3 -m http.server 8771 --bind 127.0.0.1      (or the static-preview launch config)
//     node tools/check_widows.mjs [base-url]
//
// Two display headlines break on purpose, as designed ("Laya vs Jev, / measured." and "brain function / collapse.");
// they are reported under "headlines" and do not fail the run. Everything else must be clean.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
const port = 9388, dir = tmpdir(), base = (process.argv[2] || 'http://127.0.0.1:8771').replace(/\/$/, '');
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}/chrome-profile-widows`, '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let target; for (let i = 0; i < 40 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map(); ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result); pend.delete(d.id); } };
const cdp = (method, params = {}) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const probe = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('p, li, dd, dt, h1, h2, h3, figcaption, .timeline span, .stats span')) {
    if (el.closest('pre, .editor, details') || !el.getClientRects().length) continue;
    if (el.querySelector('p, li, dd, h3')) continue;                       // only leaf text blocks
    const words = [], walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) for (const m of n.textContent.matchAll(/\\S+/g)) {
      const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
      const b = r.getClientRects()[0]; if (b) words.push({ w: m[0], top: Math.round(b.top) });
    }
    if (words.length < 3) continue;
    const lines = []; for (const w of words) { const l = lines[lines.length - 1]; if (l && Math.abs(l.top - w.top) < 6) l.words.push(w.w); else lines.push({ top: w.top, words: [w.w] }); }
    // a word glued to the previous one by an inline boundary (link + full stop) reads as one word
    const last = lines[lines.length - 1];
    if (lines.length > 1 && last.words.length === 1) out.push(el.tagName.toLowerCase() + ': …' + lines[lines.length - 2].words.slice(-3).join(' ') + ' / ' + last.words[0]);
  }
  return out;
})()`;
let bad = 0;
for (const [w, h] of [[1440, 900], [1024, 800], [390, 844]]) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
  for (const page of ['index.html', 'about.html', 'playground.html']) {
    await cdp('Page.navigate', { url: `${base}/${page}` }); await sleep(2200);
    const all = (await cdp('Runtime.evaluate', { expression: probe, returnByValue: true })).result.value;
    const heads = all.filter(x => /^h[12]:/.test(x)), r = all.filter(x => !/^h[12]:/.test(x));
    console.log(`${w}px ${page}: ${r.length ? r.length + ' hanging' : 'clean'}` + (heads.length ? `  (headlines: ${heads.map(x => x.slice(4)).join('; ')})` : '')); for (const x of r) console.log('    ' + x); bad += r.length;
  }
}
console.log(bad ? `TOTAL hanging: ${bad}` : 'ALL CLEAN');
ws.close(); chrome.kill(); process.exit(bad ? 1 : 0);
