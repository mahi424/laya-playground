// The playground: write a state and typed questions, run them on the local model.
// With no model (the public site, or while checkpoints load) the presets answer from recordings
// made by tools/record_presets.py, and anything edited says it needs the real thing.
import { $, h, predict } from './ui.js';
import { resultCard } from './cards.js';
import { health, onHealth } from './health.js';

let questions = [], jsonMode = false, presets = [], presetsLive = null, recorded = '', busy = false;
const str = v => typeof v === 'string' ? v : JSON.stringify(v);

// ---------------------------------------------------------------- questions model <-> API shape
function fromApi(obj) {
  return Object.entries(obj).map(([id, d]) => {
    const q = { id, type: d.type, instructions: str(d.instructions ?? ''), options: [], levels: [], t: '', f: '' };
    const c = d.criteria;
    if (d.type === 'choice') q.options = Array.isArray(c) ? c.map(k => ({ key: str(k), desc: '' }))
                                        : Object.entries(c || {}).map(([k, v]) => ({ key: k, desc: v == null ? '' : str(v) }));
    else if (d.type === 'score') q.levels = (c || []).map(str);
    else if (c && !Array.isArray(c)) { q.t = c.true == null ? '' : str(c.true); q.f = c.false == null ? '' : str(c.false); }
    return normalise(q);
  });
}
function toApi() {
  const out = {};
  for (const q of questions) {
    const id = q.id.trim();
    if (!id) throw new Error('Every question needs an id.');
    if (id in out) throw new Error('Duplicate question id: ' + id);
    const d = { type: q.type, instructions: q.instructions.trim() };
    if (q.type === 'choice') {
      d.criteria = {};
      for (const o of q.options) if (o.key.trim()) d.criteria[o.key.trim()] = o.desc.trim();
    } else if (q.type === 'score') d.criteria = q.levels.map(l => l.trim()).filter(Boolean);
    else if (q.t.trim() || q.f.trim()) d.criteria = { true: q.t.trim(), false: q.f.trim() };
    out[id] = d;
  }
  return out;
}
function normalise(q) {
  if (q.type === 'choice') while (q.options.length < 2) q.options.push({ key: '', desc: '' });
  if (q.type === 'score') while (q.levels.length < 2) q.levels.push('');
  return q;
}

// ---------------------------------------------------------------- question editor
function questionCard(q, i) {
  const input = (val, ph, set, extra) => h('input', { type: 'text', value: val, placeholder: ph, oninput: e => set(e.target.value), ...extra });
  const x = (title, fn, disabled) => h('button', { class: 'ghost', title, 'aria-label': title, disabled, onclick: fn }, '✕');
  const body = [];
  if (q.type === 'choice') {
    body.push(h('div', { class: 'opts' },
      q.options.map((o, j) => h('div', { class: 'opt' },
        input(o.key, 'option', v => o.key = v),
        input(o.desc, 'what this option covers (optional)', v => o.desc = v),
        x('Remove option', () => { q.options.splice(j, 1); renderQuestions(); }, q.options.length <= 2))),
      h('div', {}, h('button', { class: 'ghost', onclick: () => { q.options.push({ key: '', desc: '' }); renderQuestions(); } }, '+ option'))));
  } else if (q.type === 'score') {
    body.push(h('div', { class: 'opts' },
      q.levels.map((l, j) => h('div', { class: 'opt lvl' },
        h('span', { class: 'dim' }, j),
        input(l, j === 0 ? 'lowest level' : 'next level up', v => q.levels[j] = v),
        x('Remove level', () => { q.levels.splice(j, 1); renderQuestions(); }, q.levels.length <= 2))),
      h('div', {}, h('button', { class: 'ghost', onclick: () => { q.levels.push(''); renderQuestions(); } }, '+ level'))));
  } else {
    body.push(h('details', { open: !!(q.t || q.f) }, h('summary', {}, 'optional: describe what true and false mean'),
      h('div', { class: 'opts' }, input(q.t, 'true means…', v => q.t = v), input(q.f, 'false means…', v => q.f = v))));
  }
  return h('div', { class: 'q' },
    h('div', { class: 'top' },
      input(q.id, 'question_id', v => q.id = v, { 'aria-label': 'Question id' }),
      h('select', { 'aria-label': 'Question type', onchange: e => { q.type = e.target.value; normalise(q); renderQuestions(); } },
        ['choice', 'score', 'noul'].map(t => h('option', { value: t, selected: q.type === t }, t))),
      x('Remove question', () => { questions.splice(i, 1); renderQuestions(); })),
    input(q.instructions, 'instruction, phrased as a question about the state', v => q.instructions = v, { 'aria-label': 'Instructions' }),
    body);
}
function renderQuestions() { $('#qlist').replaceChildren(...questions.map(questionCard)); }

function setMode(json) {
  if (json === jsonMode) return;
  try {
    if (json) $('#qjson').value = JSON.stringify(toApi(), null, 2);
    else { questions = fromApi(JSON.parse($('#qjson').value)); renderQuestions(); }
  } catch (e) { return showError('Cannot switch editor mode: ' + e.message); }
  jsonMode = json;
  $('#qjson').hidden = !json; $('#qlist').hidden = json; $('#addQ').hidden = json;
  $('#modeJson').classList.toggle('on', json); $('#modeForm').classList.toggle('on', !json);
}
const currentQuestions = () => jsonMode ? JSON.parse($('#qjson').value) : toApi();

