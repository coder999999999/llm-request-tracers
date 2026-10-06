"""Engine-neutral streaming load generator for OpenAI-compatible chat servers.

TTFT is measured to the first SSE chunk with non-empty choices[0].delta.content.
The only engine-specific input read is llama.cpp's optional `timings` object.
"""
import asyncio
import json
import math
import statistics
import time
from dataclasses import dataclass, field
from typing import Optional

import httpx

TEMPLATE_DATE = "26 Jul 2024"  # pinned so both chat templates render identical prompts


@dataclass
class Record:
    user: int
    start_s: float
    ttft_ms: Optional[float] = None
    itl_ms: list = field(default_factory=list)
    e2e_ms: Optional[float] = None
    out_tokens: Optional[int] = None
    tokens_source: str = "chunks"  # 'usage' | 'timings' | 'chunks'
    prompt_ms: Optional[float] = None
    cache_n: Optional[int] = None
    prompt_tokens: Optional[int] = None
    ok: Optional[bool] = False
    error: Optional[str] = None
    prompt_id: Optional[int] = None
    chunk_times: list = field(default_factory=list)  # content-chunk arrival, seconds since level t0
    partial: bool = False   # cancelled at window end; used only for throughput (ok is None)
    in_window: bool = True  # False: started in warm-up; kept only for its in-window chunks
    short: bool = False     # finished OK on the wire but out_tokens != max_tokens


def _body(model, messages, max_tokens):
    return {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "ignore_eos": True,
        "temperature": 0,
        "stream": True,
        "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"date_string": TEMPLATE_DATE},
    }


async def one_request(client, base_url, model, messages, max_tokens, t0, user=0, sink=None) -> Record:
    """One streamed chat completion. `t0` is the perf_counter origin for start_s."""
    start = time.perf_counter()
    rec = Record(user=user, start_s=start - t0)
    n_chunks = 0
    usage_tokens = timings_tokens = None
    last = None
    done = False
    try:
        async with client.stream(
            "POST", base_url.rstrip("/") + "/v1/chat/completions",
            json=_body(model, messages, max_tokens),
        ) as resp:
            if resp.status_code != 200:
                await resp.aread()
                raise RuntimeError(f"HTTP {resp.status_code}")
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    done = True
                    break
                chunk = json.loads(data)
                if "error" in chunk:
                    raise RuntimeError(f"stream error: {chunk['error']}")
                now = time.perf_counter()
                choices = chunk.get("choices") or []
                content = (choices[0].get("delta") or {}).get("content") if choices else None
                if content:
                    n_chunks += 1
                    rec.chunk_times.append(now - t0)
                    if rec.ttft_ms is None:
                        rec.ttft_ms = (now - start) * 1000
                    else:
                        rec.itl_ms.append((now - last) * 1000)
                    last = now
                usage = chunk.get("usage")
                if usage:
                    if usage.get("completion_tokens") is not None:
                        usage_tokens = usage["completion_tokens"]
                    if usage.get("prompt_tokens") is not None:
                        rec.prompt_tokens = usage["prompt_tokens"]
                tm = chunk.get("timings")
                if tm:
                    if tm.get("predicted_n") is not None:
                        timings_tokens = tm["predicted_n"]
                    if tm.get("prompt_ms") is not None:
                        rec.prompt_ms = tm["prompt_ms"]
                    if tm.get("cache_n") is not None:
                        rec.cache_n = tm["cache_n"]
        if not done:
            raise RuntimeError("stream ended without [DONE]")
        if rec.ttft_ms is None:
            raise RuntimeError("no content chunk received")
        rec.e2e_ms = (time.perf_counter() - start) * 1000
        if usage_tokens is not None:
            rec.out_tokens, rec.tokens_source = usage_tokens, "usage"
        elif timings_tokens is not None:
            rec.out_tokens, rec.tokens_source = timings_tokens, "timings"
        else:
            rec.out_tokens, rec.tokens_source = n_chunks, "chunks"
        if rec.out_tokens != max_tokens:
            rec.short = True
            raise RuntimeError(f"short output: {rec.out_tokens} != max_tokens {max_tokens}")
        rec.ok = True
    except asyncio.CancelledError:
        rec.ok, rec.partial = None, True
        if sink is not None:
            sink.append(rec)
        raise
    except Exception as e:  # noqa: BLE001 - every failure is counted, never raised
        rec.ok = False
        rec.error = f"{type(e).__name__}: {e}"
        rec.e2e_ms = (time.perf_counter() - start) * 1000
    return rec


