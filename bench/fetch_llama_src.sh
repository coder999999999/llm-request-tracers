#!/usr/bin/env bash
# Check out llama.cpp at the pinned commit into bench/.src/llama.cpp (Docker build context).
# Docker's own git context cannot fetch this commit because it is not a branch tip.
set -euo pipefail
SHA=2ca15f5404760548c39e7b92bd43116a09414a1a
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.src/llama.cpp"
if [ -d "$DIR/.git" ] && [ "$(git -C "$DIR" rev-parse HEAD)" = "$SHA" ]; then exit 0; fi
rm -rf "$DIR"; mkdir -p "$DIR"
git -C "$DIR" init -q
git -C "$DIR" config core.autocrlf false
git -C "$DIR" config core.longpaths true   # Windows: the tree has paths over 260 characters
git -C "$DIR" remote add origin https://github.com/ggml-org/llama.cpp.git
git -C "$DIR" fetch --depth=1 origin "$SHA"
git -C "$DIR" checkout -q FETCH_HEAD
