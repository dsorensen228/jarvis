FROM python:3.8.10-slim-buster

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app

COPY apps/api/pyproject.toml apps/api/README.md ./
COPY apps/api/src ./src
RUN python -m pip install --no-cache-dir pip==25.0.1 && \
    python -m pip install --no-cache-dir .

EXPOSE 8000
CMD ["python", "-m", "jarvis_api"]
