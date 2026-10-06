import json
import subprocess
import sys
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent


def generate(out_dir):
    subprocess.run(
        [sys.executable, str(BENCH / "make_prompts.py"), "--seed", "7", "--out", str(out_dir)],
        check=True,
    )


def test_main_prompts_are_unique_and_seeded(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    generate(a)
    generate(b)
    assert (a / "main.jsonl").read_bytes() == (b / "main.jsonl").read_bytes()
    assert (a / "reuse.json").read_bytes() == (b / "reuse.json").read_bytes()
    rows = [json.loads(line) for line in (a / "main.jsonl").read_text().splitlines()]
    assert len(rows) == 512
    assert [r["id"] for r in rows] == list(range(512))
    contents = [r["messages"][0]["content"] for r in rows]
    assert all(r["messages"][0]["role"] == "user" for r in rows)
    assert len(set(contents)) == 512
    reuse = json.loads((a / "reuse.json").read_text())
    assert len(reuse["turns"]) == 20 and len(set(reuse["turns"])) == 20
    assert reuse["system"]


def test_committed_prompts_shape():
    rows = [json.loads(line) for line in (BENCH / "prompts" / "main.jsonl").read_text().splitlines()]
    assert len(rows) == 512
    assert len({r["messages"][0]["content"] for r in rows}) == 512
    reuse = json.loads((BENCH / "prompts" / "reuse.json").read_text())
    assert len(reuse["turns"]) == 20
