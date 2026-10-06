"""Run the llama.cpp vs vLLM benchmark matrix.

Runs inside the `client` container. Servers are driven through the `docker compose -p rtbench`
CLI over the mounted Docker socket; only one GPU server runs at a time.

Results layout (under --out, default results/<YYYY-MM-DD>):
  env.json
  <engine>/<config>/u<users>-r<repeat>.jsonl          one Record per line (all records, with flags)
  <engine>/<config>/u<users>-r<repeat>.summary.json   summarize() + server + config/engine/users/repeat/max_tokens
  (kvfull files are named u64-m<max_tokens>-r<repeat>.*, since one config has three levels at 64 users)
  reuse/<engine>-r<repeat>.json                       one sequential 20-turn run
  reuse/<engine>.json                                 aggregate over repeats
"""
import argparse
import asyncio
import dataclasses
import datetime
import json
import os
import re
import statistics
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
import loadgen  # noqa: E402
import metrics  # noqa: E402

HERE = Path(__file__).resolve().parent
PROJECT = "rtbench"
COMPOSE_FILE = "/bench/docker-compose.yml"
MODEL = "llama-3.1-8b"
ENGINES = ("llama", "vllm")
URLS = {"llama": "http://llama:8080", "vllm": "http://vllm:8000"}
DEFAULT_LEVELS = [1, 2, 4, 8, 16, 32, 64]
KVFULL_MAX_TOKENS = [256, 512, 1024]
KVFULL_USERS = 64
HEALTH_TIMEOUT_S = 900

LLAMA_COMMIT = "2ca15f5404760548c39e7b92bd43116a09414a1a"
VLLM_COMMIT = "138810056093301f4881050fcf2b1786939da387"
IMAGES = {
    "llama": "rtbench/llama:2ca15f5",
    "llama-tools": "rtbench/llama-tools:2ca15f5",
    "vllm": "public.ecr.aws/q9t5s3a7/vllm-ci-postmerge-repo:" + VLLM_COMMIT,
    "client": "rtbench/client:latest",
}

# Exact flags. BASE mirrors the `command:` in docker-compose.yml; EXTRA is appended through
# LLAMA_ARGS / VLLM_ARGS (later flags override earlier ones).
BASE_ARGS = {
    "llama": "-m /models/Llama-3.1-8B-Instruct-F16.gguf -ngl 999 -c 32768 -np 64 "
             "--alias llama-3.1-8b --metrics --host 0.0.0.0 --port 8080",
    "vllm": "--model /models/hf/Llama-3.1-8B-Instruct --served-model-name llama-3.1-8b "
            "--dtype bfloat16 --num-gpu-blocks-override 2048 --max-model-len 512 --port 8000",
}
EXTRA_ARGS = {
    "main": {"llama": "", "vllm": ""},
    "reuse": {"llama": "-np 8", "vllm": "--max-model-len 4096"},
    "kvfull": {"llama": "--kv-unified", "vllm": "--max-model-len 2048"},
}
CONFIGS = tuple(EXTRA_ARGS)

PRIVATE_PATH = re.compile(r"C:[/\\]+Users|/home/|/Users/", re.IGNORECASE)


@dataclass(frozen=True)
class Run:
    engine: str
    config: str
    repeat: int
    kind: str = "level"       # 'level' | 'reuse'
    users: int = 1
    max_tokens: int = 256
    group: tuple = ()         # runs with equal group share one fresh server start

    @property
    def stem(self) -> str:
        if self.config == "kvfull":
            return f"u{self.users}-m{self.max_tokens}-r{self.repeat}"
        return f"u{self.users}-r{self.repeat}"


def engine_order(repeat: int) -> tuple:
    return ENGINES if repeat % 2 == 0 else ENGINES[::-1]


