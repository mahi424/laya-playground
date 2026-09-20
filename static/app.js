// Landing page: the pre-rendered comparison, the measured benchmark and the SKILL.md viewer.
// All three render from files, so the page works as a plain static site.
import { $, h } from './ui.js';
import { resultCard } from './cards.js';

// ---------------------------------------------------------------- one email, five questions, three checkpoints
async function renderShowcase() {
  let data;
  try { data = await (await fetch('static/data/compare.json')).json(); } catch (e) { return; }
  const s = data.state;
  $('#showcaseInput').replaceChildren(
    h('div', {}, h('h3', {}, 'The email'),
      h('p', {}, h('b', {}, s.subject), h('br'), 'from ' + s.from, h('br'), s.body)),
    h('div', {}, h('h3', {}, 'The questions, asked together'),
      h('ul', {}, Object.entries(data.questions).map(([id, q]) => h('li', {}, h('code', {}, id), ' ' + q.instructions)))),
    h('div', {}, h('h3', {}, 'The run'),
      h('p', {}, `Real output, recorded ${data.recorded} on an ${data.machine}. Median of five runs, laya ${data.laya}. Each card below is one checkpoint answering all five questions in a single pass.`)));
  $('#showcase').replaceChildren(...data.results.map(r => resultCard(r)));
}

// ---------------------------------------------------------------- Laya vs Jev: rendered from the benchmark's own output file, never typed by hand
async function renderVersus() {
  let d;
  try { const r = await fetch('static/data/versus.json'); if (!r.ok) throw 0; d = await r.json(); } catch (e) { return; }
  const pc = v => (v * 100).toFixed(1) + '%', ms = v => v.toFixed(0) + ' ms';
  const cell = (text, better, us) => h('td', { class: (us ? 'us ' : '') + (better ? 'win' : '') }, text);
  const row = (name, l, j, starred) => h('tr', {},
    h('th', {}, name, starred && h('span', { class: 'us', title: 'Part of Laya’s training data, so not zero-shot for Laya.' }, ' *')),
    cell(pc(l.accuracy), l.accuracy > j.accuracy, true), cell(pc(j.accuracy), j.accuracy > l.accuracy),
    cell(l.ece.toFixed(3), l.ece < j.ece, true), cell(j.ece.toFixed(3), j.ece < l.ece),
    cell(ms(l.p50_ms), l.p50_ms < j.p50_ms, true), cell(ms(j.p50_ms), j.p50_ms < l.p50_ms));
  // Same tracks as the feature table under it (3 + 3 + 3 + 3 columns of the page grid), each metric split in two.
  $('#versusTable').replaceChildren(h('table', { class: 'tbl bench' },
    h('colgroup', {}, ['edge', 'mid-half', 'mid-half', 'mid-half', 'mid-half', 'edge-half', 'edge-half'].map(c => h('col', { class: c }))),
    h('thead', {},
      h('tr', {}, h('th', {}, 'Task'), h('th', { colSpan: 2 }, 'Accuracy'), h('th', { colSpan: 2 }, 'Calibration error'), h('th', { colSpan: 2 }, 'Median latency')),
      h('tr', {}, h('th'), ...['Laya', 'Jev', 'Laya', 'Jev', 'Laya', 'Jev'].map(n => h('th', { class: n === 'Laya' ? 'us' : '' }, n)))),
    h('tbody', {},
      d.tasks.map(t => row(`${t.title} · ${t.type}`, t.laya, t.jev, t.in_laya_training_data === true)),
      h('tr', {}, ...row(`All ${d.examples} examples`, d.overall.laya, d.overall.jev).children))));
  $('#vsSpeed').textContent = (d.overall.jev.p50_ms / d.overall.laya.p50_ms).toFixed(0) + '×';
  const starred = d.tasks.some(t => t.in_laya_training_data === true);
  $('#versusNote').textContent = `Measured ${d.recorded}, 100 labelled examples per task. Laya ${d.laya.version}, ${d.laya.checkpoint} checkpoint, ${d.laya.where}; its latency is the ${d.laya.latency}. ` +
    `Jev (${d.jev.model}) through its ${d.jev.where}; its latency is the ${d.jev.latency}, of which about ${d.jev.network_round_trip_ms} ms is one network round trip. ` +
    `Calibration error is ECE, lower is better. Bold is the better value.` + (starred ? ' * This dataset is in Laya’s training mix, so that row is not zero-shot for Laya.' : '') +
    ` The whole Jev run cost $${d.jev.cost_usd}. Reproduce it with\u00a0eval/run_eval.py.`;   // bound: never a lone last word
}

// ---------------------------------------------------------------- SKILL.md, shown as it is
async function renderSkill() {
  let text;
  try { const r = await fetch('skills/laya-integration/SKILL.md'); if (!r.ok) throw 0; text = await r.text(); } catch (e) { return; }
  $('#skillDoc').textContent = text.replace(/\n$/, '');
}

renderShowcase();
renderVersus();
renderSkill();
