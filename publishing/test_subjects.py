import hashlib
import json
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import DatabaseError, transaction
from django.test import TestCase
from django.urls import reverse

from accounts.models import User
from accounts.tokens import issue_token
from cli.peerpedia_cli.main import ClientError, verify
from .forms import UploadForm
from .models import Paper, Submission, Review
from .services import publish, propose, decide
from .subjects import CATEGORIES, ALIASES
from .tests import document


class SubjectTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = User.objects.create_user('subjectowner', 'subjects@example.org', email_verified=True)
        cls.paper = publish(cls.owner, document(primary_category='cond-mat.str-el', secondary_categories=['hep-th']))

    def test_taxonomy_and_aliases(self):
        data = self.client.get('/api/v1/categories/').json()
        self.assertEqual(len(data['categories']), 155)
        self.assertEqual(CATEGORIES['cond-mat.str-el']['name'], 'Strongly Correlated Electrons')
        for alias, canonical in ALIASES.items():
            self.assertIn(alias, CATEGORIES)
            self.assertIn(canonical, CATEGORIES)

    def test_form_requires_primary_and_rejects_unknown_duplicate_aliases(self):
        for primary, secondary in [('', []), ('fiction', []), ('hep-th', ['not-a-category']),
                                   ('math.MP', ['math-ph']), ('hep-th', ['hep-th']),
                                   ('hep-th', ['cs.NA', 'math.NA'])]:
            with self.subTest(primary=primary, secondary=secondary):
                form = UploadForm(document(primary_category=primary, secondary_categories=secondary),
                                  {'file': SimpleUploadedFile('paper.md', b'# Test')}, initial_publication=True)
                self.assertFalse(form.is_valid())
        with self.assertRaises(ValidationError):
            publish(self.owner, document(primary_category='unknown'))

    def test_pending_classification_only_changes_browse_after_acceptance(self):
        change = propose(self.owner, self.paper.pk, self.paper.current_id,
                         document(primary_category='math.NT', secondary_categories=['math.GR']))
        self.assertEqual(self.client.get('/', {'subject': 'math.NT'}).context['page'].paginator.count, 0)
        response = self.client.get(reverse('submission', args=[change.pk]))
        self.assertContains(response, 'Primary subject')
        self.assertContains(response, 'Strongly Correlated Electrons')
        self.assertContains(response, 'Number Theory')
        decide(self.owner, change.pk, 'accepted')
        self.assertEqual(self.client.get('/', {'subject': 'math.GR'}).context['page'].paginator.count, 1)
        self.assertEqual(self.client.get('/', {'subject': 'cond-mat.str-el'}).context['page'].paginator.count, 0)
        self.assertEqual(self.paper.current.primary_category, 'cond-mat.str-el')
        self.assertEqual(self.paper.current.hash, self.paper.current.calculate_hash())

    def test_filters_include_cross_lists_archives_groups_aliases_and_hidden_rules(self):
        alias_paper = publish(self.owner, document(title='Alias paper', primary_category='math.MP'))
        for subject in ['cond-mat.str-el', 'hep-th', 'archive:Condensed Matter', 'group:Physics']:
            self.assertIn(self.paper, self.client.get('/', {'subject': subject}).context['page'])
        for subject in ['math-ph', 'math.MP']:
            self.assertIn(alias_paper, self.client.get('/', {'subject': subject}).context['page'])
        alias_paper.is_hidden = True
        alias_paper.save()
        self.assertEqual(self.client.get('/', {'subject': 'math-ph'}).context['page'].paginator.count, 0)
        self.assertEqual(self.client.get('/', {'subject': 'invented'}).status_code, 404)

    def test_subject_search_combines_with_query_rating_and_pagination(self):
        other = publish(self.owner, document(title='Another paper', primary_category='math.NT'))
        for query in ['cond-mat.str-el', 'Strongly Correlated Electrons', 'hep-th']:
            self.assertIn(self.paper, self.client.get('/', {'q': query}).context['page'])
        Review.objects.create(paper=self.paper, user=self.owner, score=5, text='Helpful')
        for i in range(25):
            publish(self.owner, document(title=f'More {i}', primary_category='cond-mat.str-el'))
        response = self.client.get('/', {'q': 'Ada', 'subject': 'cond-mat.str-el', 'sort': 'rating'})
        self.assertEqual(response.context['page'][0], self.paper)
        self.assertNotIn(other, response.context['page'])
        self.assertContains(response, 'subject=cond-mat.str-el&amp;sort=rating')
        self.assertEqual(self.client.get('/', {'q': 'Ada', 'subject': 'cond-mat.str-el', 'sort': 'rating', 'page': 2}).context['page'].paginator.count, 26)

    def test_subjects_are_hashed_and_database_frozen(self):
        current = self.paper.current
        record = {'hash': current.hash, 'manifest': current.manifest(), 'markdown': current.markdown}
        self.assertEqual(record['manifest']['format'], 'peerpedia-submission-v2')
        verify(record)
        record['manifest']['primary_category'] = 'math.NT'
        with self.assertRaises(ClientError):
            verify(record)
        with self.assertRaises(DatabaseError), transaction.atomic():
            Submission.objects.filter(pk=current.pk).update(primary_category='math.NT')
        with self.assertRaises(DatabaseError), transaction.atomic():
            Submission.objects.filter(pk=current.pk).update(secondary_categories=['math.NT'])

    def test_legacy_manifest_retains_exact_hash_and_can_gain_subjects(self):
        paper = Paper.objects.create(owner=self.owner)
        legacy = Submission.objects.create(paper=paper, contributor=self.owner, contributor_name=self.owner.username,
                                           manifest_version=1, **document(primary_category='', secondary_categories=[]))
        paper.current = legacy
        paper.save()
        manifest = legacy.manifest()
        self.assertNotIn('primary_category', manifest)
        self.assertEqual(manifest['format'], 'peerpedia-submission-v1')
        digest = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        self.assertEqual(digest, legacy.hash)
        verify({'hash': legacy.hash, 'manifest': manifest, 'markdown': legacy.markdown})
        self.assertIn(paper, self.client.get('/', {'subject': 'unclassified'}).context['page'])
        change = propose(self.owner, paper.pk, legacy.pk, document(primary_category='math.NT'))
        decide(self.owner, change.pk, 'accepted')
        legacy.refresh_from_db()
        self.assertEqual(legacy.hash, digest)
        self.assertEqual(legacy.manifest(), manifest)

    def test_api_missing_subjects_inherit_base_and_explicit_changes_are_frozen(self):
        _, raw = issue_token(self.owner, 'Subject tests', can_publish=True)
        import uuid
        def send(data, key=None):
            return self.client.post('/api/v1/push/', json.dumps(data), content_type='application/json',
                HTTP_AUTHORIZATION='Bearer '+raw, HTTP_IDEMPOTENCY_KEY=str(key or uuid.uuid4()))
        data = {**document(), 'paper_id': str(self.paper.pk), 'base_hash': self.paper.current.hash}
        data.pop('primary_category'); data.pop('secondary_categories')
        response = send(data)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()['manifest']['primary_category'], 'cond-mat.str-el')
        self.assertEqual(response.json()['manifest']['secondary_categories'], ['hep-th'])
        self.assertEqual(send({**data, 'paper_id': None, 'base_hash': None}).status_code, 400)
        key = uuid.uuid4()
        data.update(primary_category='math.GR', secondary_categories=['math.NT'])
        first, retry = send(data, key), send(data, key)
        self.assertEqual((first.status_code, retry.status_code), (201, 200))
        self.assertEqual(first.json()['hash'], retry.json()['hash'])
        self.assertEqual(first.json()['manifest']['secondary_categories'], ['math.NT'])
        self.assertEqual(send({**data, 'secondary_categories': ['hep-th']}, key).status_code, 409)
        for change in [{'primary_category': ''}, {'primary_category': []}, {'secondary_categories': 'math.NT'}, {'secondary_categories': [None]}]:
            self.assertEqual(send({**data, **change}).status_code, 400)

    def test_web_preview_confirmation_preserves_selected_subjects(self):
        self.client.force_login(self.owner)
        data = document(primary_category='hep-th', secondary_categories=['math-ph', 'cond-mat.str-el'])
        data['file'] = SimpleUploadedFile('paper.md', b'# Example')
        response = self.client.post(reverse('publish'), data)
        self.assertContains(response, 'High Energy Physics - Theory')
        token = response.context['token']
        self.client.post(reverse('publish'), {'action': 'confirm', 'token': token})
        created = Submission.objects.latest('created_at')
        self.assertEqual(created.primary_category, 'hep-th')
        self.assertEqual(created.secondary_categories, ['cond-mat.str-el', 'math-ph'])


