from django.apps.registry import Apps
from django.db import migrations
from django.db.backends.base.schema import BaseDatabaseSchemaEditor
from django.db.models import F


def move_verification(apps: Apps, schema_editor: BaseDatabaseSchemaEditor) -> None:
    alias = schema_editor.connection.alias
    users = apps.get_model("accounts", "User").objects.using(alias)
    addresses = apps.get_model("account", "EmailAddress").objects.using(alias)
    # Peerpedia grants publishing rights only for the user's current email. An old
    # Google address can no longer reserve that address for its former owner.
    addresses.exclude(email__iexact=F("user__email")).update(verified=False, primary=False)
    for user in users.exclude(email="").iterator():
        email = user.email.lower()
        matching = addresses.filter(user_id=user.pk, email__iexact=email)
        rows = list(matching.order_by("pk"))
        if rows:
            # Reuse allauth's canonical row where possible. Old imports may contain
            # spelling variants even though normal Google signup writes lowercase.
            address = next((row for row in rows if row.email == email), rows[0])
            if len(rows) > 1:
                matching.exclude(pk=address.pk).update(verified=False, primary=False)
            addresses.filter(pk=address.pk).update(
                email=email, primary=True, verified=user.email_verified
            )
        else:
            addresses.create(
                user_id=user.pk, email=email, primary=True, verified=user.email_verified
            )


def restore_verification(apps: Apps, schema_editor: BaseDatabaseSchemaEditor) -> None:
    alias = schema_editor.connection.alias
    users = apps.get_model("accounts", "User").objects.using(alias)
    addresses = apps.get_model("account", "EmailAddress").objects.using(alias)
    verified = addresses.filter(verified=True, email__iexact=F("user__email")).values("user_id")
    users.filter(pk__in=verified).update(email_verified=True)


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0002_accesstoken"),
        ("account", "0009_emailaddress_unique_primary_email"),
    ]
    operations = [
        migrations.RunPython(move_verification, restore_verification),
        migrations.RemoveField(model_name="user", name="email_verified"),
    ]
