FROM ghcr.io/astral-sh/uv:latest AS uv

FROM node:22-bookworm

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gnupg \
        python3 \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
        -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo \
        "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install --yes --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /uvx /usr/local/bin/

WORKDIR /opt/hyperkit
COPY python/hyperkit python/hyperkit
COPY python/fusionkit-core python/fusionkit-core
COPY python/fusionkit-server python/fusionkit-server
COPY python/fusionkit-evals python/fusionkit-evals
COPY python/fusionkit-mlx python/fusionkit-mlx
COPY python/fusionkit-cli python/fusionkit-cli

RUN uv venv /opt/venv \
    && uv pip install --python /opt/venv/bin/python \
        "./python/hyperkit[aws]" \
        ./python/fusionkit-core \
        ./python/fusionkit-server \
        ./python/fusionkit-evals \
        ./python/fusionkit-mlx \
        ./python/fusionkit-cli \
        mini-swe-agent \
        swebench \
    && rm -rf /root/.cache

ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1

ENTRYPOINT ["python", "-m", "hyperkit.cloud.runner"]
