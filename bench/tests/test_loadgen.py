import asyncio
import json
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import loadgen  # noqa: E402
from loadgen import Record, one_request, run_level, summarize  # noqa: E402


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


async def one(handler, max_tokens=8):
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        return await one_request(c, "http://x", "m", [{"role": "user", "content": "hi"}],
                                 max_tokens, time.perf_counter())


def test_ttft_ignores_role_only_first_chunk():
    h = handler_for([chunk(role="assistant", content=""), chunk("Hi"), chunk(" there")],
                    [0.010, 0.040, 0.020])
    r = run(one(h))
    assert r.ok
    assert 45 <= r.ttft_ms < 90
    assert len(r.itl_ms) == 1 and r.itl_ms[0] >= 15


def test_tokens_prefer_usage_then_timings_then_chunks():
    u = chunk(usage={"completion_tokens": 7, "prompt_tokens": 180})
    t = chunk(timings={"predicted_n": 5, "prompt_ms": 12.5, "cache_n": 3})
    r = run(one(handler_for([chunk("a"), chunk("b"), t, u], [0] * 4)))
    assert (r.out_tokens, r.tokens_source) == (7, "usage")
    assert r.prompt_tokens == 180 and r.prompt_ms == 12.5 and r.cache_n == 3
    r = run(one(handler_for([chunk("a"), chunk("b"), t], [0] * 3)))
    assert (r.out_tokens, r.tokens_source) == (5, "timings")
    r = run(one(handler_for([chunk("a"), chunk("b"), chunk("c")], [0] * 3)))
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
                         warmup_s=0, measure_s=0.3, transport=httpx.MockTransport(flaky)))
    assert any(not r.ok for r in recs) and any(r.ok for r in recs)


def test_records_outside_window_are_dropped():
    # each request takes ~0.3s; warm-up 0.4, window 0.4..1.0
    h = handler_for([chunk("a"), chunk("b")], [0.15, 0.15])
    recs = run(run_level("http://x", "m", [[{"role": "user", "content": "p"}]], 1,
                         warmup_s=0.4, measure_s=0.6, transport=httpx.MockTransport(h)))
    assert recs
    for r in recs:
        assert r.start_s >= 0.4
        assert r.start_s + r.e2e_ms / 1000 <= 1.0 + 0.02
    assert len(recs) <= 2  # the request straddling warm-up and the one cut by the window are gone


def mk(ok=True, tokens=10):
    return Record(user=0, start_s=0, ttft_ms=50, itl_ms=[10.0], e2e_ms=100, out_tokens=tokens,
                  tokens_source="usage", ok=ok, error=None if ok else "x")


def test_level_invalid_above_one_percent_errors():
    s = summarize([mk() for _ in range(98)] + [mk(False), mk(False)], 60)
    assert s["n_ok"] == 98 and s["n_err"] == 2 and s["valid"] is False
    s = summarize([mk() for _ in range(99)] + [mk(False)], 60)
    assert s["valid"] is True and s["err_rate"] == 0.01


def test_tok_s_counts_only_ok_records_in_window():
    s = summarize([mk(tokens=100), mk(tokens=200), mk(False, tokens=999)], 10)
    assert s["tok_s"] == 30.0
    assert s["ttft_ms"] == {"median": 50, "p90": 50}
    assert s["prompt_ms"] is None
