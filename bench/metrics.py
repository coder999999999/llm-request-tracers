"""Readers for server-side numbers: vLLM Prometheus metrics and llama.cpp log lines."""
import re

_SAMPLE = re.compile(r"^([^\s{]+)(?:\{(.*)\})?\s+(\S+)")
_LABEL = re.compile(r'([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"')

# llama.cpp tools/server/server-context.cpp:3930 at the pinned commit
KV_RETRY_TEXT = "failed to find free space in the KV cache, retrying with smaller batch size"

QUEUE = "vllm:request_queue_time_seconds"
PREFILL = "vllm:request_prefill_time_seconds"
DECODE = "vllm:request_decode_time_seconds"
TTFT = "vllm:time_to_first_token_seconds"
PREEMPTIONS = "vllm:num_preemptions"  # exposed as vllm:num_preemptions_total


def parse_prom(text: str) -> dict[str, float]:
    """Parse Prometheus text exposition. Key is `name{k="v",...}` with labels sorted."""
    out: dict[str, float] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = _SAMPLE.match(line)
        if not m:
            continue
        name, labels, value = m.groups()
        try:
            v = float(value)
        except ValueError:
            continue
        pairs = sorted(_LABEL.findall(labels)) if labels else []
        key = name + ("{" + ",".join(f'{k}="{val}"' for k, val in pairs) + "}" if pairs else "")
        out[key] = v
    return out


def _total(samples: dict[str, float], name: str) -> float | None:
    """Sum a metric across all label sets; None if the metric is absent."""
    found = False
    total = 0.0
    for key, v in samples.items():
        base = key.split("{", 1)[0]
        if base == name:
            found = True
            total += v
    return total if found else None


def hist_mean_ms(before: dict[str, float], after: dict[str, float], name: str) -> float | None:
    s0, s1 = _total(before, name + "_sum"), _total(after, name + "_sum")
    c0, c1 = _total(before, name + "_count"), _total(after, name + "_count")
    if s1 is None or c1 is None:
        return None
    dc = c1 - (c0 or 0.0)
    ds = s1 - (s0 or 0.0)
    if dc <= 0 or ds < 0:
        return None
    return ds / dc * 1000.0


def counter_delta(before: dict[str, float], after: dict[str, float], name: str) -> float | None:
    for n in (name, name + "_total"):
        a = _total(after, n)
        if a is not None:
            b = _total(before, n) or 0.0
            return a - b if a >= b else None
    return None


def vllm_stage_means(before: dict[str, float], after: dict[str, float]) -> dict[str, float | None]:
    return {
        "queue_ms": hist_mean_ms(before, after, QUEUE),
        "prefill_ms": hist_mean_ms(before, after, PREFILL),
        "decode_ms": hist_mean_ms(before, after, DECODE),
        "ttft_ms": hist_mean_ms(before, after, TTFT),
        "preemptions": counter_delta(before, after, PREEMPTIONS),
    }


def count_kv_retries(log_text: str) -> int:
    return sum(1 for line in log_text.splitlines() if KV_RETRY_TEXT in line)
