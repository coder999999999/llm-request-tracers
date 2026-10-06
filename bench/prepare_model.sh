#!/usr/bin/env bash
# Download Llama 3.1 8B Instruct (BF16 safetensors) and convert it to an F16 GGUF.
# Both artefacts live in the rt-models Docker volume (/models inside the containers).
# Each step is skipped when its output already exists.
set -euo pipefail

# Git Bash on Windows rewrites /models/... arguments into Windows paths; stop that.
export MSYS_NO_PATHCONV=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
COMPOSE=(docker compose)
ENV_FILE=.env
HF_DIR=/models/hf/Llama-3.1-8B-Instruct
GGUF=/models/Llama-3.1-8B-Instruct-F16.gguf

if [ ! -f "$ENV_FILE" ] || ! grep -Eq '^HF_TOKEN=.+' "$ENV_FILE"; then
  cat >&2 <<MSG
bench/.env is missing or has no HF_TOKEN.
1. Accept the Llama 3.1 licence at https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct
2. Copy bench/.env.example to bench/.env and set HF_TOKEN=<your Hugging Face read token>
Then run this script again.
MSG
  exit 1
fi


if "${COMPOSE[@]}" run --rm --no-deps --entrypoint test client -s "$HF_DIR/model-00004-of-00004.safetensors"; then
  echo "Weights already downloaded, skipping."
else
  echo "Downloading meta-llama/Llama-3.1-8B-Instruct (about 16 GB)..."
  # HF_TOKEN reaches the container through env_file in docker-compose.yml.
  "${COMPOSE[@]}" run --rm --no-deps --entrypoint hf client \
    download meta-llama/Llama-3.1-8B-Instruct \
    --local-dir "$HF_DIR" --exclude "original/*"
fi

if "${COMPOSE[@]}" run --rm --no-deps --entrypoint test client -s "$GGUF"; then
  echo "GGUF already exists, skipping conversion."
else
  echo "Converting to F16 GGUF (about 16 GB)..."
  "${COMPOSE[@]}" run --rm llama-tools --convert --outtype f16 --outfile "$GGUF" "$HF_DIR"
fi

echo "Model ready:"
"${COMPOSE[@]}" run --rm --no-deps --entrypoint ls client -lh "$GGUF" "$HF_DIR"
