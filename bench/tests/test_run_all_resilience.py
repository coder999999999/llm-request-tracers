import asyncio
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import loadgen  # noqa: E402
import run_all  # noqa: E402
from loadgen import LevelResult, Record  # noqa: E402
from test_run_all import _fake_run  # noqa: E402


def _rec(**kw):
    base = dict(user=0, start_s=1.0, ttft_ms=50.0, e2e_ms=100.0, out_tokens=4, ok=True,
                chunk_times=[1.1, 1.2], prompt_id=0, prompt_tokens=175, prompt_ms=10.0)
    base.update(kw)
    return Record(**base)


def test_write_env_raises_on_private_path_in_collected_value(tmp_path):
    leaky = "C:/" + "Users/someone/x"

    def run(cmd):
        return _fake_run(cmd).replace("NVIDIA GeForce RTX 4090", "GPU " + leaky)
    try:
        run_all.write_env(tmp_path, [], run=run)
    except ValueError:
        assert not (tmp_path / "env.json").exists()
        return
    raise AssertionError("write_env accepted a private path")


def test_env_written_once_then_invocations_appended(tmp_path):
    run_all.write_env(tmp_path, ["--a"], run=_fake_run)
    first = json.loads((tmp_path / "env.json").read_text())
    run_all.write_env(tmp_path, ["--b"], run=_fake_run)
    second = json.loads((tmp_path / "env.json").read_text())
    assert [i["args"] for i in second["invocations"]] == [["--a"], ["--b"]]
    assert second["gpu"] == first["gpu"] and second["invocations"][0]["harness_commit"] == "deadbeef"


def test_write_env_fails_without_harness_commit(tmp_path, monkeypatch):
    monkeypatch.delenv("HARNESS_COMMIT", raising=False)

    def run(cmd):
        if cmd[0] == "git":
            raise RuntimeError("no git")
        return _fake_run(cmd)
    try:
        run_all.write_env(tmp_path, [], run=run)
    except RuntimeError as e:
        assert "harness" in str(e)
    else:
        raise AssertionError("expected failure")
    run_all.write_env(tmp_path, [], run=run, require_harness=False)  # dry run allowed
    assert (tmp_path / "env.json").exists()


def test_llama_server_summary_filters_and_takes_median():
    recs = [_rec(prompt_ms=10.0), _rec(prompt_ms=30.0), _rec(prompt_ms=999.0, in_window=False),
            _rec(prompt_ms=999.0, ok=None, partial=True), _rec(prompt_ms=999.0, ok=False), _rec(prompt_ms=None)]
    s = run_all.llama_server_summary(LevelResult(recs, 0, 1, 1), 3)
    assert s == {"prompt_ms_median": 20.0, "kv_retries": 3}
    assert run_all.llama_server_summary(LevelResult([], 0, 1, 1), 0)["prompt_ms_median"] is None


def _write_jsonl(path, recs):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r.__dict__) + "\n" for r in recs))


def test_prompt_token_agreement(tmp_path):
    _write_jsonl(tmp_path / "llama/main/u1-r0.jsonl", [_rec(prompt_id=1, prompt_tokens=175),
                                                      _rec(prompt_id=2, prompt_tokens=174),
                                                      _rec(prompt_id=9, prompt_tokens=170)])
    _write_jsonl(tmp_path / "vllm/main/u1-r0.jsonl", [_rec(prompt_id=1, prompt_tokens=176),
                                                     _rec(prompt_id=2, prompt_tokens=176),
                                                     _rec(prompt_id=7, prompt_tokens=170)])
    rows, ok = run_all.prompt_token_agreement(tmp_path)
    assert [(r["prompt_id"], r["max_abs_diff"]) for r in rows] == [(1, 1), (2, 2)]  # only shared ids
    assert ok is False
    rows, ok = run_all.prompt_token_agreement(tmp_path, tol=2)
    assert ok is True


