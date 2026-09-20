#!/usr/bin/env python3
"""Build a small labelled evaluation set for comparing two text-decision models.

Standard library only. Rerunnable: raw API pages are cached under eval/cache/,
so a second run does not touch the network and reproduces byte-identical output.

Outputs (all inside the directory this script lives in):
  data/<task_id>.jsonl   100 examples per task: {"id", "text", "label"}
  tasks.json             task definitions (question, criteria, source, overlap finding)
  provenance.json        for every example: source split + row_idx in the HF dataset

Data comes from the Hugging Face datasets-server JSON API
(https://datasets-server.huggingface.co/rows), paged 100 rows at a time.

Usage:
  python build_dataset.py
"""

from __future__ import annotations

import json
import math
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE_DIR = HERE / "cache"
DATA_DIR = HERE / "data"

API = "https://datasets-server.huggingface.co/rows"
PAGE = 100            # API maximum rows per request
SEED = 7              # random.Random(7), a fresh instance per task
N_PER_TASK = 100
MAX_CHARS = 1200      # drop texts longer than this
SLEEP_S = 0.3         # politeness delay between network requests (raised automatically after a 429)
MAX_RETRIES = 9       # backoff 5, 10, 20, 40, 80, 120, 120 ... seconds
USER_AGENT = "openjev-eval-builder/1.0 (python-urllib; stdlib only)"

# --------------------------------------------------------------------------- #
# Laya training-data overlap findings.
# Checked by hand on 2026-09-20 against the three sources below. Quotes are
# verbatim; verify_evidence() re-downloads the sources (cached) and warns if a
# quote can no longer be found. These are the Laya authors' own statements and
# were not independently verified.
# --------------------------------------------------------------------------- #
LAYA_README = "https://github.com/NandhaKishorM/laya"
LAYA_README_RAW = "https://raw.githubusercontent.com/NandhaKishorM/laya/main/README.md"
LAYA_BENCH = "https://raw.githubusercontent.com/NandhaKishorM/laya/main/BENCHMARKS.md"
LAYA_CARD = "https://huggingface.co/convaiinnovations/laya"
LAYA_CARD_RAW = "https://huggingface.co/convaiinnovations/laya/raw/main/README.md"

EVIDENCE_SOURCES = {
    "laya_readme": LAYA_README_RAW,
    "laya_benchmarks": LAYA_BENCH,
    "laya_model_card": LAYA_CARD_RAW,
}

# (source key, verbatim quote) pairs that must still be present in the sources.
EVIDENCE_QUOTES = {
    "ag_news": [("laya_readme", "| AG News | **0.947** | 0.937 | in training mix |")],
    "emotion": [
        ("laya_readme", "| DAIR Emotion | **0.573** | 0.513 | held out |"),
        ("laya_benchmarks", "*held out* means the source was **not** in Laya's training mix."),
    ],
    "prompt_injection": [
        ("laya_readme", "| prompt-injections | **0.698** | 0.578 | held out, n=116 |"),
        ("laya_benchmarks", "(deepset prompt-injections measured 0.698 separately)"),
    ],
    "sms_spam": [("laya_benchmarks", "| Email spam | **0.993** | 0.993 | 0.958 | in training |")],
    "review_stars": [],
}
# Names that must NOT appear anywhere in the sources for the "not mentioned" findings.
EVIDENCE_ABSENT = {
    "sms_spam": ["sms"],
    "review_stars": ["yelp"],
}

