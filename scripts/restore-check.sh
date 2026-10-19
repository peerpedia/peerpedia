#!/bin/sh
# Restore into an isolated temporary database; never overwrite the live database.
set -eu
cd "$(dirname "$0")/.."
if [ "$#" -ne 1 ]; then echo "Usage: sh scripts/restore-check.sh backups/FILE.dump"; exit 1; fi
dump_path="$1"
restore_database="peerpedia_restore_check_$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
cleanup() { docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$1"' sh "$restore_database"; }
docker compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" "$1"' sh "$restore_database"
trap cleanup EXIT
docker compose exec -T db sh -c 'pg_restore --exit-on-error --no-owner -U "$POSTGRES_USER" -d "$1"' sh "$restore_database" < "$dump_path"
docker compose exec -T -e RESTORE_DATABASE="$restore_database" web python -c '
import os
from urllib.parse import urlsplit, urlunsplit
u = urlsplit(os.environ["DATABASE_URL"])
os.environ["DATABASE_URL"] = urlunsplit((u.scheme, u.netloc, "/" + os.environ["RESTORE_DATABASE"], u.query, u.fragment))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
import django
django.setup()
from django.core.management import call_command
call_command("verify_history")
'
echo "Restore and history verification passed in an isolated temporary database."
