FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.lock .
RUN pip install --no-cache-dir -r requirements.lock
COPY . .
RUN python scripts/fetch_mathjax.py \
    && DEBUG=0 SECRET_KEY=static-build-only-not-a-runtime-secret DATABASE_URL=postgresql://unused@localhost/unused python manage.py collectstatic --noinput \
    && useradd --create-home --uid 10001 peerpedia
USER peerpedia
EXPOSE 8000
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "2", "--threads", "2", "--timeout", "60", "--forwarded-allow-ips", "*", "--access-logfile", "-", "--error-logfile", "-"]
