#!/usr/bin/env python3
"""Turn one capture folder (see capture.sh) into inventory.json and inventory.md.

    python3 analyze.py <capture dir>

What it does:
  * ops-*.log      -> the logical ggml graph (one row per node), grouped by layer
  * trace_cuda_gpu_trace.csv -> the request's GPU work, cut into forward passes at each
    logits copy (Device-to-Host), then every kernel is given a role (q_proj, attention, ...)
  * tensors.json   -> weight bytes per matmul, so each matmul kernel gets an effective
    bandwidth (bytes it must read / its duration)
  * bench.json     -> uninstrumented llama-bench numbers
Runs with the standard library only (python3 in rtbench/llama-prof).
"""
import csv, json, re, statistics, sys
from collections import Counter, defaultdict
from pathlib import Path

D = Path(sys.argv[1])
OP_RE = re.compile(r"common_debug_cb_eval:\s+(.+?) = \((\w+)\)\s+(\w+)\((.*?)\{([\d, ]+)\}, (?:(.*?)\{([\d, ]+)\})?\}?\) = \{([\d, ]+)\}")


def shape(s):
    return [int(x) for x in s.split(",")]


def parse_ops(path):
    ops = []
    for line in open(path, encoding="utf-8", errors="replace"):
        m = OP_RE.search(line)
        if not m:
            continue
        name, typ, op, s0, s0sh, s1, s1sh, out = m.groups()
        # Layer from the node name (Qcur-3, cache_k_l3), else from its first input (node_21 = FLASH_ATTN_EXT(Qcur-0 ...)).
        lm = re.search(r"-(\d+)(?:\s|$)", name.strip()) or re.search(r"_l(\d+)", name)
        if not lm and name.strip().startswith("node_"):
            lm = re.search(r"-(\d+)(?:\s|$)", s0.strip()) or re.search(r"_l(\d+)", s0)
        lm = lm or re.search(r"blk\.(\d+)\.", s0 + " " + (s1 or ""))
        ops.append({"name": name.strip(), "type": typ, "op": op, "src0": s0.strip(), "src0_shape": shape(s0sh),
                    "src1": (s1 or "").strip() or None, "src1_shape": shape(s1sh) if s1sh else None,
                    "out_shape": shape(out), "layer": int(lm.group(1)) if lm else None})
    return ops


def summarize_ops(ops):
    n_layer = max(o["layer"] for o in ops if o["layer"] is not None) + 1
    layer0 = [o for o in ops if o["layer"] == 0]
    pre, post, seen_layer = [], [], False
    for o in ops:
        if o["layer"] is not None:
            seen_layer = True
        elif not seen_layer:
            pre.append(o)
        else:
            post.append(o)
    # ops between the last layer and the output head that carry no layer suffix
    last = [o for o in ops if o["layer"] == n_layer - 1]
    return {"n_nodes": len(ops), "n_layer": n_layer, "pre": pre, "layer0": layer0,
            "last_layer": last, "post": post,
            "op_counts_layer0": Counter(o["op"] for o in layer0),
            "op_counts_total": Counter(o["op"] for o in ops)}


# ---------- kernels ----------

def short(name):
    n = name.replace("void ", "")
    n = re.sub(r"\(ggml_type\)(\d+)", lambda m: {"0": "F32", "1": "F16", "12": "Q4_K", "14": "Q6_K", "30": "BF16"}.get(m.group(1), "T" + m.group(1)), n)
    n = re.sub(r">\(.*", ">", n)
    n = re.sub(r"\((?:int|bool|ggml_prec|mmq_q8_1_ds_layout)\)", "", n)
    return re.sub(r"\(const float \*.*", "", n)