def plan_runs(repeats=3, configs=CONFIGS, engines=ENGINES, levels=None) -> list:
    """Pure plan. Engine order alternates per repeat. main: fresh server per level;
    kvfull: one fresh server per engine/repeat for its three max_tokens levels; reuse: fresh server."""
    levels = list(levels or DEFAULT_LEVELS)
    runs = []
    for repeat in range(repeats):
        for config in configs:
            for engine in engine_order(repeat):
                if engine not in engines:
                    continue
                if config == "main":
                    for u in levels:
                        runs.append(Run(engine, config, repeat, "level", u, 256,
                                        (engine, config, repeat, u)))
                elif config == "kvfull":
                    for mt in KVFULL_MAX_TOKENS:
                        runs.append(Run(engine, config, repeat, "level", KVFULL_USERS, mt,
                                        (engine, config, repeat)))
                elif config == "reuse":
                    runs.append(Run(engine, config, repeat, "reuse", 1, 256, (engine, config, repeat)))
                else:
                    raise ValueError(f"unknown config {config}")
    return runs


def server_args(engine: str, config: str) -> str:
    return " ".join(x for x in (BASE_ARGS[engine], EXTRA_ARGS[config][engine]) if x)


# ---------------------------------------------------------------- docker helpers

def compose(*args, env_extra=None, check=True, timeout=1200) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env.update(env_extra or {})
    cmd = ["docker", "compose", "-p", PROJECT, "-f", COMPOSE_FILE, *args]
    r = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"docker compose {' '.join(args)} failed: {r.stderr.strip()[-500:]}")
    return r


def stop_servers():
    compose("stop", "llama", "vllm", check=False)


def start_server(engine: str, config: str):
    stop_servers()  # always stop both first
    var = "LLAMA_ARGS" if engine == "llama" else "VLLM_ARGS"
    compose("up", "-d", "--force-recreate", "--no-deps", engine,
            env_extra={var: EXTRA_ARGS[config][engine]})


def wait_healthy(engine: str, timeout_s=HEALTH_TIMEOUT_S):
    url = URLS[engine] + "/health"
    deadline = time.monotonic() + timeout_s
    n = 0
    while time.monotonic() < deadline:
        try:
            if httpx.get(url, timeout=5).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        n += 1
        if n % 10 == 0 and not compose("ps", "-q", "--status", "running", engine, check=False).stdout.strip():
            raise RuntimeError(f"{engine} container is not running")
        time.sleep(2)
    raise TimeoutError(f"{engine} not healthy after {timeout_s}s")


# ---------------------------------------------------------------- env.json

def sh(cmd, timeout=300) -> str:
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"{cmd[:3]} failed: {r.stderr.strip()[-300:]}")
    return r.stdout


def _csv_rows(text):
    lines = [ln.strip() for ln in text.strip().splitlines() if ln.strip()]
    header = [h.strip() for h in lines[0].split(",")]
    return [dict(zip(header, [v.strip() for v in ln.split(",")])) for ln in lines[1:]]


def assert_no_private_paths(text: str):
    m = PRIVATE_PATH.search(text)
    if m:
        raise ValueError(f"env.json would contain a private path near {text[max(0, m.start() - 20):m.end() + 20]!r}")


def harness_commit(run=sh):
    """git HEAD of the harness; inside the client container (no .git) falls back to $HARNESS_COMMIT."""
    try:
        c = run(["git", "-C", str(HERE.parent), "rev-parse", "HEAD"]).strip()
        if c:
            return c
    except Exception:  # noqa: BLE001
        pass
    return os.environ.get("HARNESS_COMMIT") or None


