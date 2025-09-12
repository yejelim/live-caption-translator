# Cloud Run compatible Dockerfile for the FastAPI backend
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# System deps: ffmpeg for audio transcoding
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source
COPY app ./app
COPY send_wav_ws.py ./send_wav_ws.py

# Cloud Run provides the port via $PORT (default to 8000 locally)
ENV PORT=8080
EXPOSE 8080

# Health endpoint exists at /health; Cloud Run doesn't use Dockerfile HEALTHCHECK,
# but keeping a curl check is harmless in other environments.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:${PORT}/health || exit 1

# Start uvicorn binding to $PORT
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
