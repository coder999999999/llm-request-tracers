#!/usr/bin/env python3
"""Logit lens and direct logit attribution for the prompt pass, on the CPU from the Q4_K_M GGUF.

Runs the same numpy forward pass as attention_maps.py and keeps the residual stream after every
layer. Then:
  - logit lens: the residual at every (layer, position) through the final norm and the output
    head: the top tokens the model would predict from that state. Layer 0 here is the embedding
    itself; layer l+1 is after transformer layer l.
  - trajectory: at the final position, the probability of the final top candidates at every layer.
  - direct logit attribution at the final position: how much each head, each layer's feed-forward
    block and the embedding push each final candidate, measured as that component's output
    projected through the final norm's scale and the output head (the attribution is linear in the
    components; the final norm's divisor is taken from the full final residual).

    python -I logit_lens.py --gguf ... --tokenizer ... --prompt prompt.txt --out lens/
"""
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
from gguf import GGUFReader
from tokenizers import Tokenizer

sys.path.insert(0, str(Path(__file__).resolve().parent))
from attention_maps import BOS, deq, field, rms_norm, rope  # noqa: E402

TOPK = 5          # tokens kept per lens cell
CANDS = 8         # final candidates tracked across layers and attributed


def softmax(z):
    z = z - z.max(-1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(-1, keepdims=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gguf", required=True)
    ap.add_argument("--tokenizer", required=True)
    ap.add_argument("--prompt", required=True)
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
    base = field(r, "llama.rope.freq_base"); d_model = field(r, "llama.embedding_length"); d_head = d_model // n_head

    tok = Tokenizer.from_file(a.tokenizer)
    ids = tok.encode(Path(a.prompt).read_text(encoding="utf-8"), add_special_tokens=False).ids
    if ids[0] != BOS:
        ids = [BOS] + ids
    pieces = [tok.decode([i]) if i < 128000 else tok.id_to_token(i) for i in ids]
    n = len(ids)
    piece = lambda i: tok.decode([int(i)]) if int(i) < 128000 else tok.id_to_token(int(i))

    freq_factors = deq(T["rope_freqs.weight"])
    pos = np.arange(n, dtype=np.float32)
    x = deq(T["token_embd.weight"], rows=ids)
    resid = [x.copy()]                       # residual stream after each layer; [0] = embeddings
    head_out = []                            # per layer: [head, d_model] contribution at the final position
    mlp_out = []                             # per layer: [d_model] contribution at the final position
    mask = np.triu(np.full((n, n), -np.inf, dtype=np.float32), 1)
    for il in range(n_layer):
        p = f"blk.{il}."
        h = rms_norm(x, deq(T[p + "attn_norm.weight"]), eps)
        q = (h @ deq(T[p + "attn_q.weight"]).T).reshape(n, n_head, d_head)
        k = (h @ deq(T[p + "attn_k.weight"]).T).reshape(n, n_kv, d_head)
        v = (h @ deq(T[p + "attn_v.weight"]).T).reshape(n, n_kv, d_head)
        q, k = rope(q, pos, base, freq_factors), rope(k, pos, base, freq_factors)
        att = np.empty((n, n_head, d_head), dtype=np.float32)
        for hd in range(n_head):
            kv = hd // (n_head // n_kv)
            s = (q[:, hd] @ k[:, kv].T) / np.sqrt(d_head) + mask
            s = softmax(s)
            att[:, hd] = s @ v[:, kv]
        Wo = deq(T[p + "attn_output.weight"])   # [d_model, d_model]; column block hd*128..(hd+1)*128 reads head hd
        # each head's own share of the output projection, at the final position
        head_out.append(np.stack([att[-1, hd] @ Wo[:, hd * d_head:(hd + 1) * d_head].T for hd in range(n_head)]))
        x = x + att.reshape(n, -1) @ Wo.T
        h = rms_norm(x, deq(T[p + "ffn_norm.weight"]), eps)
        g = h @ deq(T[p + "ffn_gate.weight"]).T
        u = h @ deq(T[p + "ffn_up.weight"]).T
        m = ((g / (1 + np.exp(-g))) * u) @ deq(T[p + "ffn_down.weight"]).T
        mlp_out.append(m[-1].copy())
        x = x + m
        resid.append(x.copy())
        say(f"layer {il} done, {time.time() - t0:.0f} s")
    resid = np.stack(resid)                  # [n_layer+1, n, d_model]
    w_norm = deq(T["output_norm.weight"])
    W = T["output.weight"]
    say("dequantizing the output head")
    WU = np.concatenate([deq(W, rows=range(r0, min(r0 + 8192, int(W.shape[1])))) for r0 in range(0, int(W.shape[1]), 8192)])  # [vocab, d_model]
    say(f"output head {WU.shape}, {time.time() - t0:.0f} s")

    # ---- logit lens over every (layer, position)
    lens = []
    final_probs = None
    for L in range(n_layer + 1):
        hN = rms_norm(resid[L], w_norm, eps)
        pr = softmax(hN @ WU.T)              # [n, vocab]
        if L == n_layer:
            final_probs = pr
        rows = []
        for i in range(n):
            top = np.argsort(-pr[i])[:TOPK]
            rows.append([[int(t), piece(t), round(float(pr[i, t]), 4)] for t in top])
        lens.append(rows)
        say(f"lens layer {L}: last position top {rows[-1][0][1]!r} {rows[-1][0][2]}")

    # ---- trajectory at the final position: the final top candidates, tracked through every layer
    cands = [int(t) for t in np.argsort(-final_probs[-1])[:CANDS]]
    traj = []
    for L in range(n_layer + 1):
        hN = rms_norm(resid[L, -1:], w_norm, eps)
        pr = softmax(hN @ WU.T)[0]
        traj.append([round(float(pr[t]), 4) for t in cands])
    say("final candidates:", [(piece(t), round(float(final_probs[-1, t]), 3)) for t in cands])

    # ---- direct logit attribution at the final position, for the candidates
    # logit_t = (x_final / rms(x_final)) . (w_norm * WU[t]); each component c contributes (c / rms) . (w_norm * WU[t])
    xf = resid[-1, -1]
    rms = float(np.sqrt((xf * xf).mean() + eps))
    dirs = (w_norm * WU[cands]) / rms        # [CANDS, d_model]
    # centre each candidate's direction on the candidates' mean, so attributions say what favours one candidate over the others
    dirs_c = dirs - dirs.mean(0, keepdims=True)
    dla = {
        "embed": (resid[0, -1] @ dirs_c.T).round(3).tolist(),
        "heads": [(head_out[l] @ dirs_c.T).round(3).tolist() for l in range(n_layer)],   # [layer][head][cand]
        "mlp": [(mlp_out[l] @ dirs_c.T).round(3).tolist() for l in range(n_layer)],       # [layer][cand]
    }
    total = np.array(dla["embed"]) + np.array(dla["heads"]).sum((0, 1)) + np.array(dla["mlp"]).sum(0)
    direct = xf @ dirs_c.T
    say("attribution check: components sum", total.round(2).tolist(), "vs direct", direct.round(2).tolist())

    json.dump({
        "model": "Llama-3.1-8B-Instruct-Q4_K_M", "prompt_tokens": n, "ids": ids, "pieces": pieces,
        "layers": n_layer, "heads": n_head, "topk": TOPK,
        "lens": lens,                                     # [layer 0..32][position][k] = [id, piece, prob]
        "candidates": [[t, piece(t)] for t in cands],
        "trajectory": traj,                               # [layer 0..32][cand] = prob at the final position
        "dla": dla,
        "method": "float32 numpy forward pass from the Q4_K_M GGUF; lens = final RMS norm + output head applied to the residual stream after each layer; attribution = each component's output through the final norm's scale and the output head, centred on the candidates' mean",
    }, open(out / "lens.json", "w"))
    say(f"done, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
