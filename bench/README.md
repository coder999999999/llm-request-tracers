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

The vLLM image is a CI post-merge tag (`public.ecr.aws/q9t5s3a7/vllm-ci-postmerge-repo:<commit>`), and CI tags can be removed
without notice. If the pull fails, check out vLLM at the pinned commit `138810056093301f4881050fcf2b1786939da387`,
build its Docker image from the Dockerfile in that checkout (the `vllm-openai` target), and tag the result with the image name in
`docker-compose.yml`, or change the `image:` line of the `vllm` service to your own tag. Nothing else needs to change.
The recorded image digest is in `env.json`.

The `llama` image is a CUDA compile (20 to 40 minutes). Build `llama` and `llama-tools` one after the other;
building them at the same time can crash the compiler.

Smoke test one server at a time:

```bash
docker compose -f bench/docker-compose.yml up -d llama   # or vllm; wait for GET /health -> 200
docker compose -f bench/docker-compose.yml down
```

`LLAMA_ARGS` and `VLLM_ARGS` are appended to each server's command to switch configs.

## Run

Everything is driven by `run_all.py` inside the `client` container. Run these from the repository root. The harness
commit is recorded in `env.json`; the container has no `.git`, so pass it in. In Git Bash, prefix the command with
`MSYS_NO_PATHCONV=1` so `/bench/...` is not rewritten into a Windows path.

```bash
export HARNESS_COMMIT=$(git rev-parse HEAD)
# the full matrix (about 2 hours): every config, 3 repeats, prompt token counts checked between engines
docker compose -f bench/docker-compose.yml run --rm -e HARNESS_COMMIT client   python run_all.py --configs main,reuse,kvfull --repeats 3 --check-tokens --out /bench/results/<date>
# one level, for a quick rerun check (about 5 minutes after the images are built)
docker compose -f bench/docker-compose.yml run --rm -e HARNESS_COMMIT client   python run_all.py --configs main --levels 8 --repeats 1 --out /bench/results/rerun
```

Levels whose summary already exists in `--out` are skipped (`--no-skip` reruns them). Only one GPU server runs at a
time; `run_all.py` starts and stops each through the mounted Docker socket.

`run_all.py` sends 4 untimed `max_tokens 16` probe requests after each server start (main and kvfull) to remove
first-request JIT and clock-ramp effects. The reuse config skips the probe so its turn 1 is cold for the prefix cache. `--reuse-probe unrelated` sends the same probe
(four prompts from `main.jsonl`, which share no prefix with the reuse system prompt) before turn 1; this was used for the
control run in `bench/results/2026-10-06-reuse-control/`, which checks that the cold number does not include server start-up cost.

## Outputs

`bench/results/<date>/` holds `env.json` (GPU, driver, image digests, commits, server flags), one `*.summary.json` and
one `*.jsonl` of per-request records for every level and repeat (the committed results gzip the `.jsonl` files), the `reuse/` results, and
`prompt_tokens_check.json`. `NOTES.md` in the committed folder lists the sanity checks, caveats and the claims behind the
page text. The site reads only the summaries: `node bench/to-site.mjs bench/results/<date>` writes
`data/bench/llama-cpp.js` and `data/bench/vllm.js`. `--reuse-from <dir>` takes the prompt reuse numbers from another results
folder (the page uses the control run that way).

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
