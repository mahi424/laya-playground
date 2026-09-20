// Shared by every page: model status, in-page anchors, repo links and copy buttons.
import './health.js';

// With a <base> tag, "./#id" links resolve against the base, which reloads the page when it is
// served at /laya (no trailing slash). Same-document anchors are therefore scrolled by hand.
const here = p => p.replace(/index\.html$/, '').replace(/\/$/, '');
addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target || a.hasAttribute('download')) return;
  const url = new URL(a.href, document.baseURI);
  if (url.origin !== location.origin || here(url.pathname) !== here(location.pathname)) return;
  const el = url.hash ? document.getElementById(decodeURIComponent(url.hash.slice(1))) : document.body;
  if (!el) return;
  e.preventDefault();
  el.scrollIntoView();
  history.replaceState(null, '', url.hash || location.pathname);
});

const repo = document.body.dataset.repo || '';
for (const a of document.querySelectorAll('[data-repo-link]')) a.href = repo;
for (const el of document.querySelectorAll('[data-repo-text]')) el.textContent = el.textContent.replace('{repo}', repo).replace('{dir}', repo.split('/').pop());
for (const b of document.querySelectorAll('[data-copy]')) b.addEventListener('click', async () => {
  const label = b.textContent;
  try { await navigator.clipboard.writeText(document.querySelector(b.dataset.copy).textContent); b.textContent = 'Copied'; } catch (e) { b.textContent = 'Select and copy'; }
  setTimeout(() => { b.textContent = label; }, 1600);
});
