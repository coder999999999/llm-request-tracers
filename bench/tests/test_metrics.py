import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from metrics import (  # noqa: E402
    count_kv_retries, counter_delta, hist_mean_ms, parse_prom, vllm_stage_means,
)

FIX = Path(__file__).parent / "fixtures"
before = parse_prom((FIX / "vllm_metrics_before.txt").read_text())
after = parse_prom((FIX / "vllm_metrics_after.txt").read_text())


def test_parse_prom_keys_sorted_labels():
    k = 'vllm:request_prefill_time_seconds_sum{engine="0",model_name="llama-3.1-8b"}'
    assert after[k] == pytest.approx(0.322985029000165)
    assert parse_prom('m{b="2",a="1"} 3\n# c\n') == {'m{a="1",b="2"}': 3.0}


def test_hist_mean_matches_hand_computed():
    # fixture delta: sum 0.322985029000165 s over 5 requests
    assert hist_mean_ms(before, after, "vllm:request_prefill_time_seconds") == pytest.approx(0.322985029000165 / 5 * 1000)
    assert hist_mean_ms(before, after, "vllm:request_prefill_time_seconds") == pytest.approx(64.597, abs=1e-3)


def test_hist_mean_sums_label_sets():
    b = parse_prom('h_sum{e="0"} 1\nh_count{e="0"} 1\nh_sum{e="1"} 1\nh_count{e="1"} 1\n')
    a = parse_prom('h_sum{e="0"} 2\nh_count{e="0"} 2\nh_sum{e="1"} 4\nh_count{e="1"} 3\n')
    assert hist_mean_ms(b, a, "h") == pytest.approx(4 / 3 * 1000)


def test_no_new_samples_or_missing_is_none():
    assert hist_mean_ms(after, after, "vllm:request_prefill_time_seconds") is None
    assert hist_mean_ms(before, after, "nope") is None


def test_counter_reset_is_none():
    assert counter_delta(parse_prom("c_total 5\n"), parse_prom("c_total 2\n"), "c") is None
    assert counter_delta(parse_prom("c_total 5\n"), parse_prom("c_total 7\n"), "c") == 2.0


def test_vllm_stage_means():
    m = vllm_stage_means(before, after)
    assert m["queue_ms"] == pytest.approx(8.515899980920949e-05 / 5 * 1000)
    assert m["ttft_ms"] == pytest.approx(0.33287549018859863 / 5 * 1000)
    assert m["decode_ms"] == pytest.approx(2.9297514529998807 / 5 * 1000)
    assert m["preemptions"] == 0.0


def test_count_kv_retries():
    log = "\n".join([
        "slot update_slots: id 0 | task 1 | prompt processing",
        "srv  update_slots: failed to find free space in the KV cache, retrying with smaller batch size, i = 0, n_batch = 2048, ret = 1",
        "slot release: id 0",
        "srv  update_slots: failed to find free space in the KV cache, retrying with smaller batch size, i = 0, n_batch = 1024, ret = 1",
        "done",
    ])
    assert count_kv_retries(log) == 2
