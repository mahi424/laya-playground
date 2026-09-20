// Result cards: one model response rendered as typed answers with probability bars.
import { h, bar } from './ui.js';

function answerBlock(id, a) {
  let pick, rows;
  if (a.type === 'choice') {
    pick = a.choice;
    rows = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).map(([k, p]) => bar(k, p, k === a.choice));
  } else if (a.type === 'score') {
    pick = a.score.toFixed(2) + ' / ' + (Object.keys(a.legend).length - 1);
    const best = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0][0];
    rows = Object.entries(a.probabilities).map(([k, p]) => bar(k + ' · ' + a.legend[k], p, k === best));
  } else {
    pick = a.noul >= 0.5 ? 'yes' : 'no';
    rows = [bar('P(true)', a.noul, true, true)];
  }
  return h('div', { class: 'ans' },
    h('div', { class: 'ans-head' },
      h('span', { class: 'qid' }, id), h('span', { class: 'dim' }, a.type), h('b', {}, pick),
      h('span', { class: 'dim side', title: 'confidence = 1 − normalised entropy of the distribution' }, 'conf ' + a.confidence.toFixed(2))),
    rows);
}

const NON_EN = /[ąćęłńśźżčďěňřšťůžğışőűășțåøæđñßàâçéèêëîïôûùüöäíóúãõ]/i;

/** `req` is optional: with it, the card explains auto-routing and warns about the Latin-script gap. */
export function resultCard(res, req) {
  const r = res.routing, auto = req && !req.model && !req.lang;
  const text = req ? (typeof req.state === 'string' ? req.state : JSON.stringify(req.state)) : '';
  return h('div', { class: 'card' },
    h('div', { class: 'meta' },
      h('span', { class: 'tag on' }, r.model), h('span', { class: 'tag' }, res.latency_ms + ' ms'),
      h('span', { class: 'tag' }, res.usage.input_tokens + ' tokens in / 0 out')),
    auto && h('p', { class: 'dim' }, 'routing: ' + r.reason),
    auto && r.model === 'english' && NON_EN.test(text) && h('p', { class: 'note' },
      'This text has non-English characters but was auto-routed to the English checkpoint. Laya’s detector only recognises ' +
      'fr, de, es, pt, it and nl among Latin-script languages. Set a language hint (for example “pl”) to use the multilingual checkpoint.'),
    Object.entries(res.answers).map(([id, a]) => answerBlock(id, a)),
    h('details', {}, h('summary', {}, 'raw response'), h('pre', {}, JSON.stringify(res, null, 2))));
}
