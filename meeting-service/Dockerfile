FROM python:3.11-slim@sha256:90edbeb8e4efce8dfe102f24c5ea1c8a1d770ff3d99c9c565d89ec97145f0fea
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY delivery-service/requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir --require-hashes --only-binary=:all: -r requirements.txt \
    && python -m pip check
COPY reel_organization.py PROVENANCE ./
COPY deployment-adapter/ ./
COPY meeting-service/app.py meeting-service/speech.py meeting-service/calendar_meetings.py meeting-service/calendar_runtime.py meeting-service/public_calendar_oauth.py meeting-service/cloud_processing.py meeting-service/speaker_alignment.py ./
COPY canonical_delivery/ ./canonical_delivery/
EXPOSE 8080
CMD exec gunicorn --bind :${PORT} --workers 1 --threads 8 --timeout 600 app:app
