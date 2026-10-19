import json
import uuid
from datetime import timedelta
from django.db import DatabaseError, transaction
from django.test import TestCase, Client, override_settings
from django.urls import reverse
from django.utils import timezone
from accounts.models import User
from accounts.tokens import issue_token
from .models import Passage, PassageComment, PassageCommentRevision, PassagePRLink, Submission, SubmissionSource, Notification, Review
from .passages import validate
from .services import publish, decide
from .notifications import notify
from .tests import document


@override_settings(PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'])
class FeedbackTests(TestCase):
    def setUp(self):
        self.owner=User.objects.create_user('owner','owner@example.org',email_verified=True)
        self.reader=User.objects.create_user('reader','reader@example.org',email_verified=True)
        self.third=User.objects.create_user('third','third@example.org',email_verified=True)
        self.paper=publish(self.owner,document())
        self.base=self.paper.current
        spans,quote,key=validate(self.base.markdown,[{'block':'b1','start':0,'end':11}])
        self.anchor=Passage.objects.create(submission=self.base,spans=spans,quote=quote,key=key)
        self.thread=PassageComment.objects.create(passage=self.anchor,user=self.reader,score=3,text='Explain this equation.')
        PassageCommentRevision.objects.create(comment=self.thread,number=1,text=self.thread.text,score=3)
        _,self.token=issue_token(self.third,'Tests')
        self.payload={**document(markdown='# A clearer paper\n'), 'paper_id':str(self.paper.pk),'base_hash':self.base.hash,
                      'discussion_ids':[str(self.thread.pk)],'ai_assisted':True}

    def push(self,data=None,key=None):
        return self.client.post('/api/v1/push/',json.dumps(data or self.payload),content_type='application/json',
                                HTTP_AUTHORIZATION='Bearer '+self.token,HTTP_IDEMPOTENCY_KEY=str(key or uuid.uuid4()))

    def post_comment(self,action,pk,data):
        return self.client.post(reverse('passage_'+action,args=[pk]),json.dumps(data),content_type='application/json')

    def test_public_read_only_endpoints_and_hidden_content(self):
        Review.objects.create(paper=self.paper,user=self.owner,score=4,text='Overall review.')
        self.client.force_login(self.reader)
        urls=[f'/api/v1/papers/{self.paper.pk}/feedback/',f'/api/v1/submissions/{self.base.pk}/feedback/',
              f'/api/v1/passages/{self.anchor.pk}/',f'/api/v1/discussion-comments/{self.thread.pk}/replies/',
              f'/api/v1/discussion-comments/{self.thread.pk}/history/',f'/api/v1/papers/{self.paper.pk}/reviews/']
        for url in urls:
            self.assertEqual(self.client.get(url).status_code,200)
            rejected=self.client.post(url,{},HTTP_AUTHORIZATION='Bearer '+self.token)
            self.assertEqual(rejected.status_code,405)
            self.assertEqual(rejected['Allow'],'GET')
        detail=self.client.get(urls[2]).json()
        self.assertFalse(detail['threads'][0]['can_edit'])
        self.assertEqual(detail['own_prs'],[])
        feedback=self.client.get(urls[0]).json()['passages'][0]
        self.assertEqual(feedback['original_hash'],self.base.hash)
        self.assertEqual(feedback['original_spans'],[{'block':'b1','kind':'text','start':0,'end':11}])
        self.thread.is_hidden=True;self.thread.save()
        self.assertEqual(self.client.get(urls[2]).json()['threads'][0]['text'],'Comment hidden by an administrator.')
        self.assertEqual(self.client.get(urls[4]).status_code,404)
        self.paper.is_hidden=True;self.paper.save()
        for url in urls:
            self.assertEqual(self.client.get(url).status_code,404)

    def test_linked_cli_snapshots_idempotency_attribution_and_acceptance(self):
        key=uuid.uuid4()
        first=self.push(key=key)
        self.assertEqual(first.status_code,201,first.content)
        self.assertEqual(self.push(key=key).json()['hash'],first.json()['hash'])
        record=first.json();pr=record['pull_request']['id']
        self.assertTrue(record['via_cli']);self.assertTrue(record['ai_assisted'])
        self.assertEqual(SubmissionSource.objects.count(),1)
        self.assertEqual(PassagePRLink.objects.count(),1)
        source=SubmissionSource.objects.get()
        self.assertEqual(source.submission.calculate_hash(),record['hash'])
        with self.assertRaises(DatabaseError),transaction.atomic():
            SubmissionSource.objects.filter(pk=source.pk).update(ai_assisted=False)
        next_payload={**self.payload,'pull_request_id':pr,'expected_head':record['hash'],'markdown':'# Another frozen snapshot\n'}
        second=self.push(next_payload)
        self.assertEqual(second.status_code,201,second.content)
        self.assertEqual(second.json()['pull_request'],{'id':pr,'snapshot':2})
        self.assertEqual(self.push(next_payload).status_code,409)
        self.assertEqual(Submission.objects.count(),3)
        self.assertEqual(SubmissionSource.objects.count(),2)
        pr_info=self.client.get(f'/api/v1/prs/{pr}/').json()
        self.assertEqual(pr_info['head_hash'],second.json()['hash'])
        self.assertEqual(pr_info['discussion_ids'],[str(self.thread.pk)])
        self.assertEqual(len(pr_info['snapshots']),2)
        before=Notification.objects.get(user=self.owner,kind='proposal')
        self.assertEqual(before.count,2)
        self.assertTrue(Notification.objects.filter(user=self.reader,kind='linked_fix').exists())
        decide(self.owner,second.json()['manifest']['submission_id'],'accepted')
        self.assertTrue(Notification.objects.filter(user=self.reader,kind='decision').exists())
        self.thread.refresh_from_db();self.assertFalse(self.thread.resolved)
        # Retrying the old key after acceptance still returns the same frozen receipt.
        self.assertEqual(self.push(key=key).json()['hash'],record['hash'])

    def test_invalid_links_and_flags_create_nothing(self):
        for change in [{'discussion_ids':[str(uuid.uuid4())]},{'discussion_ids':['invalid']},
                       {'ai_assisted':'yes'},{'expected_head':'0'*64},{'discussion_ids':[str(self.thread.pk)]*2}]:
            response=self.push({**self.payload,**change})
            self.assertEqual(response.status_code,400,response.content)
        self.assertEqual(Submission.objects.count(),1)
        self.assertEqual(SubmissionSource.objects.count(),0)
        self.assertEqual(Notification.objects.count(),0)
        foreign=publish(self.reader,document())
        self.assertEqual(self.push({**self.payload,'paper_id':str(foreign.pk),'base_hash':foreign.current.hash}).status_code,400)

    def test_notification_grouping_ownership_read_races_and_hidden_papers(self):
        notify([self.reader.pk,self.owner.pk],self.owner,self.paper,'reply',thread=self.thread)
        item=Notification.objects.get()
        self.assertEqual(item.user,self.reader)
        self.client.force_login(self.third)
        self.assertEqual(self.client.post(reverse('inbox_open',args=[item.pk]),{'revision':1}).status_code,404)
        self.client.force_login(self.reader)
        page=self.client.get(reverse('inbox'))
        self.assertContains(page,'Inbox, 1 unread')
        cutoff=page.context['seen_before']
        notify([self.reader.pk],self.owner,self.paper,'reply',thread=self.thread)
        self.client.post(reverse('inbox_open',args=[item.pk]),{'revision':1})
        item.refresh_from_db();self.assertTrue(item.unread);self.assertEqual(item.count,2)
        self.client.post(reverse('inbox_read'),{'seen_before':cutoff})
        item.refresh_from_db();self.assertTrue(item.unread)
        self.assertEqual(self.client.get(reverse('inbox_open',args=[item.pk])).status_code,405)
        response=self.client.post(reverse('inbox_open',args=[item.pk]),{'revision':item.revision})
        self.assertIn('?discussion=',response.url)
        item.refresh_from_db();self.assertFalse(item.unread)
        notify([self.reader.pk],self.owner,self.paper,'reply',thread=self.thread)
        item.refresh_from_db();self.assertEqual(item.count,1)
        self.client.post(reverse('inbox_read'),{'seen_before':timezone.now().isoformat()})
        item.refresh_from_db();self.assertFalse(item.unread)
        self.assertEqual(self.client.post(reverse('inbox_read'),{'seen_before':(timezone.now()+timedelta(days=1)).isoformat()}).status_code,400)
        self.paper.is_hidden=True;self.paper.save()
        self.assertNotContains(self.client.get(reverse('inbox')),'A test paper')
        self.assertEqual(self.client.get(reverse('inbox')).context['unread_notifications'],0)

    def test_notification_triggers_and_no_self_or_duplicate_vote_alerts(self):
        self.client.force_login(self.owner)
        reply=self.post_comment('reply',self.thread.pk,{'text':'Here is an explanation.'})
        self.assertEqual(reply.status_code,201)
        self.assertTrue(Notification.objects.filter(user=self.reader,kind='reply').exists())
        self.assertFalse(Notification.objects.filter(user=self.owner).exists())
        self.post_comment('vote',self.thread.pk,{'value':1})
        self.post_comment('vote',self.thread.pk,{'value':1})
        self.assertEqual(Notification.objects.get(user=self.reader,kind='vote').count,1)
        self.client.force_login(self.reader)
        self.post_comment('resolve',self.thread.pk,{'resolved':True})
        self.assertTrue(Notification.objects.filter(user=self.owner,kind='resolved').exists())
        self.assertFalse(Notification.objects.filter(user=self.reader,kind='resolved').exists())
        strict=Client(enforce_csrf_checks=True);strict.force_login(self.reader)
        self.assertEqual(strict.post(reverse('inbox_read'),{'seen_before':timezone.now().isoformat()}).status_code,403)

    def test_report_alert_is_staff_only_and_inbox_not_exposed_to_tokens(self):
        self.owner.is_staff=True;self.owner.save()
        self.client.force_login(self.third)
        self.post_comment('report',self.thread.pk,{'reason':'Please review.'})
        alert=Notification.objects.get(kind='report')
        self.assertEqual(alert.user,self.owner)
        self.client.logout()
        self.assertEqual(self.client.get(reverse('inbox'),HTTP_AUTHORIZATION='Bearer '+self.token).status_code,302)
        self.client.force_login(self.owner)
        self.owner.is_staff=False;self.owner.save()
        self.assertNotContains(self.client.get(reverse('inbox')),'A comment needs moderation')
        self.assertEqual(self.client.post(reverse('inbox_open',args=[alert.pk]),{'revision':1}).status_code,404)
