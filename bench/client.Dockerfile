FROM docker:cli AS dockercli

FROM python:3.12-slim
# Docker CLI and compose plugin, so run_all.py can call `docker compose -p rtbench ...`
# through the mounted Docker socket.
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
RUN pip install --no-cache-dir "httpx==0.27.*" pytest huggingface_hub
WORKDIR /bench
