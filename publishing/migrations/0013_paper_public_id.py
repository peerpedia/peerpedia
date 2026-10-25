from datetime import timezone
from django.db import migrations, models


def backfill(apps, editor):
    Paper = apps.get_model("publishing", "Paper")
    Submission = apps.get_model("publishing", "Submission")
    alias = editor.connection.alias
    for paper in (
        Paper.objects.using(alias)
        .filter(current__isnull=False)
        .order_by("created_at", "pk")
        .iterator()
    ):
        first = (
            Submission.objects.using(alias)
            .filter(paper_id=paper.pk, decision__action="accepted")
            .order_by("decision__created_at", "pk")
            .values_list("hash", "decision__created_at")
            .first()
        )
        if first is None:
            continue
        digest, published_at = first
        prefix = published_at.astimezone(timezone.utc).strftime("%y%m")
        for length in range(12, 65, 2):
            value = f"{prefix}.{digest[:length]}"
            if not Paper.objects.using(alias).filter(public_id=value).exists():
                Paper.objects.using(alias).filter(pk=paper.pk).update(public_id=value)
                break
        else:
            raise RuntimeError("Could not allocate a unique paper identifier")


def protect(apps, editor):
    if editor.connection.vendor == "postgresql":
        editor.execute("""
            CREATE FUNCTION peerpedia_paper_identity() RETURNS trigger AS $$
            BEGIN
                IF OLD.public_id IS NOT NULL AND NEW.public_id IS DISTINCT FROM OLD.public_id THEN
                    RAISE EXCEPTION 'Published paper identifiers are immutable';
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
            CREATE TRIGGER paper_identity BEFORE UPDATE ON publishing_paper
            FOR EACH ROW EXECUTE FUNCTION peerpedia_paper_identity();
        """)
    elif editor.connection.vendor == "sqlite":
        editor.execute("""
            CREATE TRIGGER paper_identity BEFORE UPDATE OF public_id ON publishing_paper
            WHEN OLD.public_id IS NOT NULL AND NEW.public_id IS NOT OLD.public_id
            BEGIN SELECT RAISE(ABORT, 'Published paper identifiers are immutable'); END
        """)


def unprotect(apps, editor):
    if editor.connection.vendor == "postgresql":
        editor.execute("DROP TRIGGER IF EXISTS paper_identity ON publishing_paper")
        editor.execute("DROP FUNCTION IF EXISTS peerpedia_paper_identity()")
    elif editor.connection.vendor == "sqlite":
        editor.execute("DROP TRIGGER IF EXISTS paper_identity")


class Migration(migrations.Migration):
    dependencies = [("publishing", "0012_draft_bibliography_draft_chapters_and_more")]
    operations = [
        migrations.AddField(
            model_name="paper",
            name="public_id",
            field=models.CharField(max_length=69, unique=True, null=True, editable=False),
        ),
        migrations.RunPython(backfill, migrations.RunPython.noop),
        migrations.RunPython(protect, unprotect),
    ]