def family(name):
    for key, fam in [("mul_mat_vec_q", "mmvq"), ("mul_mat_q_stream_k_fixup", "mmq_fixup"), ("mul_mat_q<", "mmq"),
                     ("mul_mat_vec_f", "mmvf"), ("quantize_mmq_q8_1", "quant_act"), ("quantize_q8_1", "quant_act"),
                     ("flash_attn_combine", "fattn_combine"), ("flash_attn_stream_k_fixup", "fattn_fixup"),
                     ("flash_attn_ext_vec", "fattn_vec"), ("flash_attn_ext_f16", "fattn_mma"), ("flash_attn", "fattn"),
                     ("rms_norm", "rms_norm"), ("rope", "rope"), ("set_rows", "set_rows"), ("get_rows", "get_rows"),
                     ("op_add", "add"), ("unary_gated_op", "glu"), ("cutlass", "cublas"), ("gemm", "cublas"),
                     ("gemv", "cublas"), ("convert_unary", "convert"), ("k_bin_bcast", "binop"),
                     ("memcpy Host-to-Device", "h2d"), ("memcpy Device-to-Host", "d2h"), ("memset", "memset")]:
        if key in name:
            return fam
    return "other"


MATMUL = {"mmvq", "mmq", "mmvf", "cublas"}


def load_trace(path):
    rows = list(csv.DictReader(open(path)))
    ev = []
    for r in rows:
        ev.append({"t": int(r["Start (ns)"]), "dur": int(r["Duration (ns)"]), "name": r["Name"],
                   "grid": [r["GrdX"], r["GrdY"], r["GrdZ"]], "block": [r["BlkX"], r["BlkY"], r["BlkZ"]],
                   "mb": r["Bytes (MB)"]})
    ev.sort(key=lambda e: e["t"])
    # The request is the GPU work after the last idle gap of more than 1 s (capture.sh sleeps 3 s).
    gaps = [i for i in range(len(ev) - 1) if ev[i + 1]["t"] - (ev[i]["t"] + ev[i]["dur"]) > 1_000_000_000]
    req = ev[gaps[-1] + 1:] if gaps else ev
    passes, cur = [], []
    for e in req:
        e["fam"] = family(e["name"])
        e["short"] = short(e["name"])
        cur.append(e)
        if e["fam"] == "d2h":
            passes.append(cur)
            cur = []
    return passes


def assign_roles(p, n_layer):
    """Give every event in one forward pass a layer and a role."""
    norms = [i for i, e in enumerate(p) if e["fam"] == "rms_norm"]
    assert len(norms) == 2 * n_layer + 1, f"expected {2 * n_layer + 1} rms_norm kernels, got {len(norms)}"
    bounds = norms + [len(p)]
    for e in p[:norms[0]]:
        e["layer"], e["role"] = None, "inputs" if e["fam"] == "h2d" else "pre"
    for b in range(len(norms)):
        seg = p[bounds[b]:bounds[b + 1]]
        if b == 2 * n_layer:
            layer, block = None, "head"
        else:
            layer, block = b // 2, "attn" if b % 2 == 0 else "ffn"
        mms = [e for e in seg if e["fam"] in MATMUL]
        if block == "attn":
            names = ["q_proj", "v_proj", "k_proj", "o_proj"]
        elif block == "ffn":
            names = ["gate_up", "down"] if len(mms) == 2 else ["gate", "up", "down"]
        else:
            names = ["lm_head"]
        assert len(mms) == len(names), (layer, block, [e["short"] for e in mms])
        for e, n in zip(mms, names):
            e["role"] = n
        ropes = iter(["rope_q", "rope_k"])
        sets = iter(["kv_write_k", "kv_write_v"])
        last_mm = None
        for i, e in enumerate(seg):
            e["layer"] = layer
            f = e["fam"]
            if f in MATMUL:
                last_mm = e["role"]
            elif f == "rms_norm":
                e["role"] = {"attn": "attn_norm", "ffn": "ffn_norm", "head": "output_norm"}[block]
            elif f == "quant_act":
                nxt = next((x for x in seg[i + 1:] if x["fam"] in MATMUL), None)
                e["role"] = (nxt["role"] if nxt else "?") + ":quant_act"
            elif f == "mmq_fixup":
                e["role"] = (last_mm or "?") + ":fixup"
            elif f == "rope":
                e["role"] = next(ropes, "rope")
            elif f == "set_rows":
                e["role"] = next(sets, "kv_write")
            elif f.startswith("fattn"):
                e["role"] = "attention"
            elif f == "get_rows":
                e["role"] = "out_ids"
            elif f in ("binop", "add"):
                e["role"] = "residual"
            elif f == "glu":
                e["role"] = "swiglu"
            elif f == "d2h":
                e["role"] = "logits_copy"
            else:
                e["role"] = f
    return p