# Run the real upgrade on PostgreSQL as well as the separate SQLite smoke check.
from unittest import skipUnless
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


@skipUnless(connection.vendor == 'postgresql', 'Schema-upgrade integration uses isolated PostgreSQL')
class SubjectMigrationTests(TransactionTestCase):
    def test_populated_v1_upgrade_preserves_hash_and_guards(self):
        before = [('publishing', '0003_apipush')]
        after = [('publishing', '0009_submissionsource_notification')]
        executor = MigrationExecutor(connection)
        executor.migrate(before)
        try:
            apps = executor.loader.project_state(before).apps
            Owner = apps.get_model('accounts', 'User')
            OldPaper = apps.get_model('publishing', 'Paper')
            OldSubmission = apps.get_model('publishing', 'Submission')
            user = Owner.objects.create(username='oldowner', email='old@example.org', password='!')
            paper = OldPaper.objects.create(owner_id=user.pk)
            data = document(); data.pop('primary_category'); data.pop('secondary_categories')
            old = OldSubmission(paper_id=paper.pk, contributor_id=user.pk, contributor_name=user.username, **data)
            manifest = {'format': 'peerpedia-submission-v1', 'submission_id': str(old.pk), 'paper_id': str(paper.pk),
                        'contributor_id': user.pk, 'contributor_name': user.username, 'base_hash': None,
                        'title': old.title, 'authors': old.authors, 'abstract': old.abstract,
                        'markdown_sha256': hashlib.sha256(old.markdown.encode()).hexdigest(),
                        'explanation': old.explanation, 'submitted_at': old.created_at.isoformat()}
            old.hash = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
            old.save()
            paper.current_id = old.pk; paper.save()
        finally:
            MigrationExecutor(connection).migrate(after)
        upgraded = Submission.objects.get(pk=old.pk)
        self.assertEqual(upgraded.manifest(), manifest)
        self.assertEqual(upgraded.hash, upgraded.calculate_hash())
        self.assertEqual(upgraded.manifest_version, 1)
        with self.assertRaises(DatabaseError), transaction.atomic():
            Submission.objects.filter(pk=old.pk).update(primary_category='math.NT')

    def test_downgrade_cannot_destroy_classified_history(self):
        from django.db.migrations.exceptions import IrreversibleError
        owner = User.objects.create_user('downgradecheck', email_verified=True)
        paper = publish(owner, document())
        with self.assertRaises(IrreversibleError):
            MigrationExecutor(connection).migrate([('publishing', '0003_apipush')])
        paper.current.refresh_from_db()
        self.assertEqual(paper.current.calculate_hash(), paper.current.hash)
