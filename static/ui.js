// Small shared helpers: DOM builder, API call, probability bar.

export const $ = s => document.querySelector(s);

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

/** POST api/predict (relative, so the page also works under a path prefix). Every response is also broadcast so the hero's live block can show it. */
export async function predict(req) {
  const r = await fetch('api/predict', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || 'Request failed (' + r.status + ')');
  window.dispatchEvent(new CustomEvent('laya:response', { detail: body }));
  return body;
}

export const pct = p => (p * 100).toFixed(p >= 0.9995 || p < 0.0005 ? 0 : 1) + '%';

/** One probability row: label, solid fill over a dithered track, value. `tick` marks 0.5. */
export function bar(label, p, top, tick) {
  return h('div', { class: 'bar' + (top ? ' top' : ''), title: label + '  p = ' + p.toFixed(4) },
    h('span', { class: 'lbl' }, label),
    h('span', { class: 'track' }, h('span', { class: 'fill', style: 'width:' + (p * 100).toFixed(2) + '%' }), tick && h('span', { class: 'tick' })),
    h('span', { class: 'val' }, pct(p)));
}
