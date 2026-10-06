import asyncio
import json
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import loadgen  # noqa: E402
from loadgen import LevelResult, Record, one_request, run_level, summarize  # noqa: E402


def chunk(content=None, role=None, usage=None, timings=None, finish=None):
    d = {}
    if role:
        d["role"] = role
    if content is not None:
        d["content"] = content
    c = {"choices": [{"delta": d, "finish_reason": finish}] if (d or finish) else []}
    if usage:
        c["usage"] = usage
    if timings:
        c["timings"] = timings
    return c


def sse_stream(events, delays, done=True, fail_after=None):
    """Async byte stream: events[i] is sent after delays[i] seconds."""
    class S(httpx.AsyncByteStream):
        async def __aiter__(self):
            for i, (ev, d) in enumerate(zip(events, delays)):
                await asyncio.sleep(d)
                if fail_after is not None and i == fail_after:
                    raise httpx.RemoteProtocolError("broken")
                yield f"data: {json.dumps(ev)}\n\n".encode()
            if done:
                yield b"data: [DONE]\n\n"
    return S()


def handler_for(events, delays, **kw):
    seen = []

    def h(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, headers={"content-type": "text/event-stream"},
                              stream=sse_stream(events, delays, **kw))
    h.seen = seen
    return h


def run(coro):
    return asyncio.run(coro)


def lvl(records, measure_s, warmup_s=0.0):
    return LevelResult(records=records, warmup_s=warmup_s, measure_s=measure_s, users=1)


async def one(handler, max_tokens=8):
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        return await one_request(c, "http://x", "m", [{"role": "user", "content": "hi"}],
                                 max_tokens, time.perf_counter())


def test_ttft_ignores_role_only_first_chunk():
    h = handler_for([chunk(role="assistant", content=""), chunk("Hi"), chunk(" there")],
                    [0.010, 0.040, 0.020])
    r = run(one(h, max_tokens=2))
    assert r.ok
    assert 45 <= r.ttft_ms < 90
    assert len(r.itl_ms) == 1 and r.itl_ms[0] >= 15


def test_tokens_prefer_usage_then_timings_then_chunks():
    u = chunk(usage={"completion_tokens": 7, "prompt_tokens": 180})
    t = chunk(timings={"predicted_n": 5, "prompt_ms": 12.5, "cache_n": 3})
    r = run(one(handler_for([chunk("a"), chunk("b"), t, u], [0] * 4), max_tokens=7))
    assert (r.out_tokens, r.tokens_source) == (7, "usage")
    assert r.prompt_tokens == 180 and r.prompt_ms == 12.5 and r.cache_n == 3
    r = run(one(handler_for([chunk("a"), chunk("b"), t], [0] * 3), max_tokens=5))
    assert (r.out_tokens, r.tokens_source) == (5, "timings")
    r = run(one(handler_for([chunk("a"), chunk("b"), chunk("c")], [0] * 3), max_tokens=3))
    assert (r.out_tokens, r.tokens_source) == (3, "chunks")


def test_request_body_pins_template_date_and_ignore_eos():
    h = handler_for([chunk("a")], [0])
    run(one(h, max_tokens=16))
    b = h.seen[0]
    assert b["chat_template_kwargs"] == {"date_string": loadgen.TEMPLATE_DATE}
    assert b["ignore_eos"] is True and b["temperature"] == 0 and b["max_tokens"] == 16
    assert b["stream"] is True and b["stream_options"] == {"include_usage": True}


def test_http_503_and_broken_stream_are_errors():
    r = run(one(lambda req: httpx.Response(503, text="busy")))
    assert not r.ok and "503" in r.error
    r = run(one(handler_for([chunk("a"), chunk("b")], [0, 0], fail_after=1)))
    assert not r.ok and r.error
    r = run(one(handler_for([chunk("a")], [0], done=False)))
    assert not r.ok and "DONE" in r.error

    # the run continues after errors
    calls = {"n": 0}

    def flaky(req):
        calls["n"] += 1
        if calls["n"] % 2:
            return httpx.Response(503)
        return handler_for([chunk("a")], [0.001])(req)
    recs = run(run_level("http://x", "m", [[{"role": "user", "content": "p"}]], 1,
                         warmup_s=0, measure_s=0.6, max_tokens=1, transport=httpx.MockTransport(flaky))).records
    assert any(not r.ok for r in recs) and any(r.ok for r in recs)


def test_records_outside_window_are_dropped():
    # each request takes ~0.3s; warm-up 0.4, window 0.4..1.0
    h = handler_for([chunk("a"), chunk("b")], [0.15, 0.15])
    recs = run(run_level("http://x", "m", [[{"role": "user", "content": "p"}]], 1,
                         warmup_s=0.4, measure_s=0.6, max_tokens=2, transport=httpx.MockTransport(h))).records
    assert recs
    for r in recs:
        if not r.in_window:
            continue
        assert r.start_s >= 0.4
        assert r.start_s + r.e2e_ms / 1000 <= 1.0 + 0.02
    assert len([r for r in recs if r.in_window]) <= 2  # straddling requests are latency-dropped