def test_aggregate_reuse_medians_across_repeats(tmp_path):
    def rep(k, cold, warm_ttfts):
        turns = [{"turn": 1, "ttft_ms": cold, "prompt_tokens": 1500, "cache_n": 0, "ok": True, "error": None}]
        turns += [{"turn": i + 2, "ttft_ms": t, "prompt_tokens": 1520, "cache_n": 1490, "ok": True, "error": None}
                  for i, t in enumerate(warm_ttfts)]
        run_all.write_json(tmp_path / "reuse" / f"llama-r{k}.json", {
            "repeat": k, "cold_ttft_ms": cold, "warm_ttft_ms": sorted(warm_ttfts)[len(warm_ttfts) // 2],
            "valid": True, "turns": turns})
    rep(0, 100.0, [10.0, 20.0, 30.0])
    rep(1, 300.0, [12.0, 22.0, 32.0])
    rep(2, 200.0, [11.0, 21.0, 31.0])
    run_all.aggregate_reuse(tmp_path, "llama")
    agg = json.loads((tmp_path / "reuse" / "llama.json").read_text())
    assert agg["repeats"] == 3 and agg["cold_ttft_ms"] == 200.0 and agg["warm_ttft_ms"] == 21.0
    assert agg["turns"][1]["ttft_ms"] == 11.0 and agg["turns"][0]["cache_n"] == 0 and agg["valid"]


def test_done_resume_and_retry_invalid(tmp_path):
    run = run_all.Run("llama", "main", 0, "level", 8)
    assert not run_all.done(run, tmp_path)
    p = run_all.result_path(run, tmp_path)
    run_all.write_json(p, {"valid": False})
    assert run_all.done(run, tmp_path) is True                       # resume skips by default
    assert run_all.done(run, tmp_path, retry_invalid=True) is False  # but not with --retry-invalid
    run_all.write_json(p, {"valid": True})
    assert run_all.done(run, tmp_path, retry_invalid=True) is True
    rr = run_all.Run("vllm", "reuse", 1, "reuse")
    run_all.write_json(run_all.result_path(rr, tmp_path), {"valid": False})
    assert run_all.done(rr, tmp_path) and not run_all.done(rr, tmp_path, retry_invalid=True)


def _stub_infra(monkeypatch, fail_engines=(), health_fail=()):
    started = []
    monkeypatch.setattr(run_all, "stop_servers", lambda: None)
    monkeypatch.setattr(run_all, "compose",
                        lambda *a, **k: subprocess.CompletedProcess(a, 0, stdout="line1\nline2\n", stderr=""))
    monkeypatch.setattr(run_all, "probe", lambda *a: None)

    def start(engine, config):
        started.append(engine)
        if engine in fail_engines:
            raise RuntimeError("compose up failed")
    monkeypatch.setattr(run_all, "start_server", start)

    def health(engine, *a):
        if engine in health_fail:
            raise TimeoutError("not healthy")
    monkeypatch.setattr(run_all, "wait_healthy", health)
    return started


def test_failed_start_writes_failed_json_and_run_continues(tmp_path, monkeypatch):
    started = _stub_infra(monkeypatch, fail_engines=("llama",))

    async def fake_level(run, out, prompts, w, m):
        run_all.write_json(run_all.result_path(run, out), {"valid": True, "ttft_ms": {"median": 1}, "n_ok": 1,
                                                          "tok_s": 1, "server": {}})
        return json.loads(run_all.result_path(run, out).read_text())
    monkeypatch.setattr(run_all, "run_one_level", fake_level)
    runs = run_all.plan_runs(repeats=1, configs=["main"], levels=[1, 8])
    failures = 0
    for g in run_all.group_runs(runs):
        failures += run_all.execute_group(g, tmp_path, [], 1, 1)
    assert started == ["llama", "llama", "vllm", "vllm"]  # kept going after llama failed
    assert failures == 2
    f = json.loads(run_all.failed_path(run_all.Run("llama", "main", 0, "level", 1), tmp_path).read_text())
    assert f["error_type"] == "RuntimeError" and "compose up failed" in f["message"]
    assert f["log_tail"] == ["line1", "line2"]
    assert run_all.result_path(run_all.Run("vllm", "main", 0, "level", 8), tmp_path).exists()


def test_unhealthy_server_and_level_exception_are_recorded(tmp_path, monkeypatch):
    _stub_infra(monkeypatch, health_fail=("vllm",))

    async def boom(*a):
        raise ConnectionError("engine died")
    monkeypatch.setattr(run_all, "run_one_level", boom)
    kv = run_all.plan_runs(repeats=1, configs=["kvfull"], engines=["llama"])
    assert run_all.execute_group(kv, tmp_path, [], 1, 1) == 3  # every level recorded, none aborted the rest
    assert all(run_all.failed_path(r, tmp_path).exists() for r in kv)
    vr = run_all.plan_runs(repeats=1, configs=["main"], engines=["vllm"], levels=[1])
    assert run_all.execute_group(vr, tmp_path, [], 1, 1) == 1
    assert "TimeoutError" in run_all.failed_path(vr[0], tmp_path).read_text()


def test_level_keeps_records_when_scrape_fails(tmp_path, monkeypatch):
    async def fake_run_level(base, model, prompts, users, warmup_s, measure_s, max_tokens, on_window_start):
        err = None
        try:  # mirrors the real run_level: hook errors are recorded, not raised
            await on_window_start()
        except Exception as e:
            err = f"{type(e).__name__}: {e}"
        return LevelResult([_rec()], warmup_s, measure_s, users, callback_error=err)

    async def bad_scrape(url):
        raise ConnectionError("vllm down")
    monkeypatch.setattr(loadgen, "run_level", fake_run_level)
    monkeypatch.setattr(run_all, "_scrape", bad_scrape)
    run = run_all.Run("vllm", "main", 0, "level", 1)
    s = asyncio.run(run_all.run_one_level(run, tmp_path, [], 0, 1))
    assert "ConnectionError" in s["server"]["error"]
    d = tmp_path / "vllm" / "main"
    assert (d / "u1-r0.jsonl").read_text().strip()
    assert json.loads((d / "u1-r0.summary.json").read_text())["server"]["error"]
