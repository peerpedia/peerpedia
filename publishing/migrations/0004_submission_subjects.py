from importlib import import_module
from django.db import migrations, models


# SQLite table rebuilds discard triggers. Restore all existing history guards
# and the PostgreSQL search index after this additive schema change.
history = import_module("publishing.migrations.0002_immutable_history")


def category_index(apps, schema_editor):
    if schema_editor.connection.vendor == "postgresql":
        schema_editor.execute("CREATE INDEX submission_secondary_categories_idx ON publishing_submission USING gin (secondary_categories)")


def remove_category_index(apps, schema_editor):
    if schema_editor.connection.vendor == "postgresql":
        schema_editor.execute("DROP INDEX IF EXISTS submission_secondary_categories_idx")


def prevent_history_loss(apps, schema_editor):
    from django.db.migrations.exceptions import IrreversibleError
    if apps.get_model("publishing", "Submission").objects.using(schema_editor.connection.alias).filter(manifest_version__gte=2).exists():
        raise IrreversibleError("Cannot remove subject fields after v2 submissions exist: their frozen manifests require these fields.")


class Migration(migrations.Migration):
    dependencies = [("publishing", "0003_apipush")]
    operations = [
        migrations.RunPython(history.unprotect, history.protect),
        migrations.AddField("submission", "manifest_version", models.PositiveSmallIntegerField(default=1, editable=False)),
        migrations.AddField("submission", "primary_category", models.CharField(max_length=32, blank=True, default="", db_index=True)),
        migrations.AddField("submission", "secondary_categories", models.JSONField(default=list, blank=True)),
        migrations.AlterField("submission", "manifest_version", models.PositiveSmallIntegerField(default=2, editable=False)),
        migrations.RunPython(history.protect, history.unprotect),
        migrations.RunPython(category_index, remove_category_index),
        migrations.RunPython(migrations.RunPython.noop, prevent_history_loss),
    ]
