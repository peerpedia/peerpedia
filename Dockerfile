FROM node:22-alpine AS editor-assets
WORKDIR /app/editor
COPY editor/package*.json ./
RUN npm ci --ignore-scripts
COPY editor/ ./
RUN npm run build

FROM python:3.13-slim AS web
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.lock .
RUN pip install --no-cache-dir -r requirements.lock
COPY . .
COPY --from=editor-assets /app/static/vendor/editor /app/static/vendor/editor
COPY --from=editor-assets /app/static/vendor/bananamark /app/static/vendor/bananamark
RUN DEBUG=0 SECRET_KEY=static-build-only-not-a-runtime-secret DATABASE_URL=postgresql://unused@localhost/unused python manage.py collectstatic --noinput \
    && useradd --create-home --uid 10001 peerpedia
USER peerpedia
EXPOSE 8000
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "2", "--threads", "2", "--timeout", "60", "--forwarded-allow-ips", "*", "--access-logfile", "-", "--error-logfile", "-"]

# No database credentials, host mounts, shell execution, or internet access at runtime.
FROM node:22-alpine AS content-renderer
WORKDIR /app/editor
COPY --from=editor-assets /app/editor /app/editor
RUN mkdir /cache && chown node:node /cache
ENV BANANAMARK_CACHE=/cache
USER node
CMD ["node", "render-server.mjs"]

FROM web AS app