# --------------------------------------------------------------------------- #
# Task definitions. Question wording was written once and is not tuned against
# any model.
# --------------------------------------------------------------------------- #
TASKS = [
    {
        "id": "ag_news",
        "title": "News topic",
        "question_id": "topic",
        "question": {
            "type": "choice",
            "instructions": "What is this news article about?",
            "criteria": {
                "world": "International affairs, politics, conflict or diplomacy.",
                "sports": "Sports events, teams, athletes or results.",
                "business": "Companies, markets, finance or the economy.",
                "sci_tech": "Science, technology, computing or the internet.",
            },
        },
        "label_field": "choice: the option key (world, sports, business, sci_tech)",
        "dataset": "fancyzhx/ag_news",
        "config": "default",
        "split": "test",
        "text_field": "text",
        "pool_pages": 15,
        "expected_label_names": ["World", "Sports", "Business", "Sci/Tech"],
        "label_map": {0: "world", 1: "sports", 2: "business", 3: "sci_tech"},
        "source": "AG News (fancyzhx/ag_news) https://huggingface.co/datasets/fancyzhx/ag_news",
        "license": "not stated (dataset card: license 'unknown'; the card describes the corpus as provided for research purposes and non-commercial activity)",
        "in_laya_training_data": True,
        "in_laya_training_evidence": (
            "\"| AG News | **0.947** | 0.937 | in training mix |\" "
            "(table 'English tasks', columns: task | laya | laya-multilingual | note) "
            + LAYA_README + " (raw: " + LAYA_README_RAW + "). "
            "The sources do not say which AG News split was in the training mix. "
            "AG News is also reported as a benchmark in " + LAYA_BENCH + " and " + LAYA_CARD + "."
        ),
    },
    {
        "id": "sms_spam",
        "title": "SMS spam",
        "question_id": "is_spam",
        "question": {
            "type": "noul",
            "instructions": "Is this SMS message spam?",
        },
        "label_field": "noul: true = spam, false = not spam (ham)",
        "dataset": "ucirvine/sms_spam",
        "config": "plain_text",
        "split": "train",  # the dataset has a single split, named 'train'
        "split_note": "train (the dataset's only split)",
        "text_field": "sms",
        "pool_pages": 20,
        "expected_label_names": ["ham", "spam"],
        "label_map": {0: False, 1: True},
        "source": "SMS Spam Collection (ucirvine/sms_spam) https://huggingface.co/datasets/ucirvine/sms_spam",
        "license": "not stated (dataset card: license 'unknown')",
        "in_laya_training_data": "unknown",
        "in_laya_training_evidence": (
            "not mentioned - none of the three sources names the SMS Spam Collection / ucirvine/sms_spam "
            "or SMS data at all. Nearest related statement concerns an unnamed EMAIL spam source, not SMS: "
            "\"| Email spam | **0.993** | 0.993 | 0.958 | in training |\" " + LAYA_BENCH
        ),
    },
    {
        "id": "emotion",
        "title": "Emotion",
        "question_id": "emotion",
        "question": {
            "type": "choice",
            "instructions": "Which emotion does the writer of this message express?",
            "criteria": {
                "sadness": "Feeling sad, down, hurt or hopeless.",
                "joy": "Feeling happy, pleased, content or excited.",
                "love": "Feeling affection, caring, tenderness or longing for someone.",
                "anger": "Feeling angry, irritated, resentful or frustrated.",
                "fear": "Feeling afraid, anxious, nervous or worried.",
                "surprise": "Feeling surprised, amazed, curious or caught off guard.",
            },
        },
        "label_field": "choice: the option key (sadness, joy, love, anger, fear, surprise)",
        "dataset": "dair-ai/emotion",
        "config": "split",
        "split": "test",
        "text_field": "text",
        "pool_pages": 20,  # the whole 2,000-row test split
        "expected_label_names": ["sadness", "joy", "love", "anger", "fear", "surprise"],
        "label_map": {0: "sadness", 1: "joy", 2: "love", 3: "anger", 4: "fear", 5: "surprise"},
        "source": "DAIR.AI Emotion (dair-ai/emotion, config 'split') https://huggingface.co/datasets/dair-ai/emotion",
        "license": "other - dataset card: \"The dataset should be used for educational and research purposes only.\"",
        "in_laya_training_data": False,
        "in_laya_training_evidence": (
            "\"| DAIR Emotion | **0.573** | 0.513 | held out |\" "
            "(table 'English tasks', columns: task | laya | laya-multilingual | note) "
            + LAYA_README + " (raw: " + LAYA_README_RAW + "); "
            "definition: \"*held out* means the source was **not** in Laya's training mix.\" " + LAYA_BENCH + ". "
            "Used by Laya's authors as a held-out benchmark (also reported in " + LAYA_CARD + ")."
        ),
    },
    {
        "id": "review_stars",
        "title": "Review star rating",
        "question_id": "stars",
        "question": {
            "type": "score",
            "instructions": "How many stars did the reviewer give in this review?",
            "criteria": [
                "1 star: very negative, a bad experience.",
                "2 stars: mostly negative, with few redeeming points.",
                "3 stars: mixed or average.",
                "4 stars: mostly positive, with minor complaints.",
                "5 stars: very positive, an excellent experience.",
            ],
        },
        "label_field": "score: integer level index starting at 0 (0 = 1 star ... 4 = 5 stars)",
        "dataset": "Yelp/yelp_review_full",
        "config": "yelp_review_full",
        "split": "test",
        "text_field": "text",
        "pool_pages": 20,
        "expected_label_names": ["1 star", "2 star", "3 stars", "4 stars", "5 stars"],
        "label_map": {0: 0, 1: 1, 2: 2, 3: 3, 4: 4},
        "source": "Yelp Review Full (Yelp/yelp_review_full) https://huggingface.co/datasets/Yelp/yelp_review_full",
        "license": "other - Yelp Dataset Agreement (dataset card: license_details 'yelp-licence')",
        "in_laya_training_data": "unknown",
        "in_laya_training_evidence": "not mentioned",
    },
    {
        "id": "prompt_injection",
        "title": "Prompt injection",
        "question_id": "is_injection",
        "question": {
            "type": "noul",
            "instructions": "Is this prompt an injection or jailbreak attempt?",
        },
        "label_field": "noul: true = injection / jailbreak attempt, false = legitimate prompt",
        "dataset": "deepset/prompt-injections",
        "config": "default",
        "split": "test",
        # The test split has only 116 rows, part of them German. If the English,
        # deduplicated test rows cannot fill 100, top up from these splits (in order).
        "topup_splits": ["train"],
        "text_field": "text",
        "pool_pages": 99,  # small dataset: take every page
        "expected_label_names": None,  # plain int64 column: 1 = injection, 0 = legitimate
        "label_map": {0: False, 1: True},
        "english_only": True,
        "source": "deepset prompt-injections (deepset/prompt-injections) https://huggingface.co/datasets/deepset/prompt-injections",
        "license": "apache-2.0",
        "in_laya_training_data": False,
        "in_laya_training_evidence": (
            "\"| prompt-injections | **0.698** | 0.578 | held out, n=116 |\" "
            "(table 'English tasks', columns: task | laya | laya-multilingual | note) "
            + LAYA_README + " (raw: " + LAYA_README_RAW + "); "
            "\"(deepset prompt-injections measured 0.698 separately)\" and "
            "\"*held out* means the source was **not** in Laya's training mix.\" " + LAYA_BENCH + ". "
            "n=116 equals the size of this dataset's test split, i.e. Laya's authors used it as a held-out benchmark."
        ),
    },
]