def collect_env(run=sh) -> dict:
    """`run(cmd_list) -> stdout`; injectable for tests."""
    nsmi = ["docker", "run", "--rm", "--gpus", "all", "--entrypoint", "nvidia-smi", IMAGES["llama"]]
    q = "name,driver_version,memory.total,power.limit,clocks.max.sm,clocks.max.memory,clocks.sm,clocks.mem"
    gpu = _csv_rows(run(nsmi + [f"--query-gpu={q}", "--format=csv"]))[0]
    m = re.search(r"CUDA (?:UMD )?Version:\s*([\d.]+)", run(nsmi))
    cuda = m.group(1) if m else None
    images = {}
    for key, ref in IMAGES.items():
        try:
            out = run(["docker", "image", "inspect", ref, "--format", "{{.Id}}|{{json .RepoDigests}}"]).strip()
            image_id, digests = out.split("|", 1)
            images[key] = {"ref": ref, "id": image_id, "repo_digests": json.loads(digests)}
        except Exception as e:  # noqa: BLE001
            images[key] = {"ref": ref, "error": type(e).__name__}
    harness = harness_commit(run)

    def g(*names):
        for n in names:
            for k, v in gpu.items():
                if k.startswith(n):
                    return v
        return None

    return {
        "date": datetime.date.today().isoformat(),
        "gpu": {
            "name": g("name"),
            "driver_version": g("driver_version"),
            "cuda_version": cuda,
            "memory_total": g("memory.total"),
            "power_limit": g("power.limit"),
            "clocks_max_sm": g("clocks.max.sm"),
            "clocks_max_mem": g("clocks.max.mem"),
            "clocks_sm": g("clocks.current.sm", "clocks.sm"),
            "clocks_mem": g("clocks.current.mem", "clocks.mem"),
        },
        "images": images,
        "commits": {"llama.cpp": LLAMA_COMMIT, "vllm": VLLM_COMMIT, "harness": harness},
        "model": MODEL,
        "server_args": {c: {e: server_args(e, c) for e in ENGINES} for c in CONFIGS},
        "load": {"template_date": loadgen.TEMPLATE_DATE},
    }


def write_env(out: Path, args=None, run=sh, require_harness=True):
    """env.json is created once per run folder; later invocations append to `invocations`."""
    path = out / "env.json"
    commit = harness_commit(run)
    if require_harness and not commit:
        raise RuntimeError("harness git commit unknown: pass -e HARNESS_COMMIT=<sha> "
                           "(or --allow-no-harness-commit for a dry run)")
    entry = {"time": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "harness_commit": commit, "args": list(args or [])}
    if path.exists():
        env = json.loads(path.read_text())
    else:
        env = collect_env(run)
        env["invocations"] = []
    env["invocations"].append(entry)
    text = json.dumps(env, indent=2)
    assert_no_private_paths(text)
    path.write_text(text + "\n")


# ---------------------------------------------------------------- execution

def load_prompts():
    return [json.loads(ln) for ln in (HERE / "prompts" / "main.jsonl").read_text().splitlines() if ln.strip()]


def write_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2) + "\n")


