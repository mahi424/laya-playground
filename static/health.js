// One poll loop per page: is a local model connected, and are its checkpoints ready?
// Keeps the top-bar status tag current, and tells the rest of the page through onHealth() and a
// `laya:health` event (detail: the health object, or false when there is no server).
export const health = { connected: false, ready: false, models: null };
const subs = [];
let polled = false;
export function onHealth(fn) { subs.push(fn); if (polled) fn(health); }

async function poll() {
  let s = null;
  try { const r = await fetch('api/health'); if (r.ok) s = await r.json(); } catch (e) { /* static site: no API */ }
  if (s && !s.models) s = null;
  Object.assign(health, { connected: !!s, models: s && s.models, ready: !!s && Object.values(s.models).every(v => v === 'ready') });
  polled = true;
  window.layaHealth = s || false;   // late listeners read this
  dispatchEvent(new CustomEvent('laya:health', { detail: s || false }));
  const tag = document.getElementById('status');
  if (tag) {
    tag.querySelector('.dot').className = 'dot' + (health.ready ? ' on' : health.connected ? ' loading' : '');
    tag.lastChild.textContent = health.ready ? 'live model connected' : health.connected ? 'loading checkpoints' : 'recorded preview';
  }
  subs.forEach(fn => fn(health));
  // On a real static host there is no API and never will be: probe once, then stay quiet.
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (health.connected || local) setTimeout(poll, health.ready ? 15000 : health.connected ? 1000 : 8000);
}
poll();
