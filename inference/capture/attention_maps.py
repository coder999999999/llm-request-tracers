#!/usr/bin/env python3
"""Attention maps of the prompt pass, computed on the CPU from the same Q4_K_M GGUF.

Flash attention never writes the attention scores out, so no capture holds them. This script runs
the 41-token prompt through Llama 3.1 8B with numpy, one layer at a time (dequantizing with gguf-py),
and saves every head's 41 x 41 attention matrix. It checks itself against the corner values that
llama-eval-callback printed for the same prompt (ops-prefill.log), which are embedded in
llama-cpp-weights.html.

    python -I attention_maps.py --gguf /models/Llama-3.1-8B-Instruct-Q4_K_M.gguf \
        --tokenizer /models/hf/Llama-3.1-8B-Instruct/tokenizer.json \
        --prompt prompt.txt --expect values.json --out attention/

Outputs in --out: maps.npy (float16, [layer, head, query, key]), maps.u8 (uint8, same order, value*255),
tokens.json (ids, pieces, stats per head), log.txt.

Activations stay in float32 here; llama.cpp's CUDA path quantizes them to 8 bits before each matmul,
so values agree with the log to a few decimals, not exactly.
"""
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
from gguf import GGUFReader
from gguf.quants import dequantize
from tokenizers import Tokenizer

BOS = 128000


def field(reader, key):
    f = reader.fields[key]
    v = f.parts[f.data[0]]
    return v.tolist() if len(v) > 1 else v[0].item()


def deq(t, rows=None):
    """Dequantize a GGUF tensor to float32, shape [ne1, ne0]. rows: optional row indices (for the embedding)."""
    data = t.data
    if rows is not None:
        assert data.ndim == 2, f"{t.name}: expected 2-d raw data, got {data.shape}"
        return np.stack([dequantize(data[r:r + 1], t.tensor_type).reshape(-1) for r in rows]).astype(np.float32)
    out = dequantize(data, t.tensor_type).astype(np.float32)
    ne = [int(x) for x in t.shape]  # ggml order: ne0 first
    return out.reshape(ne[::-1]) if len(ne) > 1 else out.reshape(-1)


def rms_norm(x, w, eps):
    return x / np.sqrt((x * x).mean(-1, keepdims=True) + eps) * w


