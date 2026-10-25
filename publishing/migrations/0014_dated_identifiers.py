"""Replace test-era monthly aliases and label every existing frozen snapshot."""
from datetime import timezone
from importlib import import_module
from django.db import migrations, models

paper_identity = import_module("publishing.migrations.0013_paper_public_id")


def unprotect(apps, editor):
    paper_identity.unprotect(apps, editor)
    if editor.connection.vendor == "postgresql":
        editor.execute("DROP TRIGGER IF EXISTS frozen_record ON publishing_submission")
    elif editor.connection.vendor == "sqlite":
        for operation in ("update", "delete"):
            editor.execute(f"DROP TRIGGER IF EXISTS publishing_submission_no_{operation}")


def protect(apps, editor):
    paper_identity.protect(apps, editor)
    if editor.connection.vendor == "postgresql":
        editor.execute("CREATE TRIGGER frozen_record BEFORE UPDATE OR DELETE ON publishing_submission FOR EACH ROW EXECUTE FUNCTION peerpedia_frozen_record()")
    elif editor.connection.vendor == "sqlite":
        for operation in ("UPDATE", "DELETE"):
            editor.execute(f"CREATE TRIGGER publishing_submission_no_{operation.lower()} BEFORE {operation} ON publishing_submission BEGIN SELECT RAISE(ABORT, 'Historical records are immutable'); END")


def allocate(model, alias, pk, digest, timestamp, fmt="%y%m%d"):
    prefix = timestamp.astimezone(timezone.utc).strftime(fmt)
    for length in range(12, 65, 2):
        code = f"{prefix}.{digest[:length]}"
        if not model.objects.using(alias).filter(public_id=code).exclude(pk=pk).exists():
            model.objects.using(alias).filter(pk=pk).update(public_id=code)
            return
    raise RuntimeError("Could not allocate a unique public identifier")


def papers(apps, editor, fmt):
    Paper = apps.get_model("publishing", "Paper")
    Submission = apps.get_model("publishing", "Submission")
    alias = editor.connection.alias
    for paper in Paper.objects.using(alias).filter(current__isnull=False).order_by("created_at", "pk").iterator():
        first = Submission.objects.using(alias).filter(paper_id=paper.pk, decision__action="accepted").order_by("decision__created_at", "pk").values_list("hash", "decision__created_at").first()
        if first:
            allocate(Paper, alias, paper.pk, *first, fmt=fmt)


def forwards(apps, editor):
    Submission = apps.get_model("publishing", "Submission")
    alias = editor.connection.alias
    for pk, digest, created_at in Submission.objects.using(alias).order_by("created_at", "pk").values_list("pk", "hash", "created_at").iterator():
        allocate(Submission, alias, pk, digest, created_at)
    papers(apps, editor, "%y%m%d")


def backwards(apps, editor):
    papers(apps, editor, "%y%m")


class Migration(migrations.Migration):
    dependencies = [("publishing", "0013_paper_public_id")]
    operations = [
        migrations.RunPython(unprotect, protect),
        migrations.AlterField(model_name="paper", name="public_id", field=models.CharField(max_length=71, unique=True, null=True, editable=False)),
        migrations.AddField(model_name="submission", name="public_id", field=models.CharField(max_length=71, unique=True, null=True, editable=False)),
        migrations.RunPython(forwards, backwards),
        migrations.AlterField(model_name="submission", name="public_id", field=models.CharField(max_length=71, unique=True, editable=False)),
        migrations.RunPython(protect, unprotect),
    ]