@dataclass
class LevelResult:
    """Outcome of one load level.

    `records` mixes three kinds: latency/error records (`in_window and not partial`),
    warm-up straddlers and window-end partials (`in_window=False`), which exist only for
    throughput. Latency consumers must filter `in_window and not partial`; use `summarize`.
    """
    records: list
    warmup_s: float
    measure_s: float
    users: int


def _messages(p):
    return p["messages"] if isinstance(p, dict) else p


async def run_level(base_url, model, prompts, users, warmup_s=30, measure_s=60,
                    max_tokens=256, transport=None) -> "LevelResult":
    """Closed loop with `users` workers.

    Latency/error records: requests that started after warm-up and finished before the
    window ends. Also returned, flagged and used only for throughput: requests that
    straddle warm-up end (`in_window=False`) and requests cancelled at window end
    (`partial=True`), when they streamed content chunks inside the window.
    Pass the same `warmup_s` to `summarize`. `prompts` items are message lists or
    dicts {"id", "messages"}."""
    t0 = time.perf_counter()
    end_s = warmup_s + measure_s
    records, partials = [], []

    async def worker(client, u):
        i = u * 7
        while time.perf_counter() - t0 < end_s:
            p = prompts[i % len(prompts)]
            i += 1
            rec = await one_request(client, base_url, model, _messages(p), max_tokens, t0,
                                    user=u, sink=partials)
            if isinstance(p, dict):
                rec.prompt_id = p.get("id")
            if rec.start_s >= warmup_s and rec.start_s + rec.e2e_ms / 1000 <= end_s:
                records.append(rec)
            else:
                rec.in_window = False
                if any(warmup_s <= t <= end_s for t in rec.chunk_times):
                    records.append(rec)
            if not rec.ok:
                await asyncio.sleep(0.1)  # don't spin against a down server

    kw = dict(timeout=None,
              limits=httpx.Limits(max_connections=users, max_keepalive_connections=users))
    if transport is not None:
        kw["transport"] = transport
    async with httpx.AsyncClient(**kw) as client:
        tasks = [asyncio.create_task(worker(client, u)) for u in range(users)]
        await asyncio.sleep(max(0.0, end_s - (time.perf_counter() - t0)))
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    for rec in partials:
        rec.in_window = False
        if any(warmup_s <= t <= end_s for t in rec.chunk_times):
            records.append(rec)
    return LevelResult(records=records, warmup_s=warmup_s, measure_s=measure_s, users=users)


def _pcts(values):
    if not values:
        return None
    s = sorted(values)
    p90 = s[min(len(s) - 1, math.ceil(0.9 * len(s)) - 1)]  # nearest rank
    return {"median": statistics.median(s), "p90": p90}


def summarize(level: LevelResult) -> dict:
    """Latency/error stats come from records with in_window and not partial.
    tok_s counts content chunks that arrived in [warmup_s, warmup_s+measure_s] from every
    record, times tokens_per_chunk (sum out_tokens / sum content chunks over completed OK records)."""
    records, warmup_s, measure_s = level.records, level.warmup_s, level.measure_s
    lat = [r for r in records if r.in_window and not r.partial]
    ok = [r for r in lat if r.ok]
    n_err = len(lat) - len(ok)
    err_rate = n_err / len(lat) if lat else 0.0
    done = [r for r in records if r.ok]  # completed OK, including warm-up straddlers
    ok_chunks = sum(len(r.chunk_times) for r in done)
    tpc = sum(r.out_tokens or 0 for r in done) / ok_chunks if ok_chunks else None
    end_s = warmup_s + measure_s
    in_win = sum(1 for r in records for t in r.chunk_times if warmup_s <= t <= end_s)
    return {
        "n_ok": len(ok),
        "n_err": n_err,
        "n_short": sum(1 for r in lat if r.short),
        "err_rate": err_rate,
        "valid": bool(ok) and err_rate <= 0.01,
        "ttft_ms": _pcts([r.ttft_ms for r in ok if r.ttft_ms is not None]),
        "itl_ms": _pcts([x for r in ok for x in r.itl_ms]),
        "e2e_ms": _pcts([r.e2e_ms for r in ok if r.e2e_ms is not None]),
        "prompt_ms": _pcts([r.prompt_ms for r in ok if r.prompt_ms is not None]),
        "tokens_per_chunk": tpc,
        "tok_s": in_win * tpc / measure_s if tpc is not None else None,
    }
