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