# --------------------------------------------------------------------------- #
# HTTP with cache, politeness delay and backoff
# --------------------------------------------------------------------------- #
_pace = {"last": 0.0, "gap": SLEEP_S}


def http_get(url: str) -> bytes:
    """GET with a politeness gap between requests and exponential backoff on 429/5xx."""
    for attempt in range(MAX_RETRIES):
        wait = _pace["gap"] - (time.time() - _pace["last"])
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
        try:
            _pace["last"] = time.time()
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code == 429 or 500 <= e.code < 600:
                if e.code == 429:
                    _pace["gap"] = min(2.0, _pace["gap"] * 2)  # we were too fast: slow down for good
                delay = float(e.headers.get("Retry-After") or 0) or min(120.0, 5.0 * 2.0 ** attempt)
                print(f"    HTTP {e.code}; retry {attempt + 1}/{MAX_RETRIES} in {delay:.0f}s", file=sys.stderr)
                time.sleep(delay)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            delay = min(120.0, 5.0 * 2.0 ** attempt)
            print(f"    network error ({e}); retry {attempt + 1}/{MAX_RETRIES} in {delay:.0f}s", file=sys.stderr)
            time.sleep(delay)
    raise RuntimeError(f"giving up after {MAX_RETRIES} attempts: {url}")


def fetch_page(task_id: str, dataset: str, config: str, split: str, offset: int, length: int) -> dict:
    """One page of rows, from cache if present."""
    cache = CACHE_DIR / task_id / f"{config}__{split}__offset_{offset:06d}__len_{length}.json"
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    qs = urllib.parse.urlencode(
        {"dataset": dataset, "config": config, "split": split, "offset": offset, "length": length}
    )
    raw = http_get(f"{API}?{qs}")
    page = json.loads(raw)
    if "rows" not in page:
        raise RuntimeError(f"unexpected API response for {dataset}/{config}/{split}@{offset}: {raw[:300]!r}")
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(page, ensure_ascii=False), encoding="utf-8")
    return page


