#!/usr/bin/env python3
"""Generate the fixed, seeded benchmark prompts.

    python make_prompts.py --seed 7 --out prompts                       # offline, word-count estimate
    python make_prompts.py --seed 7 --out prompts --server http://llama:8080   # tuned to exact token counts

Outputs (in --out): main.jsonl (512 single-user-turn prompts) and reuse.json (one long system prompt + 20 turns).
Text is made of random sentences from the vocabulary below; it is not real prose and holds no personal data.
"""
import argparse
import json
import random
from pathlib import Path

import httpx

N_MAIN = 512
N_TURNS = 20
MAIN_RANGE = (170, 190)
SYSTEM_RANGE = (1450, 1550)

ADJ = """quiet bright old narrow careful green heavy gentle rapid hollow distant simple warm clever
pale sturdy curious ancient modest brisk fragile tidy broad lonely golden humble steady rough smooth""".split()
NOUN = """river garden lantern bridge market engine window harbor meadow ladder village orchard compass
kettle mountain library station blanket violin horizon cabinet teacher farmer sailor baker painter
traveler neighbor cousin wagon candle mirror pocket island forest corner street basket""".split()
VERB = """follows watches carries repairs measures visits describes remembers builds crosses
gathers polishes guides borrows collects explains paints opens counts folds lifts studies""".split()
PREP = "near beside behind beyond under across toward inside along around".split()
ADV = "slowly quietly often rarely carefully eagerly patiently gladly".split()


def sentence_words(rng):
    form = rng.randrange(4)
    a = lambda: rng.choice(ADJ)
    n = lambda: rng.choice(NOUN)
    v = lambda: rng.choice(VERB)
    if form == 0:
        w = ["The", a(), n(), v(), "the", a(), n(), rng.choice(PREP), "the", n()]
    elif form == 1:
        w = ["A", n(), rng.choice(ADV), v(), "a", a(), n(), "and", "the", n(), v(), "it"]
    elif form == 2:
        w = ["Every", n(), rng.choice(PREP), "the", n(), v(), "some", a(), n()]
    else:
        w = ["The", n(), "that", v(), "the", n(), rng.choice(ADV), v(), "the", a(), n()]
    return w


def sentence_stream(rng, count=80):
    return [sentence_words(rng) for _ in range(count)]


def build_text(sentences, n_words):
    """First n_words words of the sentence stream; the last sentence is cut and closed with a period."""
    out, used = [], 0
    for s in sentences:
        take = min(len(s), n_words - used)
        if take <= 0:
            break
        out.append(" ".join(s[:take]) + ".")
        used += take
    return " ".join(out)


def templated_len(base_url, messages):
    """Token count of the chat-templated prompt as the server processes it.

    /apply-template returns the prompt text without BOS; the server's chat path tokenizes it
    with add_special=true, which prepends BOS, so the same is requested here.
    """
    with httpx.Client(timeout=60) as c:
        r = c.post(f"{base_url}/apply-template", json={"messages": messages})
        r.raise_for_status()
        prompt = r.json()["prompt"]
        r = c.post(f"{base_url}/tokenize", json={"content": prompt, "add_special": True})
        r.raise_for_status()
        return len(r.json()["tokens"])


def tune(sentences, measure, lo, hi, start_words):
    """Find a word count whose measured length is inside [lo, hi]; aim for the middle."""
    target = (lo + hi) // 2
    n = start_words
    seen = set()
    for _ in range(60):
        text = build_text(sentences, n)
        length = measure(text)
        if lo <= length <= hi:
            return text, length
        if n in seen:  # oscillating: nudge by one word toward the target
            n += 1 if length < target else -1
        seen.add(n)
        step = round((target - length) / 1.4)
        n += step if step else (1 if length < target else -1)
        n = max(n, 3)
    raise RuntimeError(f"could not reach {lo}-{hi} tokens")


def generate(seed, server=None):
    rng = random.Random(seed)
    rows, lengths, seen = [], [], set()
    for i in range(N_MAIN):
        while True:
            sents = sentence_stream(rng)
            if server:
                measure = lambda t: templated_len(server, [{"role": "user", "content": t}])
                text, length = tune(sents, measure, MAIN_RANGE[0] + 3, MAIN_RANGE[1] - 3, 105)
            else:
                text, length = build_text(sents, 105), None
            if text not in seen:
                seen.add(text)
                break
        rows.append({"id": i, "messages": [{"role": "user", "content": text}]})
        lengths.append(length)

    # Reuse set: one long system prompt and 20 distinct short user turns.
    sys_sents = sentence_stream(rng, 400)
    turns = []
    while len(turns) < N_TURNS:
        t = "Please " + build_text(sentence_stream(rng, 2), rng.randint(9, 16)).lower() + " What do you think?"
        if t not in turns:
            turns.append(t)
    if server:
        measure = lambda t: templated_len(server, [{"role": "system", "content": t}])
        system, sys_len = tune(sys_sents, measure, 1480, 1520, 1050)
        with_turns = [templated_len(server, [{"role": "system", "content": system}, {"role": "user", "content": t}]) for t in turns]
    else:
        system, sys_len, with_turns = build_text(sys_sents, 1050), None, None
    return rows, lengths, {"system": system, "turns": turns}, sys_len, with_turns


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default="prompts")
    ap.add_argument("--server", help="llama.cpp base URL, e.g. http://llama:8080; tunes to exact token counts")
    a = ap.parse_args()
    rows, lengths, reuse, sys_len, with_turns = generate(a.seed, a.server)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "main.jsonl", "w", newline="\n") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=True) + "\n")
    with open(out / "reuse.json", "w", newline="\n") as f:
        json.dump(reuse, f, ensure_ascii=True, indent=1)
        f.write("\n")
    if a.server:
        print(f"main: n={len(rows)} min={min(lengths)} max={max(lengths)} (target {MAIN_RANGE[0]}-{MAIN_RANGE[1]})")
        print(f"reuse system alone: {sys_len} tokens; system + one turn: min={min(with_turns)} max={max(with_turns)} (target {SYSTEM_RANGE[0]}-{SYSTEM_RANGE[1]})")
        assert all(MAIN_RANGE[0] <= x <= MAIN_RANGE[1] for x in lengths)
        assert SYSTEM_RANGE[0] <= sys_len <= SYSTEM_RANGE[1]
        assert all(SYSTEM_RANGE[0] <= x <= SYSTEM_RANGE[1] for x in with_turns)
    else:
        print(f"wrote {len(rows)} prompts and reuse set to {out} (offline, lengths not verified)")


if __name__ == "__main__":
    main()
