"""Record real model output for every editor preset, so the public (model-less) site can show it.

    python tools/record_presets.py        # needs `python server.py` running

For each preset this stores the result of RUN (with the preset's own checkpoint / language hint)
and of COMPARE ALL 3. Median-latency run of five, after a warm-up call.
"""
import datetime
import json
import os
import urllib.request

API = os.environ.get("LAYA_API", "http://127.0.0.1:8770")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "data", "presets.json")


def predict(body):
    req = urllib.request.Request(API + "/api/predict", json.dumps(body).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))


def median_run(body):
    predict(body)
    return sorted((predict(body) for _ in range(5)), key=lambda r: r["latency_ms"])[2]


presets = json.load(urllib.request.urlopen(API + "/api/presets"))
health = json.load(urllib.request.urlopen(API + "/api/health"))
for p in presets:
    base = {"state": p["state"], "questions": p["questions"]}
    p["run"] = median_run({**base, "model": p.get("model"), "lang": p.get("lang")})
    p["compare"] = [median_run({**base, "model": m}) for m in ("english", "multilingual", "typed-decisions")]
    print("%-40s run %6.1f ms on %s" % (p["name"], p["run"]["latency_ms"], p["run"]["routing"]["model"]))
json.dump({"recorded": datetime.date.today().isoformat(), "machine": "Apple M1 Max, GPU", "laya": health["version"], "presets": presets},
          open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))
print("saved %d presets, %d KB" % (len(presets), os.path.getsize(OUT) // 1024))
