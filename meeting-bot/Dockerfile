FROM mcr.microsoft.com/playwright/python:v1.64.1-noble@sha256:330d401ae23c905896a0c26c66c36fc971b621519e7b11b435a8328d7bf6e031
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 DISPLAY=:99 \
    OMP_NUM_THREADS=2
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg pulseaudio pulseaudio-utils xvfb tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY policy.py providers.py worker.py google_auth.py captions.py browser_captions.py ./
RUN chown -R pwuser:pwuser /app
USER pwuser
ENTRYPOINT ["tini", "--", "python", "/app/worker.py"]