def fetch_pool(task: dict, split: str) -> list[dict]:
    """Rows from `pool_pages` pages spread evenly over the whole split (not just the start)."""
    first = fetch_page(task["id"], task["dataset"], task["config"], split, 0, PAGE)
    total = first["num_rows_total"]

    names = None
    for feat in first["features"]:
        if feat["name"] == "label":
            names = feat["type"].get("names")
    if task["expected_label_names"] is not None and names != task["expected_label_names"]:
        raise RuntimeError(f"{task['id']}: label names changed upstream: {names}")

    total_pages = math.ceil(total / PAGE)
    n_pages = min(task["pool_pages"], total_pages)
    if n_pages == 1:
        page_idx = [0]
    else:
        page_idx = sorted({round(i * (total_pages - 1) / (n_pages - 1)) for i in range(n_pages)})

    rows = []
    for p in page_idx:
        offset = p * PAGE
        length = PAGE  # always request a full page; the API truncates at the end of the split
        page = first if offset == 0 else fetch_page(task["id"], task["dataset"], task["config"], split, offset, length)
        for r in page["rows"]:
            if r.get("truncated_cells"):
                continue  # never use a cell the API has truncated
            rows.append({"split": split, "row_idx": r["row_idx"], "row": r["row"]})
    print(f"  {split}: {total} rows in split, fetched {len(page_idx)} pages -> {len(rows)} rows")
    return rows


# --------------------------------------------------------------------------- #
# Cleaning, language filter, balanced sampling
# --------------------------------------------------------------------------- #
_WORD = re.compile(r"[a-zäöüß']+")
# Unambiguous German function/common words. English homographs are deliberately left out
# (die, war, was, man, hat, bin, am, im, um, so, also, mit [MIT], dir, gut, sage, nun, ...):
# real German text always trips several of the remaining signals anyway.
_DE = set(
    "der das und ist sind waren nicht ich du sie wir ihr mein dein ein eine einen einem einer eines "
    "zu dem von auf für aus bei nach über unter vor wie wer warum wann wieso welche welcher welches "
    "wieviel wieviele sich es auch wird werden kann kannst können soll sollte muss oder aber wenn dann "
    "dass weil als noch nur schon sehr mehr haben habe hast bist bitte vergiss alles jetzt gib sagen "
    "schreibe schreib antworte beantworte folgende folgenden vorherigen anweisungen aufgabe aufgaben "
    "frage fragen ja nein zum zur vom beim keine kein keinen mir mich dich uns euch ihnen ihre ihren "
    "seine seiner deutschland europa heute immer viel viele geld gibt wurde wurden hatte gegen "
    "ohne zwischen durch diese dieser dieses diesem einfach neue neuen ganz doch mal bisher "
    "ukraine-krieg russland türkei plastik ethik".split()
)
# German-only word shapes: -keit, -schaft, -iert, -ieren, -lich(e/en/er/es), -ung(en) on long words.
_DE_SHAPE = re.compile(r"^(?:\w{3,}(?:keit|schaft|iert|ieren|lich|liche|lichen|licher|liches|heit)|\w{5,}(?:ung|ungen))$")
# A few unambiguous Spanish words (the dataset contains a handful of Spanish injections).
_ES = set("que digo dices dije olvide pero porque usted ahora todos muerto".split())
_NON_EN_CHARS = re.compile(r"[äöüßáéíóúñàèùâêîôûçœ¿¡]")
# German words that are also English words: only count them when the text has no English
# function word at all ("Was hat Helmut Schmidt geraucht?").
_DE_HOMOGRAPHS = set("was hat die war man mit am im um so also den des in bin gut nun dir".split())
_EN_FUNCTION = set(
    "the of and is are you your to what how why who when where which do does did i my me we it that this "
    "for with on as at by be have has not can will would should a an or if from about".split()
)

# Hand review of deepset/prompt-injections (all 116 test rows and all 546 train rows were read
# on 2026-09-20). These are the rows where the heuristic below is wrong; True = English.
# Language only - no row was included or excluded because of its label or difficulty.
LANG_OVERRIDES = {
    ("deepset/prompt-injections", "train", 226): False,  # 'Wohnungsmarkt Berlin Mieten' (German keywords)
    ("deepset/prompt-injections", "train", 406): False,  # Croatian/Serbian
    ("deepset/prompt-injections", "train", 453): False,  # Croatian/Serbian
    ("deepset/prompt-injections", "train", 433): False,  # 'ukraina' (single non-English word)
    ("deepset/prompt-injections", "train", 103): True,   # English; "Der Spiegel" is a proper name
    ("deepset/prompt-injections", "train", 173): True,   # English; "Bernd Höcke" is a proper name
}


