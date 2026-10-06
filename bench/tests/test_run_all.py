import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import run_all  # noqa: E402


def test_engine_order_alternates_per_repeat():
    runs = run_all.plan_runs(repeats=3, configs=["main"])
    order = []
    for r in range(3):
        engines = []
        for run in runs:
            if run.repeat == r and run.engine not in engines:
                engines.append(run.engine)
        order.append(tuple(engines))
    assert order == [("llama", "vllm"), ("vllm", "llama"), ("llama", "vllm")]


def test_kvfull_steps_max_tokens():
    runs = [r for r in run_all.plan_runs(repeats=1, configs=["kvfull"]) if r.engine == "llama"]
    assert [(r.users, r.max_tokens) for r in runs] == [(64, 256), (64, 512), (64, 1024)]
    assert len({r.group for r in runs}) == 1  # one fresh server for the three levels


def test_main_levels_and_reuse_plan():
    runs = run_all.plan_runs(repeats=1, configs=["main", "reuse"], engines=["vllm"], levels=[1, 8])
    assert [(r.config, r.kind, r.users) for r in runs] == [("main", "level", 1), ("main", "level", 8),
                                                           ("reuse", "reuse", 1)]
    assert len({r.group for r in runs}) == 3  # fresh server for each


def _fake_run(cmd):
    s = " ".join(cmd)
    if "--query-gpu" in s:
        return ("name, driver_version, memory.total [MiB], power.limit [W], clocks.max.sm [MHz], "
                "clocks.max.memory [MHz], clocks.current.sm [MHz], clocks.current.memory [MHz]\n"
                "NVIDIA GeForce RTX 4090, 615.71, 24564 MiB, 450.00 W, 3105 MHz, 10501 MHz, 210 MHz, 405 MHz\n")
    if "nvidia-smi" in s:
        return "| NVIDIA-SMI 616.92   Driver Version: 615.71   CUDA UMD Version: 13.4 |"
    if "image inspect" in s:
        return 'sha256:abc|["repo@sha256:def"]'
    return "deadbeef"


def test_env_json_has_no_user_paths():
    env = run_all.collect_env(run=_fake_run)
    text = json.dumps(env)
    assert not re.search(r"C:/Users|/home/|/Users/", text, re.IGNORECASE)
    assert env["gpu"]["name"] == "NVIDIA GeForce RTX 4090" and env["gpu"]["cuda_version"] == "13.4"
    assert env["gpu"]["clocks_max_mem"] == "10501 MHz"
    assert env["server_args"]["kvfull"]["llama"].endswith("--kv-unified")
    assert env["server_args"]["reuse"]["vllm"].endswith("--max-model-len 4096")


def test_private_path_guard_raises():
    for bad in ("C:/" + "Users/x", "/ho" + "me/u", "/Us" + "ers/me"):
        try:
            run_all.assert_no_private_paths(json.dumps({"p": bad}))
        except ValueError:
            continue
        raise AssertionError(bad)
