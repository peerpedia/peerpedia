from django.db import migrations


def forwards(apps, editor):
    Submission = apps.get_model('publishing', 'Submission')
    PR = apps.get_model('publishing', 'PullRequest')
    Commit = apps.get_model('publishing', 'PullRequestCommit')
    for submission in Submission.objects.filter(base__isnull=False).iterator():
        pr = PR.objects.create(paper_id=submission.paper_id, contributor_id=submission.contributor_id,
                               head_id=submission.pk, created_at=submission.created_at)
        Commit.objects.create(request=pr, submission_id=submission.pk, number=1)
    if editor.connection.vendor == 'postgresql':
        editor.execute('CREATE TRIGGER frozen_record BEFORE UPDATE OR DELETE ON publishing_pullrequestcommit FOR EACH ROW EXECUTE FUNCTION peerpedia_frozen_record()')
    elif editor.connection.vendor == 'sqlite':
        for op in ('UPDATE', 'DELETE'):
            editor.execute(f"CREATE TRIGGER publishing_pullrequestcommit_no_{op.lower()} BEFORE {op} ON publishing_pullrequestcommit BEGIN SELECT RAISE(ABORT, 'Historical records are immutable'); END")


def backwards(apps, editor):
    from django.db.migrations.exceptions import IrreversibleError
    alias = editor.connection.alias
    if apps.get_model('publishing', 'PullRequest').objects.using(alias).exists() or apps.get_model('publishing', 'Draft').objects.using(alias).exists():
        raise IrreversibleError('Cannot discard PR or private draft history. Restore a backup to roll back this feature.')
    if editor.connection.vendor == 'postgresql':
        editor.execute('DROP TRIGGER IF EXISTS frozen_record ON publishing_pullrequestcommit')
    elif editor.connection.vendor == 'sqlite':
        for op in ('update', 'delete'):
            editor.execute(f'DROP TRIGGER IF EXISTS publishing_pullrequestcommit_no_{op}')


class Migration(migrations.Migration):
    dependencies = [('publishing', '0005_pullrequest_draft_pullrequestcommit')]
    # Grouping is append-only history. Downgrades must not silently delete it.
    operations = [migrations.RunPython(forwards, backwards)]
