# llama.cpp tools at the pinned commit (2ca15f5) plus the Nsight Systems CLI, for kernel traces.
# Build: docker build -t rtbench/llama-prof:2ca15f5 inference/capture
FROM rtbench/llama-tools:2ca15f5
RUN apt-get update \
 && apt-get install -y --no-install-recommends nsight-systems-2026.3.2 curl python3 \
 && rm -rf /var/lib/apt/lists/*
RUN ln -sf "$(ls -d /opt/nvidia/nsight-systems/*/bin/nsys | head -1)" /usr/local/bin/nsys
WORKDIR /app
ENTRYPOINT []