def write_records(path: Path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as f:
        for r in records:
            f.write(json.dumps(dataclasses.asdict(r)) + "\n")


def _utc_now_str():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


async def _scrape(url):
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(url + "/metrics")
        r.raise_for_status()
        return metrics.parse_prom(r.text)


def llama_server_summary(level, kv_retries):
    vals = [r.prompt_ms for r in level.records
            if r.in_window and not r.partial and r.ok and r.prompt_ms is not None]
    return {"prompt_ms_median": statistics.median(vals) if vals else None, "kv_retries": kv_retries}


async def run_one_level(run: Run, out: Path, prompts, warmup_s, measure_s):
    base = URLS[run.engine]
    state = {}

    async def on_window_start():
        state["since"] = _utc_now_str()
        if run.engine == "vllm":
            state["before"] = await _scrape(base)

    level = await loadgen.run_level(base, MODEL, prompts, run.users, warmup_s=warmup_s,
                                    measure_s=measure_s, max_tokens=run.max_tokens,
                                    on_window_start=on_window_start)
    d = out / run.engine / run.config
    write_records(d / f"{run.stem}.jsonl", level.records)  # raw data first, whatever happens next
    summary = loadgen.summarize(level)
    summary.update(config=run.config, engine=run.engine, users=run.users,
                   repeat=run.repeat, max_tokens=run.max_tokens)
    summary["server"] = {"error": "not collected"}
    write_json(d / f"{run.stem}.summary.json", summary)
    try:
        if level.callback_error:
            raise RuntimeError(f"window-start hook failed: {level.callback_error}")
        if run.engine == "vllm":
            if "before" not in state:
                raise RuntimeError("before-scrape did not complete")
            server = metrics.vllm_stage_means(state["before"], await _scrape(base))
        else:
            logs = compose("logs", "--no-color", "--since", state["since"], "llama", check=False).stdout
            server = llama_server_summary(level, metrics.count_kv_retries(logs))
    except Exception as e:  # noqa: BLE001
        server = {"error": f"{type(e).__name__}: {e}"}
    summary["server"] = server
    write_json(d / f"{run.stem}.summary.json", summary)
    return summary


async def run_reuse(run: Run, out: Path):
    data = json.loads((HERE / "prompts" / "reuse.json").read_text())
    base = URLS[run.engine]
    t0 = time.perf_counter()
    turns = []
    async with httpx.AsyncClient(timeout=None) as client:
        for i, text in enumerate(data["turns"], 1):
            messages = [{"role": "system", "content": data["system"]},
                        {"role": "user", "content": text}]
            rec = await loadgen.one_request(client, base, MODEL, messages, run.max_tokens, t0)
            turns.append({"turn": i, "ttft_ms": rec.ttft_ms, "prompt_tokens": rec.prompt_tokens,
                          "cache_n": rec.cache_n, "ok": rec.ok, "error": rec.error})
    warm = [t["ttft_ms"] for t in turns[1:] if t["ttft_ms"] is not None]
    res = {
        "engine": run.engine, "config": "reuse", "repeat": run.repeat, "max_tokens": run.max_tokens,
        "cold_ttft_ms": turns[0]["ttft_ms"],
        "warm_ttft_ms": statistics.median(warm) if warm else None,
        "valid": all(t["ok"] for t in turns),
        "turns": turns,
    }
    write_json(out / "reuse" / f"{run.engine}-r{run.repeat}.json", res)
    failed_path(run, out).unlink(missing_ok=True)  # stale failure from an earlier attempt
    aggregate_reuse(out, run.engine)
    return res


def aggregate_reuse(out: Path, engine: str):
    reps = [json.loads(p.read_text()) for p in sorted((out / "reuse").glob(f"{engine}-r*.json"))
            if re.fullmatch(rf"{engine}-r\d+\.json", p.name)]
    if not reps:
        return

    def med(xs):
        return statistics.median(xs) if xs else None

    turns = []
    for i in range(len(reps[0]["turns"])):
        col = [r["turns"][i] for r in reps if i < len(r["turns"])]
        turns.append({
            "turn": i + 1,
            "ttft_ms": med([t["ttft_ms"] for t in col if t["ttft_ms"] is not None]),
            "prompt_tokens": col[0]["prompt_tokens"],
            "cache_n": col[0]["cache_n"],
        })
    agg = {
        "engine": engine, "config": "reuse", "repeats": len(reps),
        "cold_ttft_ms": med([r["cold_ttft_ms"] for r in reps if r["cold_ttft_ms"] is not None]),
        "warm_ttft_ms": med([r["warm_ttft_ms"] for r in reps if r["warm_ttft_ms"] is not None]),
        "valid": all(r["valid"] for r in reps),
        "turns": turns,  # per-turn median across repeats; prompt_tokens/cache_n from the first repeat
        "per_repeat": [{k: r[k] for k in ("repeat", "cold_ttft_ms", "warm_ttft_ms", "valid")} for r in reps],
    }
    write_json(out / "reuse" / f"{engine}.json", agg)


def group_runs(runs):
    groups, index = [], {}
    for r in runs:
        if r.group not in index:
            index[r.group] = len(groups)
            groups.append([])
        groups[index[r.group]].append(r)
    return groups


def result_path(run: Run, out: Path) -> Path:
    if run.kind == "reuse":
        return out / "reuse" / f"{run.engine}-r{run.repeat}.json"
    return out / run.engine / run.config / f"{run.stem}.summary.json"


def failed_path(run: Run, out: Path) -> Path:
    p = result_path(run, out)
    return p.with_name(p.name.removesuffix(".summary.json").removesuffix(".json") + ".failed.json")


def done(run: Run, out: Path, retry_invalid=False) -> bool:
    p = result_path(run, out)
    if not p.exists():
        return False
    if retry_invalid:
        try:
            if not json.loads(p.read_text()).get("valid"):
                return False
        except ValueError:
            return False
    return True


def _log_tail(engine: str, n=50) -> str:
    try:
        return compose("logs", "--no-color", "--tail", str(n), engine, check=False).stdout[-8000:]
    except Exception as e:  # noqa: BLE001
        return f"(could not read logs: {type(e).__name__}: {e})"


def record_failure(run: Run, out: Path, exc: BaseException):
    msg = f"{type(exc).__name__}: {exc}"
    print(f"  FAILED {run.engine}/{run.config} u{run.users} m{run.max_tokens} r{run.repeat}: {msg}", flush=True)
    write_json(failed_path(run, out), {
        "engine": run.engine, "config": run.config, "users": run.users, "max_tokens": run.max_tokens,
        "repeat": run.repeat, "error_type": type(exc).__name__, "message": str(exc),
        "log_tail": _log_tail(run.engine).splitlines()[-50:],
    })


def probe(engine: str, prompts):
    """Untimed warm-up: 4 short requests with the pinned template date; results are discarded.
    Not used for the reuse config (turn 1 must be cold and the probe shares the template header).
    Raises if every probe request fails."""
    async def go():
        t0 = time.perf_counter()
        async with httpx.AsyncClient(timeout=120) as client:
            return [await loadgen.one_request(client, URLS[engine], MODEL, loadgen._messages(p), 16, t0)
                    for p in prompts[:4]]
    recs = asyncio.run(go())
    if recs and not any(r.ok for r in recs):
        raise RuntimeError(f"all probe requests failed: {recs[0].error}")


def execute_group(group, out: Path, prompts, warmup_s, measure_s) -> int:
    """Returns the number of failed runs. Never raises for server/level failures."""
    first = group[0]
    print(f"[start] {first.engine}/{first.config} r{first.repeat}", flush=True)
    failures = 0
    try:
        start_server(first.engine, first.config)
        wait_healthy(first.engine)
        if first.config != "reuse":  # reuse turn 1 must be cold; see probe()
            probe(first.engine, prompts)
    except Exception as e:  # noqa: BLE001
        for run in group:
            record_failure(run, out, e)
        stop_servers()
        return len(group)
    try:
        for run in group:
            try:
                if run.kind == "reuse":
                    res = asyncio.run(run_reuse(run, out))
                    print(f"  reuse cold={res['cold_ttft_ms']} warm={res['warm_ttft_ms']} valid={res['valid']}",
                          flush=True)
                else:
                    s = asyncio.run(run_one_level(run, out, prompts, warmup_s, measure_s))
                    ttft = (s["ttft_ms"] or {}).get("median")
                    print(f"  u{run.users} m{run.max_tokens} valid={s['valid']} n_ok={s['n_ok']} "
                          f"ttft_med={ttft} tok_s={s['tok_s']} server={s['server']}", flush=True)
                failed_path(run, out).unlink(missing_ok=True)
            except Exception as e:  # noqa: BLE001
                failures += 1
                record_failure(run, out, e)
    finally:
        stop_servers()
    return failures


# ---------------------------------------------------------------- prompt_tokens agreement

def prompt_token_agreement(out: Path, config="main", tol=1):
    """Compare per-prompt prompt_tokens across engines. Returns (rows, ok)."""
    seen = {e: {} for e in ENGINES}
    for e in ENGINES:
        for p in sorted((out / e / config).glob("*.jsonl")):
            for line in p.read_text().splitlines():
                r = json.loads(line)
                if r.get("prompt_id") is not None and r.get("prompt_tokens") is not None:
                    seen[e].setdefault(r["prompt_id"], set()).add(r["prompt_tokens"])
    rows, ok = [], True
    for pid in sorted(set(seen["llama"]) & set(seen["vllm"])):
        lv, vv = sorted(seen["llama"][pid]), sorted(seen["vllm"][pid])
        diff = max(abs(a - b) for a in lv for b in vv)
        rows.append({"prompt_id": pid, "llama": lv, "vllm": vv, "max_abs_diff": diff})
        ok &= diff <= tol
    return rows, ok


def print_agreement(rows, ok, tol=1, limit=15):
    print(f"prompt_tokens agreement: {len(rows)} shared prompt ids, tolerance +/-{tol}: "
          f"{'OK' if ok else 'MISMATCH'}")
    print("prompt_id  llama  vllm  |diff|")
    shown = sorted(rows, key=lambda r: -r["max_abs_diff"])[:limit]
    for r in sorted(shown, key=lambda r: r["prompt_id"]):
        print(f"{r['prompt_id']:>9}  {r['llama']}  {r['vllm']}  {r['max_abs_diff']}")
    hist = {}
    for r in rows:
        hist[r["max_abs_diff"]] = hist.get(r["max_abs_diff"], 0) + 1
    print("diff histogram:", dict(sorted(hist.items())))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--configs", default="main,reuse,kvfull")
    ap.add_argument("--engines", default="llama,vllm")
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--levels", default=",".join(map(str, DEFAULT_LEVELS)))
    ap.add_argument("--warmup", type=float, default=30)
    ap.add_argument("--measure", type=float, default=60)
    ap.add_argument("--out", default=None, help="default: results/<YYYY-MM-DD> next to this script")
    ap.add_argument("--check-tokens", action="store_true",
                    help="exit 2 if prompt_tokens differ by more than 1 between engines")
    ap.add_argument("--no-skip", action="store_true", help="re-run levels whose summary already exists")
    ap.add_argument("--retry-invalid", action="store_true",
                    help="on resume, also re-run levels whose summary is valid:false")
    ap.add_argument("--allow-no-harness-commit", action="store_true",
                    help="dry runs only: do not fail when the harness git commit is unknown")
    a = ap.parse_args(argv)
    configs = [c for c in a.configs.split(",") if c]
    engines = [e for e in a.engines.split(",") if e]
    for c in configs:
        if c not in CONFIGS:
            ap.error(f"unknown config {c}")
    out = Path(a.out) if a.out else HERE / "results" / datetime.date.today().isoformat()
    out.mkdir(parents=True, exist_ok=True)
    runs = plan_runs(a.repeats, configs, engines, [int(x) for x in a.levels.split(",")])
    prompts = load_prompts()
    failures = 0
    try:
        write_env(out, argv if argv is not None else sys.argv[1:],
                  require_harness=not a.allow_no_harness_commit)
        for group in group_runs(runs):
            todo = [r for r in group if a.no_skip or not done(r, out, a.retry_invalid)]
            if todo:
                failures += execute_group(todo, out, prompts, a.warmup, a.measure)
    finally:
        stop_servers()
    if set(engines) == set(ENGINES) and "main" in configs:
        rows, ok = prompt_token_agreement(out)
        write_json(out / "prompt_tokens_check.json", {"tolerance": 1, "ok": ok, "rows": rows})
        print_agreement(rows, ok)
        if a.check_tokens and not ok:
            return 2
    if failures:
        print(f"{failures} run(s) failed; see *.failed.json", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
