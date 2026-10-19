#!/bin/sh
# Only complete dumps get a public filename. Partial files are never replicated.
set -eu
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups
exec 9>backups/.backup.lock
flock -n 9
pending=$(mktemp backups/.pending.XXXXXX)
trap 'rm -f "$pending"' EXIT
stamp=$(date -u +%Y%m%dT%H%M%SZ)
destination="backups/peerpedia-$stamp.dump"
# A manual backup in the same second must not overwrite an earlier snapshot.
if [ -e "$destination" ]; then echo 'A backup already exists for this second.' >&2; exit 1; fi
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$pending"
mv "$pending" "$destination"
sha256sum "$destination" > "$destination.sha256"
printf '%s\n' "$destination"