def looks_english(text: str) -> bool:
    """Crude stdlib language check for this English/German(/Spanish) dataset.

    Conservative by design: a row is kept only if it shows NO German or Spanish signal
    (function words, German-only word endings, non-English letters). Rows that mix a
    German part with an English part are therefore dropped as "not clearly English".
    The outcome on deepset/prompt-injections was reviewed by hand (see LANG_OVERRIDES).
    """
    low = text.lower()
    if _NON_EN_CHARS.search(low):
        return False
    if any(ch.isalpha() and ord(ch) > 0x024F for ch in text):
        return False  # non-Latin script (Cyrillic, Khmer, ...)
    words = _WORD.findall(low)
    if not words:
        return False
    if any(w in _DE or w in _ES or _DE_SHAPE.match(w) for w in words):
        return False
    if sum(w in _DE_HOMOGRAPHS for w in words) >= 2 and not any(w in _EN_FUNCTION for w in words):
        return False
    return True


def dedup_key(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().casefold()


def clean_pool(task: dict, rows: list[dict], seen: dict, stats: Counter) -> list[dict]:
    """Apply filters; `seen` maps dedup key -> kept item and is shared across splits."""
    out = []
    for r in rows:
        text = r["row"].get(task["text_field"])
        raw_label = r["row"].get("label")
        stats["rows_fetched"] += 1
        if not isinstance(text, str) or not text.strip():
            stats["dropped_empty"] += 1
            continue
        text = text.strip()
        if len(text) > MAX_CHARS:
            stats["dropped_too_long"] += 1
            continue
        if raw_label not in task["label_map"]:
            stats["dropped_bad_label"] += 1
            continue
        if task.get("english_only"):
            is_en = LANG_OVERRIDES.get((task["dataset"], r["split"], r["row_idx"]))
            if is_en is None:
                is_en = looks_english(text)
            if not is_en:
                stats["dropped_not_english"] += 1
                continue
        key = dedup_key(text)
        label = task["label_map"][raw_label]
        if key in seen:
            stats["dropped_duplicate"] += 1
            if seen[key]["label"] != label:
                seen[key]["conflict"] = True  # same text, different labels: unusable
            continue
        item = {"text": text, "label": label, "split": r["split"], "row_idx": r["row_idx"], "conflict": False}
        seen[key] = item
        out.append(item)
    return out


def balanced_picks(avail: dict, have: dict, n_new: int, order: list, rng: random.Random) -> dict:
    """How many NEW examples to draw per class so the final set is as even as availability allows.

    Greedy water-filling: hand out one slot at a time to the class that currently has the
    fewest examples (already chosen + newly assigned) and still has unused rows. Ties are
    broken with the seeded rng, so e.g. 100 over 6 classes gives 17/17/17/17/16/16 with the
    four larger classes picked at random but reproducibly.
    """
    picks = {c: 0 for c in order}
    for _ in range(n_new):
        cands = [c for c in order if picks[c] < avail.get(c, 0)]
        if not cands:
            break
        lowest = min(have.get(c, 0) + picks[c] for c in cands)
        tied = [c for c in cands if have.get(c, 0) + picks[c] == lowest]
        picks[rng.choice(tied)] += 1
    return picks


def build_task(task: dict) -> dict:
    print(f"[{task['id']}] {task['dataset']} config={task['config']} split={task['split']}")
    rng = random.Random(SEED)
    order = list(dict.fromkeys(task["label_map"].values()))
    stats: Counter = Counter()
    seen: dict = {}

    chosen: list[dict] = []
    splits_used = []
    for split in [task["split"]] + task.get("topup_splits", []):
        need = N_PER_TASK - len(chosen)
        if need <= 0:
            break
        pool = clean_pool(task, fetch_pool(task, split), seen, stats)
        pool = [it for it in pool if not it["conflict"]]
        by_label = defaultdict(list)
        for it in sorted(pool, key=lambda it: it["row_idx"]):
            by_label[it["label"]].append(it)
        # Balance the FINAL set: account for what earlier splits already contributed.
        have = Counter(it["label"] for it in chosen)
        picks = balanced_picks({c: len(by_label[c]) for c in order}, have, need, order, rng)
        picked = []
        for c in order:
            picked.extend(rng.sample(by_label[c], picks[c]))
        print(f"  {split}: usable pool {len(pool)} "
              f"({', '.join(f'{c}={len(by_label[c])}' for c in order)}); picked {len(picked)}")
        if picked:
            splits_used.append(split)
        chosen.extend(picked)

    if len(chosen) < N_PER_TASK:
        print(f"  WARNING: only {len(chosen)} usable examples available (wanted {N_PER_TASK})", file=sys.stderr)

    rng.shuffle(chosen)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out_path = DATA_DIR / f"{task['id']}.jsonl"
    with out_path.open("w", encoding="utf-8") as f:
        for i, it in enumerate(chosen):
            f.write(json.dumps({"id": i, "text": it["text"], "label": it["label"]}, ensure_ascii=False) + "\n")

    dist = Counter(it["label"] for it in chosen)
    per_split = Counter(it["split"] for it in chosen)
    avg_len = sum(len(it["text"]) for it in chosen) / max(1, len(chosen))
    print(f"  wrote {out_path.relative_to(HERE)}: n={len(chosen)}, avg chars={avg_len:.0f}, "
          f"labels={ {str(k): dist[k] for k in order} }, splits={dict(per_split)}")
    return {
        "n": len(chosen),
        "splits_used": splits_used,
        "per_split": dict(per_split),
        "label_distribution": {json.dumps(k) if isinstance(k, bool) else str(k): dist[k] for k in order},
        "avg_chars": round(avg_len, 1),
        "filter_stats": dict(stats),
        "provenance": [{"id": i, "split": it["split"], "row_idx": it["row_idx"]} for i, it in enumerate(chosen)],
    }


# --------------------------------------------------------------------------- #
# Evidence check + tasks.json
# --------------------------------------------------------------------------- #
def verify_evidence() -> None:
    """Re-check that every quoted sentence is still verbatim in the Laya sources (cached)."""
    docs = {}
    for key, url in EVIDENCE_SOURCES.items():
        cache = CACHE_DIR / "laya_sources" / f"{key}.md"
        if not cache.exists():
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_bytes(http_get(url))
        docs[key] = cache.read_text(encoding="utf-8", errors="replace")
    ok = True
    for task_id, quotes in EVIDENCE_QUOTES.items():
        for key, quote in quotes:
            if quote not in docs[key]:
                ok = False
                print(f"  WARNING [{task_id}]: quote no longer found in {key}: {quote!r}", file=sys.stderr)
    everything = "\n".join(docs.values()).lower()
    for task_id, needles in EVIDENCE_ABSENT.items():
        for needle in needles:
            if needle in everything:
                ok = False
                print(f"  WARNING [{task_id}]: '{needle}' now appears in the Laya sources; re-check by hand",
                      file=sys.stderr)
    print("[evidence] all quotes verified verbatim against cached Laya sources" if ok
          else "[evidence] MISMATCH - see warnings above")


def write_tasks_json(results: dict) -> None:
    out = []
    provenance = {}
    for task in TASKS:
        res = results.get(task["id"])
        if res is None:
            continue
        split_desc = task.get("split_note", task["split"])
        extra = [s for s in res["splits_used"] if s != task["split"]]
        if extra:
            split_desc = (f"{task['split']} ({res['per_split'].get(task['split'], 0)} examples) + "
                          + ", ".join(f"{s} ({res['per_split'][s]} examples, top-up)" for s in extra))
        entry = {
            "id": task["id"],
            "title": task["title"],
            "question_id": task["question_id"],
            "question": task["question"],
            "label_field": task["label_field"],
            "source": task["source"],
            "license": task["license"],
            "split": split_desc,
            "n": res["n"],
            "in_laya_training_data": task["in_laya_training_data"],
            "in_laya_training_evidence": task["in_laya_training_evidence"],
            # extras, for transparency
            "hf_dataset": task["dataset"],
            "hf_config": task["config"],
            "label_distribution": res["label_distribution"],
            "avg_chars": res["avg_chars"],
            "filter_stats": res["filter_stats"],
        }
        if extra:
            entry["ids_not_from_primary_split"] = sorted(
                p["id"] for p in res["provenance"] if p["split"] != task["split"]
            )
        out.append(entry)
        provenance[task["id"]] = res["provenance"]
    (HERE / "tasks.json").write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (HERE / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote tasks.json ({len(out)} tasks) and provenance.json")


def main() -> int:
    results = {task["id"]: build_task(task) for task in TASKS}
    verify_evidence()
    write_tasks_json(results)
    return 0


if __name__ == "__main__":
    sys.exit(main())
