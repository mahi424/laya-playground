"""Laya vs TypeSafe Jev on the same labelled examples with the same questions. Measurement only.

    python server.py                                  # Laya, local (in another terminal)
    TYPESAFE_API_KEY=... python eval/run_eval.py      # or TYPESAFE_API_KEY_FILE=/path/to/key

Both models receive the identical request body: the example text as `state` and one typed
question from eval/tasks.json. Nothing is tuned on these examples and Jev's outputs are never fed
back into Laya. Raw Jev responses are cached under eval/cache/ (git-ignored, so re-runs are not
re-billed and nothing of theirs is redistributed); only aggregate metrics are written out.
"""
import http.client
import json
import os
import socket
import ssl
import statistics
import sys
import time
import datetime
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LAYA_API = os.environ.get("LAYA_API", "http://127.0.0.1:8770")
LAYA_CHECKPOINT = os.environ.get("LAYA_CHECKPOINT", "english")
JEV_HOST, JEV_PATH, JEV_MODEL = "api.typesafe.ai", "/v1/systemone", os.environ.get("JEV_MODEL", "jev-latest")
JEV_PRICE_PER_MTOK = 0.042          # USD per million input tokens, from docs.typesafe.ai/models
CACHE = os.path.join(HERE, "cache", "jev")


def api_key():
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key and os.environ.get("TYPESAFE_API_KEY_FILE"):
        key = open(os.environ["TYPESAFE_API_KEY_FILE"]).read().strip()
    if not key:
        sys.exit("Set TYPESAFE_API_KEY or TYPESAFE_API_KEY_FILE.")
    return key


# ------------------------------------------------------------------ the two models
def laya(state, questions):
    body = json.dumps({"state": state, "questions": questions, "model": LAYA_CHECKPOINT}).encode()
    t0 = time.perf_counter()
    res = json.load(urllib.request.urlopen(urllib.request.Request(LAYA_API + "/api/predict", body, {"Content-Type": "application/json"})))
    return res["answers"], {"ms": res["latency_ms"], "round_trip_ms": (time.perf_counter() - t0) * 1000}


class Jev:
    """One keep-alive HTTPS connection, so timings are request time and not a TLS handshake per call."""

    def __init__(self, key):
        self.key, self.conn = key, None

    def _connect(self):
        self.conn = http.client.HTTPSConnection(JEV_HOST, timeout=30, context=ssl.create_default_context())
        self.conn.connect()

    def request(self, method, path, body=None):
        for attempt in range(6):
            try:
                if self.conn is None:
                    self._connect()
                t0 = time.perf_counter()
                self.conn.request(method, path, body, {"Authorization": "Bearer " + self.key, "Content-Type": "application/json"})
                r = self.conn.getresponse()
                data = r.read()
                ms = (time.perf_counter() - t0) * 1000
            except (OSError, http.client.HTTPException):
                self.conn = None
                time.sleep(1 + attempt)
                continue
            if r.status in (429, 500, 502, 503, 504, 529):
                time.sleep(float(r.getheader("Retry-After") or 0) or min(30, 2 ** attempt))
                continue
            return r.status, data, ms
        raise RuntimeError("Jev API kept failing; giving up")

    def decide(self, state, questions):
        status, data, ms = self.request("POST", JEV_PATH, json.dumps({"state": state, "model": JEV_MODEL, "questions": questions}))
        if status != 200:
            raise RuntimeError("Jev API %s: %s" % (status, data[:300].decode("utf-8", "replace")))
        res = json.loads(data)
        return res["answers"], {"ms": ms, "input_tokens": (res.get("usage") or {}).get("input_tokens"), "model": res.get("model")}


def network_floor(n=5):
    """Median TCP connect time to the API host: one network round trip from this machine."""
    ts = []
    for _ in range(n):
        t0 = time.perf_counter()
        socket.create_connection((JEV_HOST, 443), timeout=10).close()
        ts.append((time.perf_counter() - t0) * 1000)
    return statistics.median(ts)


# ------------------------------------------------------------------ scoring
def read_answer(a):
    """-> (predicted label, confidence in that prediction), comparable across both models."""
    if a["type"] == "noul":
        p = float(a["noul"])
        return p >= 0.5, max(p, 1 - p)
    probs = {k: float(v) for k, v in a["probabilities"].items()}
    top = max(probs, key=probs.get)
    return (int(top) if a["type"] == "score" else top), probs[top]


def ece(conf, correct, bins=10):
    if not conf:
        return None
    total, err = len(conf), 0.0
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        sel = [i for i, c in enumerate(conf) if (c > lo or b == 0) and c <= hi]
        if sel:
            err += len(sel) / total * abs(sum(conf[i] for i in sel) / len(sel) - sum(correct[i] for i in sel) / len(sel))
    return err