def mk(ok=True, tokens=10, chunk_times=None, **kw):
    return Record(user=0, start_s=0, ttft_ms=50, itl_ms=[10.0], e2e_ms=100, out_tokens=tokens,
                  tokens_source="usage", ok=ok, error=None if ok else "x",
                  chunk_times=list(chunk_times) if chunk_times is not None else [0.0] * tokens,
                  **kw)


def test_level_invalid_above_one_percent_errors():
    s = summarize(lvl([mk() for _ in range(98)] + [mk(False), mk(False)], 60))
    assert s["n_ok"] == 98 and s["n_err"] == 2 and s["valid"] is False
    s = summarize(lvl([mk() for _ in range(99)] + [mk(False)], 60))
    assert s["valid"] is True and s["err_rate"] == 0.01


def test_short_outputs_are_errors_and_counted():
    h = handler_for([chunk("a"), chunk("b")], [0, 0])
    r = run(one(h, max_tokens=256))
    assert not r.ok and r.short and "short output" in r.error
    s = summarize(lvl([mk(), mk(False, short=True)], 10))
    assert s["n_short"] == 1 and s["n_err"] == 1 and s["valid"] is False


def test_tok_s_steady_stream_matches_true_rate():
    # one chunk every 10 ms, true rate 100 tok/s, window 1..3 s (measure 2)
    times = [i * 0.01 for i in range(400)]
    r = mk(tokens=400, chunk_times=times)
    s = summarize(lvl([r], 2.0, 1.0))
    assert s["tokens_per_chunk"] == 1.0
    assert abs(s["tok_s"] - 100.0) / 100.0 < 0.01


def test_tok_s_partial_request_at_window_end_counts_in_window_chunks():
    full = mk(tokens=10, chunk_times=[1.0 + 0.1 * i for i in range(10)])
    partial = Record(user=1, start_s=2.0, ok=None, partial=True, in_window=False,
                     chunk_times=[2.5, 2.8, 2.9, 3.0, 3.1, 3.4])  # window 1..3: 4 inside
    s = summarize(lvl([full, partial], 2.0, 1.0))
    assert s["n_ok"] == 1 and s["n_err"] == 0  # partial is not an error
    assert s["tok_s"] == (10 + 4) / 2.0


def test_tok_s_request_straddling_warmup_counts_only_post_warmup_chunks():
    straddle = mk(tokens=8, chunk_times=[0.6, 0.8, 0.9, 1.1, 1.2, 1.3, 1.4, 1.5], in_window=False)
    s = summarize(lvl([straddle], 1.0, 1.0))
    assert s["n_ok"] == 0 and s["tok_s"] == 5.0  # 5 chunks at or after 1.0, none of its latency counted
    full = mk(tokens=4, chunk_times=[1.6, 1.7, 1.8, 1.9])
    s = summarize(lvl([straddle, full], 1.0, 1.0))
    assert s["tok_s"] == (5 + 4) / 1.0  # 5 post-warm-up chunks from the straddler


def test_run_level_returns_partial_and_straddlers_for_throughput():
    # 10 chunks 0.05 s apart (0.5 s per request); warm-up 0.25, window ends 0.95
    h = handler_for([chunk(str(i)) for i in range(10)], [0.05] * 10)
    res = run(run_level("http://x", "m", [[{"role": "user", "content": "p"}]], 1,
                         warmup_s=0.25, measure_s=0.7, max_tokens=10,
                         transport=httpx.MockTransport(h)))
    recs = res.records
    assert any(r.partial for r in recs)
    assert all(not r.ok for r in recs if r.partial) or all(r.ok is None for r in recs if r.partial)
    assert any(not r.in_window and not r.partial for r in recs)
    s = summarize(res)
    assert (res.warmup_s, res.measure_s, res.users) == (0.25, 0.7, 1)
    assert s["n_err"] == 0 and s["tokens_per_chunk"] == 1.0
    n = sum(1 for r in recs for t in r.chunk_times if 0.25 <= t <= 0.95)
    assert s["tok_s"] == n / 0.7  # computed from arrival times in the window
    assert 14 <= s["tok_s"] <= 26  # synthetic stream runs at about 20 chunks/s


def test_no_ok_record_gives_none_throughput():
    s = summarize(lvl([mk(False, chunk_times=[1.1])], 1.0, 1.0))
    assert s["tok_s"] is None and s["tokens_per_chunk"] is None


def test_on_window_start_fires_once_at_warmup_end_without_delaying_workers():
    h = handler_for([chunk("a")], [0.001])
    fired = []

    async def cb():
        fired.append(time.perf_counter())
        await asyncio.sleep(0.3)  # slow callback must not stall the load

    async def go():
        t0 = time.perf_counter()
        res = await run_level("http://x", "m", [[{"role": "user", "content": "p"}]], 1,
                              warmup_s=0.3, measure_s=0.5, max_tokens=1,
                              transport=httpx.MockTransport(h), on_window_start=cb)
        return t0, res
    t0, res = run(go())
    assert len(fired) == 1
    assert 0.28 <= fired[0] - t0 <= 0.45
    assert any(r.ok and r.start_s > 0.35 for r in res.records)  # workers kept going meanwhile
