FROM ghcr.io/astral-sh/uv:latest AS uv

FROM python:3.12-slim-bookworm

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /usr/local/bin/uv

WORKDIR /opt/hyperkit
COPY python/hyperkit python/hyperkit

RUN uv pip install --system "./python/hyperkit[aws]" \
    && rm -rf /root/.cache

ENV HOME=/tmp
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

USER 65532:65532

ENTRYPOINT ["python", "-m", "hyperkit.cloud.controller"]
