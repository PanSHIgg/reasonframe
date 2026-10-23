# Build from the repository root:
#   docker build -f deploy/ai-service.Dockerfile -t reasonframe/ai-service:dev .
#
# Base image already contains Node 24, Chromium, Playwright browser dependencies
# and CJK fonts. Only FFmpeg/ffprobe and the Python TTS environment are added.
# The service runs as uid/gid 10001 and uses /scratch for ephemeral task data.

FROM mcr.microsoft.com/playwright:v1.64.1-noble

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY ai-service/requirements-tts.txt /tmp/requirements-tts.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements-tts.txt \
    && rm -f /tmp/requirements-tts.txt

RUN groupadd --gid 10001 rf \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash rf \
    && ln -sf "$(find /ms-playwright -path '*/chrome-linux64/chrome' | head -n 1)" /usr/local/bin/chromium

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HYPERFRAMES_BROWSER_PATH=/usr/local/bin/chromium \
    HYPERFRAMES_NO_TELEMETRY=1 \
    TTS_PYTHON=/opt/venv/bin/python \
    SCRATCH_DIR=/scratch \
    HOME=/home/rf \
    XDG_CACHE_HOME=/scratch/.cache

WORKDIR /app
COPY ai-service/package.json ai-service/package-lock.json /app/ai-service/
WORKDIR /app/ai-service
RUN npm ci --no-audit --no-fund

COPY ai-service/ /app/ai-service/
COPY proto/ /app/proto/
COPY deploy/llm_config.json /app/deploy/llm_config.json
RUN npm run build \
    && mkdir -p /scratch \
    && chown -R rf:rf /app /scratch /home/rf

COPY deploy/ai-service-entrypoint.sh /usr/local/bin/ai-service-entrypoint
RUN chmod 0755 /usr/local/bin/ai-service-entrypoint

USER 10001:10001
EXPOSE 50051

ENTRYPOINT ["/usr/local/bin/ai-service-entrypoint"]
