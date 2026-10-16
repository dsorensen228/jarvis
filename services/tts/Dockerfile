FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1
WORKDIR /service

COPY requirements.txt .
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY app.py .

EXPOSE 8092
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8092"]