def summarise(rows, is_score):
    ms = sorted(r["ms"] for r in rows)
    out = {"n": len(rows), "accuracy": round(sum(r["correct"] for r in rows) / len(rows), 4),
           "ece": round(ece([r["conf"] for r in rows], [r["correct"] for r in rows]), 4),
           "p50_ms": round(ms[len(ms) // 2], 1), "p95_ms": round(ms[int(0.95 * (len(ms) - 1))], 1)}
    if is_score:
        out["within_one_level"] = round(sum(abs(r["pred"] - r["label"]) <= 1 for r in rows) / len(rows), 4)
    return out


# ------------------------------------------------------------------ run
def main():
    tasks = json.load(open(os.path.join(HERE, "tasks.json")))
    only = set(os.environ["TASKS"].split(",")) if os.environ.get("TASKS") else None
    limit = int(os.environ.get("LIMIT", "0"))
    jev = Jev(api_key())
    health = json.load(urllib.request.urlopen(LAYA_API + "/api/health"))
    floor = network_floor()
    print("network round trip to %s: %.0f ms" % (JEV_HOST, floor))

    report, tokens, jev_model = [], 0, None
    for task in tasks:
        if only and task["id"] not in only:
            continue
        rows = [json.loads(l) for l in open(os.path.join(HERE, "data", task["id"] + ".jsonl"))]
        rows = rows[:limit] if limit else rows
        questions = {task["question_id"]: task["question"]}
        os.makedirs(os.path.join(CACHE, task["id"]), exist_ok=True)
        laya(rows[0]["text"], questions)                     # warm-up: first call at a new shape compiles kernels
        got = {"laya": [], "jev": []}
        for i, ex in enumerate(rows):
            for name in ("laya", "jev"):
                path = os.path.join(CACHE, task["id"], "%s.json" % ex["id"])
                if name == "jev" and os.path.exists(path):
                    answers, meta = json.load(open(path))
                elif name == "jev":
                    if i == 0:
                        jev.decide(ex["text"], questions)     # warm-up: opens the connection
                    answers, meta = jev.decide(ex["text"], questions)
                    json.dump([answers, meta], open(path, "w"))
                else:
                    answers, meta = laya(ex["text"], questions)
                pred, conf = read_answer(answers[task["question_id"]])
                got[name].append({"pred": pred, "label": ex["label"], "correct": pred == ex["label"], "conf": conf, "ms": meta["ms"]})
                if name == "jev":
                    tokens += meta.get("input_tokens") or 0
                    jev_model = meta.get("model") or jev_model
            if (i + 1) % 25 == 0:
                print("  %-18s %3d/%d" % (task["id"], i + 1, len(rows)), flush=True)
        is_score = task["question"]["type"] == "score"
        entry = {k: task[k] for k in ("id", "title", "source", "in_laya_training_data")}
        entry.update(type=task["question"]["type"], options=len(task["question"].get("criteria") or [0, 1]),
                     laya=summarise(got["laya"], is_score), jev=summarise(got["jev"], is_score))
        report.append(entry)
        print("%-18s laya acc %.3f ece %.3f p50 %5.1f ms | jev acc %.3f ece %.3f p50 %5.1f ms" % (
            task["id"], entry["laya"]["accuracy"], entry["laya"]["ece"], entry["laya"]["p50_ms"],
            entry["jev"]["accuracy"], entry["jev"]["ece"], entry["jev"]["p50_ms"]), flush=True)

    n = sum(t["laya"]["n"] for t in report)
    mean = lambda who, key: round(sum(t[who][key] * t[who]["n"] for t in report) / n, 4)
    overall = {who: {"accuracy": mean(who, "accuracy"), "ece": mean(who, "ece"),
                     "p50_ms": round(statistics.median(t[who]["p50_ms"] for t in report), 1)} for who in ("laya", "jev")}
    out = {"recorded": datetime.date.today().isoformat(), "examples": n,
           "laya": {"version": health["version"], "checkpoint": LAYA_CHECKPOINT, "where": "local, Apple M1 Max GPU", "latency": "model forward pass"},
           "jev": {"model": jev_model or JEV_MODEL, "where": "hosted API", "latency": "full HTTPS request from this machine, connection kept alive",
                   "network_round_trip_ms": round(floor), "input_tokens": tokens, "cost_usd": round(tokens / 1e6 * JEV_PRICE_PER_MTOK, 5)},
           "overall": overall, "tasks": report}
    json.dump(out, open(os.path.join(ROOT, "static", "data", "versus.json"), "w"), indent=1)
    print("\noverall", json.dumps(overall))
    print("jev input tokens %d = $%.5f" % (tokens, out["jev"]["cost_usd"]))


if __name__ == "__main__":
    main()