def rope(x, pos, base, freq_factors):
    """Llama (NORM) rope: adjacent pairs. x: [tokens, heads, 128]."""
    d = x.shape[-1]
    i = np.arange(d // 2)
    theta = pos[:, None] * (base ** (-2.0 * i / d)) / freq_factors[None, :]  # [tokens, 64]
    cos, sin = np.cos(theta)[:, None, :], np.sin(theta)[:, None, :]
    x0, x1 = x[..., 0::2], x[..., 1::2]
    out = np.empty_like(x)
    out[..., 0::2] = x0 * cos - x1 * sin
    out[..., 1::2] = x0 * sin + x1 * cos
    return out


def corners(a, n=3):
    """First and last n values of the first and last rows, like common_debug_cb_eval prints."""
    a = a.reshape(-1, a.shape[-1]) if a.ndim > 1 else a.reshape(1, -1)
    rows = [0, a.shape[0] - 1] if a.shape[0] > 1 else [0]
    return [[a[r, :n].round(4).tolist(), a[r, -n:].round(4).tolist()] for r in rows]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gguf", required=True)
    ap.add_argument("--tokenizer", required=True)
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--expect", help="values JSON from llama-cpp-weights.html (prefill), for the self-check")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    log = open(out / "log.txt", "w")
    def say(*s):
        print(*s); print(*s, file=log); log.flush()

    t0 = time.time()
    r = GGUFReader(a.gguf)
    T = {t.name: t for t in r.tensors}
    n_layer = field(r, "llama.block_count"); n_head = field(r, "llama.attention.head_count")
    n_kv = field(r, "llama.attention.head_count_kv"); eps = field(r, "llama.attention.layer_norm_rms_epsilon")
    base = field(r, "llama.rope.freq_base"); d_head = field(r, "llama.embedding_length") // n_head
    say(f"model: {n_layer} layers, {n_head} heads, {n_kv} kv heads, head dim {d_head}, eps {eps}, rope base {base}")

    tok = Tokenizer.from_file(a.tokenizer)
    text = Path(a.prompt).read_text(encoding="utf-8")
    ids = tok.encode(text, add_special_tokens=False).ids
    if ids[0] != BOS:
        ids = [BOS] + ids
    pieces = [tok.decode([i]) if i < 128000 else tok.id_to_token(i) for i in ids]
    n = len(ids)
    say(f"prompt: {n} tokens; first {ids[:3]} {pieces[:3]}, last {ids[-3:]} {pieces[-3:]!r}")

    expect = json.load(open(a.expect)) if a.expect else {}
    def check(key, arr):
        got = corners(arr)
        if key in expect:
            e = expect[key]["data"]
            rows = [row for row in e if row is not None]
            want = [rows[0], rows[-1]] if len(rows) > 1 else [rows[0]]
            # 3-d prints (per head) are compared on the first head of the first token only
            if isinstance(want[0][0][0], list):
                want = [want[0][0]]; got = [corners(arr.reshape(n, -1, d_head)[0, 0])[0]]
            diff = max(abs(x - y) for w, g in zip(want, got) for ws, gs in zip(w, g) for x, y in zip(ws, gs))
            say(f"check {key:12s} max |diff| vs eval-callback corners: {diff:.4f}   mine {got[0]}")
            return diff
        say(f"values {key:12s} {got[0]}")
        return None

    freq_factors = deq(T["rope_freqs.weight"])
    pos = np.arange(n, dtype=np.float32)
    x = deq(T["token_embd.weight"], rows=ids)  # [n, 4096]
    check("embd", x)

    maps = np.zeros((n_layer, n_head, n, n), dtype=np.float32)
    mask = np.triu(np.full((n, n), -np.inf, dtype=np.float32), 1)
    for il in range(n_layer):
        p = f"blk.{il}."
        h = rms_norm(x, deq(T[p + "attn_norm.weight"]), eps)
        if il == 0: check("attn_norm", h)
        q = (h @ deq(T[p + "attn_q.weight"]).T).reshape(n, n_head, d_head)
        k = (h @ deq(T[p + "attn_k.weight"]).T).reshape(n, n_kv, d_head)
        v = (h @ deq(T[p + "attn_v.weight"]).T).reshape(n, n_kv, d_head)
        if il == 0: check("q", q.reshape(n, -1)); check("k", k.reshape(n, -1)); check("v", v.reshape(n, -1))
        q, k = rope(q, pos, base, freq_factors), rope(k, pos, base, freq_factors)
        if il == 0: check("q_rope", q.reshape(n, -1))
        att = np.empty((n, n_head, d_head), dtype=np.float32)
        for hd in range(n_head):
            kv = hd // (n_head // n_kv)
            s = (q[:, hd] @ k[:, kv].T) / np.sqrt(d_head) + mask
            s = np.exp(s - s.max(-1, keepdims=True)); s /= s.sum(-1, keepdims=True)
            maps[il, hd] = s
            att[:, hd] = s @ v[:, kv]
        if il == 0: check("attention", att.reshape(n, -1))
        x = x + att.reshape(n, -1) @ deq(T[p + "attn_output.weight"]).T
        if il == 0: check("ffn_inp", x)
        h = rms_norm(x, deq(T[p + "ffn_norm.weight"]), eps)
        g = h @ deq(T[p + "ffn_gate.weight"]).T
        u = h @ deq(T[p + "ffn_up.weight"]).T
        x = x + ((g / (1 + np.exp(-g))) * u) @ deq(T[p + "ffn_down.weight"]).T
        if il == 0: check("l_out", x)
        say(f"layer {il} done, {time.time() - t0:.0f} s")
    check("l_out_31", x[-1:])
    hN = rms_norm(x[-1:], deq(T["output_norm.weight"]), eps)
    check("output_norm", hN)
    W = T["output.weight"]; logits = np.empty(int(W.shape[1]), dtype=np.float32)
    step = 8192
    for r0 in range(0, logits.shape[0], step):
        logits[r0:r0 + step] = (hN @ deq(W, rows=range(r0, min(r0 + step, logits.shape[0]))).T)[0]
    check("logits", logits[None, :])
    top = np.argsort(-logits)[:5]
    say("top tokens:", [(int(i), tok.decode([int(i)]), round(float(logits[i]), 3)) for i in top])

    # per-head stats for the page: share on the first token, on the previous token, and entropy (bits), averaged over queries
    sink = maps[:, :, 1:, 0].mean(-1)
    prev = np.array([[np.mean([maps[l, h, i, i - 1] for i in range(1, n)]) for h in range(n_head)] for l in range(n_layer)])
    ent = -(maps * np.log2(np.maximum(maps, 1e-12))).sum(-1).mean(-1)
    np.save(out / "maps.npy", maps.astype(np.float16))
    (out / "maps.u8").write_bytes(np.clip(np.rint(maps * 255), 0, 255).astype(np.uint8).tobytes())
    json.dump({
        "model": "Llama-3.1-8B-Instruct-Q4_K_M", "prompt_tokens": n, "ids": ids, "pieces": pieces,
        "shape": [n_layer, n_head, n, n], "layout": "maps.u8: uint8 value*255, index ((layer*heads + head)*n + query)*n + key",
        "top_tokens": [[int(i), tok.decode([int(i)])] for i in top],
        "sink": sink.round(4).tolist(), "prev": prev.round(4).tolist(), "entropy_bits": ent.round(3).tolist(),
        "method": "float32 numpy forward pass from the Q4_K_M GGUF, weights dequantized with gguf-py; llama.cpp's CUDA path also quantizes activations, so values differ slightly",
    }, open(out / "tokens.json", "w"), indent=1)
    say(f"saved {maps.shape} maps, {time.time() - t0:.0f} s total")


if __name__ == "__main__":
    main()
