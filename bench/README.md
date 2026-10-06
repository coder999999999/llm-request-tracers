# Benchmark: llama.cpp vs vLLM

Everything runs in Docker (WSL2 backend) on one RTX 4090, one inference server on the GPU at a time.
Compose project name: `rtbench`. Model files live in the named volume `rt-models` (mounted at `/models`).

## Prerequisites

- Docker Desktop with the WSL2 backend and NVIDIA GPU support.
- Accept the Llama 3.1 licence for `meta-llama/Llama-3.1-8B-Instruct` on Hugging Face.
- Copy `bench/.env.example` to `bench/.env` and put `HF_TOKEN=...` in it. `.env` is git-ignored.

## Prepare

```bash
bash bench/fetch_llama_src.sh                    # llama.cpp at the pinned commit -> bench/.src/ (git-ignored)
docker compose -f bench/docker-compose.yml build # llama, llama-tools, client
docker compose -f bench/docker-compose.yml pull vllm
bash bench/prepare_model.sh                      # download weights, convert to F16 GGUF (about 31 GB in the volume)
```

The `llama` image is a CUDA compile (20 to 40 minutes). Build `llama` and `llama-tools` one after the other;
building them at the same time can crash the compiler.

Smoke test one server at a time:

```bash
docker compose -f bench/docker-compose.yml up -d llama   # or vllm; wait for GET /health -> 200
docker compose -f bench/docker-compose.yml down
```

`LLAMA_ARGS` and `VLLM_ARGS` are appended to each server's command to switch configs.

## Run

Filled in by later tasks.

## Outputs

Filled in by later tasks.

## Prompts

`bench/prompts/` holds the fixed prompt sets (committed): `main.jsonl` (512 prompts, 173 to 177 tokens after the
Llama 3.1 chat template) and `reuse.json` (one system prompt of about 1,490 tokens plus 20 turns). Regenerate with a
`llama` server running (token counts come from its `/apply-template` and `/tokenize`):

```bash
docker compose -f bench/docker-compose.yml up -d llama
docker compose -f bench/docker-compose.yml run --rm client python make_prompts.py --seed 7 --out prompts --server http://llama:8080
docker compose -f bench/docker-compose.yml stop llama
```

Without `--server` the script writes untuned text (used by the unit test).
