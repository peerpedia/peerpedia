#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups
destination="backups/peerpedia-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$destination.tmp"
mv "$destination.tmp" "$destination"
echo "Backup written to $destination. Copy it to storage outside this server."