ROLE_OP = {"attn_norm": "attn_norm", "q_proj": "qkv", "k_proj": "qkv", "v_proj": "qkv", "rope_q": "rope", "rope_k": "rope",
           "kv_write_k": "kv_write", "kv_write_v": "kv_write", "attention": "attention", "o_proj": "o_proj",
           "ffn_norm": "ffn_norm", "gate": "ffn_gate_up", "up": "ffn_gate_up", "gate_up": "ffn_gate_up",
           "swiglu": "ffn_gate_up", "down": "ffn_down", "out_ids": "out_trim", "output_norm": "output_norm",
           "lm_head": "lm_head"}


def assign_ops(p):
    """Group the kernels of a pass into the page's steps (one layer = attn_norm ... ffn_down)."""
    ks = [e for e in p if e["fam"] not in ("h2d", "d2h", "memset")]
    for e in ks:
        e["op"] = ROLE_OP.get(e["role"].split(":")[0])
    for i, e in enumerate(ks):
        if e["op"]:
            continue
        prev = next((x["op"] for x in reversed(ks[:i]) if x["op"]), None)
        if e["role"] == "residual":
            # attention residual follows o_proj (or the last-layer row trim); the FFN residual follows down
            e["op"] = "o_proj" if prev in ("o_proj", "out_trim") else "ffn_down"
        elif e["fam"] == "convert" and "<float, __half>" in e["short"]:
            e["op"] = next((ROLE_OP.get(x["role"].split(":")[0]) for x in ks[i + 1:] if x["fam"] in MATMUL), prev)
        else:  # casts back to float, cuBLAS split-k reduce: belong to the matmul before them
            e["op"] = prev
    return p


WEIGHT_FOR_ROLE = {"q_proj": ["attn_q"], "k_proj": ["attn_k"], "v_proj": ["attn_v"], "o_proj": ["attn_output"],
                   "gate": ["ffn_gate"], "up": ["ffn_up"], "gate_up": ["ffn_gate", "ffn_up"], "down": ["ffn_down"],
                   "lm_head": ["output"]}


def weight_info(tensors, layer, role):
    names = WEIGHT_FOR_ROLE.get(role)
    if not names:
        return None
    ts = []
    for n in names:
        full = "output.weight" if n == "output" else f"blk.{layer}.{n}.weight"
        ts.append(tensors[full])
    return {"tensors": [t["name"] for t in ts], "types": sorted({t["type"] for t in ts}),
            "bytes": sum(t["bytes"] for t in ts)}


