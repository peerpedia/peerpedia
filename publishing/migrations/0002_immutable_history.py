from django.db import migrations

TABLES = ("publishing_submission", "publishing_decision", "publishing_moderationevent")


def protect(apps, schema_editor):
    vendor = schema_editor.connection.vendor
    if vendor == "postgresql":
        schema_editor.execute("""
            CREATE FUNCTION peerpedia_frozen_record() RETURNS trigger AS $$
            BEGIN RAISE EXCEPTION 'Historical records are immutable'; END;
            $$ LANGUAGE plpgsql;
        """)
        for table in TABLES:
            schema_editor.execute(f"CREATE TRIGGER frozen_record BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION peerpedia_frozen_record()")
        schema_editor.execute("""
            CREATE INDEX submission_search_idx ON publishing_submission USING gin
            (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(authors, '') || ' ' || coalesce(abstract, '') || ' ' || coalesce(markdown, '')))
        """)
    elif vendor == "sqlite":
        for table in TABLES:
            for operation in ("UPDATE", "DELETE"):
                schema_editor.execute(f"CREATE TRIGGER {table}_no_{operation.lower()} BEFORE {operation} ON {table} BEGIN SELECT RAISE(ABORT, 'Historical records are immutable'); END")


def unprotect(apps, schema_editor):
    if schema_editor.connection.vendor == "postgresql":
        for table in TABLES:
            schema_editor.execute(f"DROP TRIGGER IF EXISTS frozen_record ON {table}")
        schema_editor.execute("DROP FUNCTION IF EXISTS peerpedia_frozen_record()")
        schema_editor.execute("DROP INDEX IF EXISTS submission_search_idx")
    elif schema_editor.connection.vendor == "sqlite":
        for table in TABLES:
            for operation in ("update", "delete"):
                schema_editor.execute(f"DROP TRIGGER IF EXISTS {table}_no_{operation}")


class Migration(migrations.Migration):
    dependencies = [("publishing", "0001_initial")]
    operations = [migrations.RunPython(protect, unprotect)]
