FROM python:3.11-slim@sha256:90edbeb8e4efce8dfe102f24c5ea1c8a1d770ff3d99c9c565d89ec97145f0fea
WORKDIR /app
COPY delivery-service/requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir --require-hashes --only-binary=:all: -r requirements.txt && python -m pip check
COPY reel_organization.py PROVENANCE ./
COPY deployment-adapter/ ./
COPY delivery-service/app.py delivery-service/providers.py delivery-service/standalone_providers.py delivery-service/main.py ./
EXPOSE 8080
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "1", "--worker-class", "sync", "--timeout", "600", "--graceful-timeout", "30", "main:app"]