def main():
    tensors = {t["name"]: t for t in json.load(open(D / "tensors.json"))}
    ops_p = parse_ops(D / "ops-prefill.log")
    ops_d = parse_ops(D / "ops-decode.log")
    sp, sd = summarize_ops(ops_p), summarize_ops(ops_d)
    n_layer = sp["n_layer"]

    passes = load_trace(D / "trace_cuda_gpu_trace.csv")
    for p in passes:
        assign_roles(p, n_layer)
        assign_ops(p)
    prefill, decodes = passes[0], passes[1:]

    sigs = Counter(tuple(e["short"] for e in p) for p in decodes)
    decode_sig_ok = len(sigs) == 1

    def kernels(p):
        return [e for e in p if e["fam"] not in ("h2d", "d2h", "memset")]

    def pass_summary(p):
        ks = kernels(p)
        return {"kernels": len(ks), "gpu_busy_us": round(sum(e["dur"] for e in ks) / 1000, 1),
                "wall_us": round((p[-1]["t"] + p[-1]["dur"] - p[0]["t"]) / 1000, 1),
                "h2d": sum(1 for e in p if e["fam"] == "h2d"), "d2h": sum(1 for e in p if e["fam"] == "d2h")}

    # Decode: median duration per kernel position across all decode passes (same sequence every pass).
    med = []
    if decode_sig_ok:
        for i, e in enumerate(decodes[0]):
            m = dict(e)
            m["dur"] = statistics.median(p[i]["dur"] for p in decodes)
            med.append(m)
    else:
        med = decodes[len(decodes) // 2]

    def by_role(p, phase):
        agg = defaultdict(lambda: {"us": 0.0, "kernels": 0, "bytes": 0, "kinds": Counter()})
        for e in kernels(p):
            base = e["role"].split(":")[0]
            a = agg[base]
            a["us"] += e["dur"] / 1000
            a["kernels"] += 1
            a["kinds"][re.sub(r"<.*", "", e["short"])] += 1
            if ":" not in e["role"] and e["fam"] in MATMUL and e.get("layer") is not None or e["role"] == "lm_head":
                w = weight_info(tensors, e.get("layer"), e["role"])
                if w:
                    a["bytes"] += w["bytes"]
        total = sum(a["us"] for a in agg.values())
        out = []
        for role, a in sorted(agg.items(), key=lambda kv: -kv[1]["us"]):
            row = {"role": role, "us": round(a["us"], 1), "share": round(a["us"] / total, 4), "kernels": a["kernels"],
                   "kinds": dict(a["kinds"])}
            if a["bytes"]:
                row["weight_mb"] = round(a["bytes"] / 2**20, 1)
                row["gb_per_s"] = round(a["bytes"] / (a["us"] * 1e3), 1)  # bytes / ns = GB/s
            out.append(row)
        return {"phase": phase, "total_us": round(total, 1), "roles": out}

    def layer_kernels(p, layer):
        return [{"op": e["op"], "role": e["role"], "kernel": e["short"], "us": round(e["dur"] / 1000, 2),
                 "grid": e["grid"], "block": e["block"]} for e in kernels(p) if e.get("layer") == layer]

    def tail(p):
        return [{"op": e["op"], "role": e["role"], "kernel": e["short"], "us": round(e["dur"] / 1000, 2),
                 "grid": e["grid"]}
                for e in kernels(p) if e.get("layer") is None or e["role"] == "out_ids"]

    def op_totals(p):
        tot = defaultdict(float)
        for e in kernels(p):
            tot[e["op"]] += e["dur"] / 1000
        return tot

    def by_op(p, spread_passes=None):
        """Time per page step over a whole pass; weight bytes for the matmul steps; spread over decode steps."""
        agg = defaultdict(lambda: {"us": 0.0, "kernels": 0, "bytes": 0})
        for e in kernels(p):
            a = agg[e["op"]]
            a["us"] += e["dur"] / 1000
            a["kernels"] += 1
            if ":" not in e["role"] and e["fam"] in MATMUL:
                w = weight_info(tensors, e.get("layer"), e["role"])
                if w:
                    a["bytes"] += w["bytes"]
        spreads = [op_totals(q) for q in spread_passes] if spread_passes else None
        total = sum(a["us"] for a in agg.values())
        out = {}
        for op, a in agg.items():
            row = {"us": round(a["us"], 1), "share": round(a["us"] / total, 4), "kernels": a["kernels"]}
            if a["bytes"]:
                row["weight_mb"] = round(a["bytes"] / 2**20, 1)
                row["gb_per_s"] = round(a["bytes"] / (a["us"] * 1e3), 1)
            if spreads:
                vals = [s[op] for s in spreads]
                row["us_min"], row["us_max"] = round(min(vals), 1), round(max(vals), 1)
            out[op] = row
        return {"total_us": round(total, 1), "ops": out}

    # Per-matmul bandwidth in a decode step (layer 0 and the head), using median durations.
    mm_rows = []
    for e in med:
        if e["fam"] in MATMUL and ":" not in e.get("role", ""):
            w = weight_info(tensors, e.get("layer"), e["role"])
            if w and (e.get("layer") in (0, None)):
                mm_rows.append({"layer": e.get("layer"), "role": e["role"], "kernel": e["short"], "types": w["types"],
                                "weight_mb": round(w["bytes"] / 2**20, 2), "us": round(e["dur"] / 1000, 2),
                                "gb_per_s": round(w["bytes"] / e["dur"], 1)})

    gpu_weights = sum(t["bytes"] for n, t in tensors.items() if n != "token_embd.weight")
    type_mix = defaultdict(lambda: Counter())
    for n, t in tensors.items():
        m = re.match(r"blk\.\d+\.(\w+)\.weight", n)
        type_mix[m.group(1) if m else n][t["type"]] += 1

    bench = []
    try:
        for b in json.load(open(D / "bench.json")):
            bench.append({"test": f"pp{b['n_prompt']}" if b["n_prompt"] else f"tg{b['n_gen']}",
                          "avg_ts": round(b["avg_ts"], 1), "stddev_ts": round(b["stddev_ts"], 1),
                          "flash_attn": b.get("flash_attn"), "n_ubatch": b.get("n_ubatch"),
                          "gpu": b.get("gpu_info"), "build": b.get("build_commit")})
    except Exception as ex:  # bench is optional
        bench = [{"error": str(ex)}]

    timings = None
    for line in open(D / "stream.txt", encoding="utf-8"):
        if '"timings"' in line:
            timings = json.loads(line[len("data: "):])["timings"]

    decode_busy = [sum(e["dur"] for e in kernels(p)) / 1000 for p in decodes]
    inv = {
        "capture": D.name,
        "commit": "2ca15f5404760548c39e7b92bd43116a09414a1a",
        "prompt_tokens_eval_callback": int(re.search(r"number of input tokens = (\d+)", open(D / "ops-prefill.log").read()).group(1)),
        "prompt_tokens": (timings or {}).get("prompt_n"),
        "server_timings": timings,
        "bench": bench,
        "weights": {"gpu_bytes": gpu_weights, "gpu_mb": round(gpu_weights / 2**20, 1),
                    "token_embd_mb_on_cpu": round(tensors["token_embd.weight"]["bytes"] / 2**20, 1),
                    "type_mix": {k: dict(v) for k, v in type_mix.items()}},
        "graph": {
            "prefill": {"n_nodes": sp["n_nodes"], "n_layer": n_layer, "op_counts_layer0": sp["op_counts_layer0"],
                        "op_counts_total": sp["op_counts_total"], "layer0": sp["layer0"], "pre": sp["pre"],
                        "post": sp["post"], "last_layer": sp["last_layer"]},
            "decode": {"n_nodes": sd["n_nodes"], "op_counts_layer0": sd["op_counts_layer0"], "layer0": sd["layer0"]},
        },
        "trace": {
            "n_passes": len(passes),
            "decode_kernel_sequence_identical": decode_sig_ok,
            "prefill": pass_summary(prefill),
            "decode_median": {"gpu_busy_us": round(statistics.median(decode_busy), 1),
                              "gpu_busy_us_min": round(min(decode_busy), 1),
                              "gpu_busy_us_max": round(max(decode_busy), 1),
                              "kernels": len(kernels(decodes[0]))},
            "prefill_by_role": by_role(prefill, "prefill"),
            "decode_by_role": by_role(med, "decode (median per kernel over %d steps)" % len(decodes)),
            "prefill_by_op": by_op(prefill),
            "decode_by_op": by_op(med, decodes),
            "prefill_layer0": layer_kernels(prefill, 0),
            "prefill_last_layer": layer_kernels(prefill, n_layer - 1),
            "prefill_tail": tail(prefill),
            "decode_layer0": layer_kernels(med, 0),
            "decode_tail": tail(med),
            "decode_matmul_bandwidth": mm_rows,
            "kernel_families": {
                "prefill": Counter(e["fam"] for e in kernels(prefill)),
                "decode": Counter(e["fam"] for e in kernels(decodes[0])),
            },
        },
    }
    json.dump(inv, open(D / "inventory.json", "w"), indent=1, default=lambda o: dict(o))
    write_md(inv)


def write_md(inv):
    t = inv["trace"]
    L = []
    w = L.append
    w(f"# Inventory: {inv['capture']} (llama.cpp {inv['commit'][:7]})\n")
    w(f"Generated by `inference/capture/analyze.py`. Request: one streaming chat completion, "
      f"\"Why is the sky blue?\", {inv['prompt_tokens']} prompt tokens after the chat template, 64 generated tokens.\n")
    st = inv["server_timings"] or {}
    w("## Headline numbers\n")
    w(f"- Weights on the GPU: {inv['weights']['gpu_mb']} MiB; `token_embd` ({inv['weights']['token_embd_mb_on_cpu']} MiB) stays in host memory and its GET_ROWS runs on the CPU.")
    w(f"- Under nsys: prompt {st.get('prompt_n')} tokens in {st.get('prompt_ms')} ms; {st.get('predicted_n')} tokens at {st.get('predicted_per_token_ms', 0):.2f} ms each.")
    for b in inv["bench"]:
        if "error" not in b:
            w(f"- llama-bench, no profiler: {b['test']} = {b['avg_ts']} ± {b['stddev_ts']} tok/s (flash_attn={b['flash_attn']}).")
    dm = t["decode_median"]
    w(f"- Forward passes in the trace: {t['n_passes']} (1 prefill + {t['n_passes'] - 1} decode). "
      f"Decode kernel sequence identical every step: {t['decode_kernel_sequence_identical']}.")
    w(f"- Prefill pass: {t['prefill']['kernels']} kernels, {t['prefill']['gpu_busy_us']} µs GPU busy, {t['prefill']['wall_us']} µs wall.")
    w(f"- Decode step: {dm['kernels']} kernels, median {dm['gpu_busy_us']} µs GPU busy (min {dm['gpu_busy_us_min']}, max {dm['gpu_busy_us_max']}).")
    w(f"- Weight bytes per decode step ÷ median GPU time = {inv['weights']['gpu_bytes'] / (dm['gpu_busy_us'] * 1e3):.0f} GB/s effective.\n")
    for key in ("prefill_by_role", "decode_by_role"):
        r = t[key]
        w(f"## Time by role: {r['phase']}\n")
        w("| Role | µs | Share | Kernels | Weights MiB | GB/s | Kernel kinds |")
        w("|---|---:|---:|---:|---:|---:|---|")
        for x in r["roles"]:
            w(f"| {x['role']} | {x['us']} | {x['share'] * 100:.1f}% | {x['kernels']} | {x.get('weight_mb', '')} | "
              f"{x.get('gb_per_s', '')} | {', '.join(f'{k}×{v}' for k, v in x['kinds'].items())} |")
        w("")
    for key, title in (("prefill_layer0", "Prefill, layer 0, in launch order"),
                       ("decode_layer0", "Decode, layer 0, in launch order (median µs)"),
                       ("prefill_tail", "Prefill, output head and last-layer trim"),
                       ("decode_tail", "Decode, output head")):
        w(f"## {title}\n")
        w("| # | Role | Kernel | µs | Grid |")
        w("|---:|---|---|---:|---|")
        for i, x in enumerate(t[key]):
            w(f"| {i} | {x['role']} | `{x['kernel']}` | {x['us']} | {'×'.join(g for g in x['grid'] if g)} |")
        w("")
    w("## Decode matmul bandwidth (layer 0 and head)\n")
    w("| Role | Weight types | MiB | µs | GB/s |")
    w("|---|---|---:|---:|---:|")
    for x in t["decode_matmul_bandwidth"]:
        w(f"| {x['role']} | {', '.join(x['types'])} | {x['weight_mb']} | {x['us']} | {x['gb_per_s']} |")
    w("")
    g = inv["graph"]
    w(f"## Logical graph (llama-eval-callback, before fusion)\n")
    w(f"- Prefill graph: {g['prefill']['n_nodes']} nodes; decode graph: {g['decode']['n_nodes']} nodes; {g['prefill']['n_layer']} layers.")
    w(f"- Ops per layer: " + ", ".join(f"{k}×{v}" for k, v in g["prefill"]["op_counts_layer0"].items()) + "\n")
    w("| # | Node | Op | Type | Inputs | Output shape |")
    w("|---:|---|---|---|---|---|")
    for i, o in enumerate(g["prefill"]["pre"] + g["prefill"]["layer0"]):
        ins = f"{o['src0']} {o['src0_shape']}" + (f", {o['src1']} {o['src1_shape']}" if o["src1"] else "")
        w(f"| {i} | {o['name']} | {o['op']} | {o['type']} | {ins} | {o['out_shape']} |")
    w("")
    w("### After the last layer\n")
    for o in g["prefill"]["post"]:
        w(f"- `{o['name']}` = {o['op']}({o['src0']} {o['src0_shape']}" + (f", {o['src1']} {o['src1_shape']}" if o["src1"] else "") + f") → {o['out_shape']}")
    w("")
    w("## Weight quant types (count of layers per type)\n")
    for k, v in inv["weights"]["type_mix"].items():
        w(f"- `{k}`: " + ", ".join(f"{t2}×{n}" for t2, n in v.items()))
    (D / "inventory.md").write_text("\n".join(L) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