function parseState() {
  const raw = $('#state').value.trim();
  if (/^[{\[]/.test(raw)) { try { return JSON.parse(raw); } catch (e) { /* treat as text */ } }
  return raw;
}

// ---------------------------------------------------------------- running
function show(cards, compare, note, quiet) {
  $('#pg').classList.toggle('compare', compare);
  $('#results').replaceChildren(...(note ? [h('p', { class: 'note' }, note)] : []), ...cards);
  if (!quiet && (compare || matchMedia('(max-width: 900px)').matches)) $('#results').scrollIntoView();
}
const showError = msg => show([], false, msg);

// Without a ready model only the recorded presets can be answered; anything edited needs the real thing.
function showRecorded(base, compare, quiet) {
  const p = presets[$('#preset').value], same = p && JSON.stringify(base) === JSON.stringify({ state: p.state, questions: p.questions });
  if (!same || !p.run) return showError(health.connected ? 'That text has not been recorded, and the model is still loading. Try again in a moment.'
    : 'That text has not been recorded, and there is no model behind this page. Run the repository locally to try your own text.');
  show(compare ? p.compare.map(r => resultCard(r)) : [resultCard(p.run, { ...base, model: p.model, lang: p.lang })], compare,
    `Recorded output for this preset (${recorded}). ` + (health.connected ? 'The model is still loading; it will answer your own text once it is ready.'
      : 'There is no model behind this page: to run your own text, run the repository locally.'), quiet);
}
// The page opens in a working state: with no model ready, a preset shows its recorded answer as soon as it is picked.
function autoShow() {
  const p = presets[$('#preset').value];
  if (!health.ready && p && p.run) showRecorded({ state: p.state, questions: p.questions }, false, true);
}

async function run(compare) {
  if (busy) return;
  let base;
  try { base = { state: parseState(), questions: currentQuestions() }; }
  catch (e) { return showError('Questions are not valid: ' + e.message); }
  if (!base.state) return showError('The state is empty. Paste some text to decide about.');
  if (!health.ready) return showRecorded(base, compare);
  const btn = $(compare ? '#compareBtn' : '#runBtn'), label = btn.textContent;
  busy = true; $('#runBtn').disabled = $('#compareBtn').disabled = true; btn.textContent = compare ? 'Comparing…' : 'Running…';
  try {
    const reqs = compare ? ['english', 'multilingual', 'typed-decisions'].map(model => ({ ...base, model }))
                         : [{ ...base, model: $('#model').value || null, lang: $('#lang').value.trim() || null }];
    const cards = [];
    for (const req of reqs) cards.push(resultCard(await predict(req), req));
    show(cards, compare);
  } catch (e) { showError(e.message); }
  busy = false; $('#runBtn').disabled = $('#compareBtn').disabled = false; btn.textContent = label;
}

// ---------------------------------------------------------------- presets and wiring
function applyPreset(p) {
  $('#state').value = typeof p.state === 'string' ? p.state : JSON.stringify(p.state, null, 2);
  questions = fromApi(p.questions);
  if (jsonMode) $('#qjson').value = JSON.stringify(p.questions, null, 2); else renderQuestions();
  $('#model').value = p.model || ''; $('#lang').value = p.lang || '';
}
async function loadPresets() {
  presetsLive = health.ready;
  try {
    if (health.ready) presets = await (await fetch('api/presets')).json();
    else { const d = await (await fetch('static/data/presets.json')).json(); presets = d.presets; recorded = `${d.machine}, ${d.recorded}`; }
  } catch (e) { return; }
  const first = !$('#preset').options.length, at = $('#preset').value || 0;
  $('#preset').replaceChildren(...presets.map((p, i) => h('option', { value: i }, p.name)));
  if (first) { applyPreset(presets[0]); autoShow(); } else $('#preset').value = at;   // never wipe what the visitor typed while the model loaded
}

onHealth(s => {
  const b = $('#pgBanner');
  b.textContent = s.ready ? 'Live. The model on this machine answers whatever you type.'
    : s.connected ? 'The model is loading. Until it is ready, the presets show recorded output.'
    : '';   // the public site: the note above the recorded answer already says there is no model behind the page
  b.classList.toggle('live', s.ready);
  if (s.ready !== presetsLive || !presets.length) loadPresets();
});
$('#preset').addEventListener('change', e => { applyPreset(presets[e.target.value]); autoShow(); });
$('#modeForm').addEventListener('click', () => setMode(false));
$('#modeJson').addEventListener('click', () => setMode(true));
$('#addQ').addEventListener('click', () => { questions.push(normalise({ id: 'question_' + (questions.length + 1), type: 'noul', instructions: '', options: [], levels: [], t: '', f: '' })); renderQuestions(); });
$('#runBtn').addEventListener('click', () => run(false));
$('#compareBtn').addEventListener('click', () => run(true));
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(false); } });
