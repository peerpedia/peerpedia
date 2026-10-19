"""Reading discussions use verified browser sessions. Tool credentials cannot write."""
import json
from functools import wraps
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Count, Q
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.urls import reverse
from django.views.decorators.http import require_GET, require_POST
from accounts.security import limited
from .models import (Paper, Submission, Passage, PassageComment, PassageCommentRevision,
                     PassageVote, PassageReport, PassagePRLink, PullRequest, PullRequestCommit)
from . import passages
from .notifications import discussion_activity, notify, link_activity


def private_response(view):
    @wraps(view)
    def wrapper(request, *args, **kwargs):
        response = view(request, *args, **kwargs)
        response['Cache-Control'] = 'private, no-store'
        response['Vary'] = 'Cookie'
        return response
    return wrapper


def browser_write(view):
    @wraps(view)
    def wrapper(request, *args, **kwargs):
        if request.headers.get('Authorization') or not request.user.is_authenticated:
            return JsonResponse({'error':'Sign in on the website to participate. CLI/API access to discussions is read-only.'}, status=403)
        if not request.user.is_active or not request.user.email_verified:
            return JsonResponse({'error':'Verify your email before participating.'}, status=403)
        try:
            data = json.loads(request.body)
            if not isinstance(data, dict):
                raise ValueError()
            json.dumps(data, ensure_ascii=False).encode('utf-8')
            return view(request, data, *args, **kwargs)
        except (ValueError, UnicodeError, TypeError):
            return JsonResponse({'error':'Invalid request.'}, status=400)
        except ValidationError as error:
            return JsonResponse({'error':' '.join(error.messages)}, status=400)
    return private_response(require_POST(limited('passage_write', limit=100, seconds=60)(wrapper)))


def visible_submission(pk):
    return get_object_or_404(Submission.objects.select_related('paper'), pk=pk, paper__is_hidden=False)


def visible_comment(pk, lock=False):
    query = PassageComment.objects.select_for_update(of=('self',)) if lock else PassageComment.objects
    return get_object_or_404(query.select_related('user','passage__submission__paper','parent__user'), pk=pk, passage__submission__paper__is_hidden=False)


def lineage(submission):
    """Accepted ancestry and earlier snapshots in the same PR, never unrelated PRs."""
    rows = list(Submission.objects.filter(paper_id=submission.paper_id).values_list('pk','base_id'))
    bases = dict(rows)
    ids, at = set(), submission.pk
    while at and at not in ids:
        ids.add(at)
        at = bases.get(at)
    commits = list(PullRequestCommit.objects.filter(submission_id__in=ids).values_list('request_id','number'))
    for pr, number in commits:
        ids.update(PullRequestCommit.objects.filter(request_id=pr, number__lte=number).values_list('submission_id',flat=True))
    return ids


def anchors_for(submission):
    return Passage.objects.filter(submission_id__in=lineage(submission)).select_related('submission').order_by('created_at','pk')


def mapping(anchor, submission, blocks):
    return passages.locate(anchor, blocks, anchor.submission_id == submission.pk)


def stats(anchor):
    roots = anchor.comments.filter(parent__isnull=True, is_hidden=False, is_deleted=False)
    scores = list(roots.values_list('score',flat=True))
    return {'count':anchor.comments.count(), 'ratings':len(scores),
            'average':round(sum(scores)/len(scores),2) if scores else None}


def anchor_data(anchor, submission, blocks):
    state, spans = mapping(anchor, submission, blocks)
    summary = stats(anchor)
    if state != 'current':
        summary.update(historical_average=summary['average'], historical_ratings=summary['ratings'], average=None, ratings=0)
    return {'id':str(anchor.pk), 'quote':anchor.quote, 'state':state, 'spans':spans,
            'original_version':anchor.submission.short_hash, 'original_hash':anchor.submission.hash,
            'original_submission_id':str(anchor.submission_id),
            'original_spans':[{'block':s['id'],'kind':s['kind'],'start':s['start'],'end':s['end']} for s in anchor.spans],
            'original_url':reverse('read_submission', args=[anchor.submission_id]) + '?discussion=' + str(anchor.pk),
            **summary}


def offset(request):
    try:
        return min(1_000_000, max(0, int(request.GET.get('offset',0))))
    except ValueError:
        return 0


@private_response
@require_GET
def index(request, submission_id):
    submission = visible_submission(submission_id)
    blocks = passages.blocks(submission.markdown)
    start = offset(request)
    query = anchors_for(submission)
    rows = list(query[start:start+101])
    return JsonResponse({'passages':[anchor_data(a,submission,blocks) for a in rows[:100]],
                         'next':start+100 if len(rows)>100 else None})


def vote_query(query):
    return query.select_related('user','parent__user').annotate(
        up=Count('votes',filter=Q(votes__value=1)), down=Count('votes',filter=Q(votes__value=-1)))


def comment_data(comment, user):
    own = user.is_authenticated and comment.user_id == user.pk
    unavailable = comment.is_hidden or comment.is_deleted
    return {'id':str(comment.pk),'parent':str(comment.parent_id) if comment.parent_id else None,
            'root':str(comment.root_id or comment.pk),'depth':comment.depth,
            'author':comment.user.username,'reply_to':comment.parent.user.username if comment.parent_id else None,
            'text':'Comment hidden by an administrator.' if comment.is_hidden else 'Comment deleted.' if comment.is_deleted else comment.text,
            'score':None if unavailable else comment.score, 'revision':comment.revision,
            'edited':comment.revision>1,'created':comment.created_at.isoformat(),
            'up':0 if unavailable else comment.up,'down':0 if unavailable else comment.down,
            'vote':(PassageVote.objects.filter(comment=comment,user=user).values_list('value',flat=True).first() or 0) if user.is_authenticated and not unavailable else 0,
            'unavailable':unavailable,'can_edit':own and not unavailable,
            'can_resolve':own and not comment.parent_id and not unavailable,
            'resolved':comment.resolved}


def links_for(comment):
    return [{'id':str(link.pull_request_id), 'url':reverse('pull_request',args=[link.pull_request_id]),
             'label':link.pull_request.head.explanation[:160], 'status':link.pull_request.head.status}
            for link in comment.linked_prs.select_related('pull_request__head__decision')]


@private_response
@require_GET
def detail(request, passage_id):
    anchor = get_object_or_404(Passage.objects.select_related('submission'), pk=passage_id, submission__paper__is_hidden=False)
    roots = list(vote_query(anchor.comments.filter(parent__isnull=True)))
    roots.sort(key=lambda c: ((c.up-c.down)/(c.up+c.down+3) if not(c.is_hidden or c.is_deleted) else -2,c.created_at,str(c.pk)), reverse=True)
    start = offset(request)
    result = []
    for c in roots[start:start+10]:
        row = comment_data(c,request.user)
        row['links'] = links_for(c)
        row['state'] = 'Resolved' if c.resolved else 'Change accepted — awaiting commenter review' if any(l['status']=='accepted' for l in row['links']) else 'Open'
        replies = list(vote_query(c.descendants.all())[:31])
        row['replies'] = [comment_data(r,request.user) for r in replies[:30]]
        row['next_replies'] = 30 if len(replies)>30 else None
        result.append(row)
    own_prs = PullRequest.objects.filter(paper_id=anchor.submission.paper_id, contributor=request.user).select_related('head') if request.user.is_authenticated else []
    return JsonResponse({'quote':anchor.quote,'threads':result,'next':start+10 if len(roots)>start+10 else None,
                         'own_rating':anchor.comments.filter(user=request.user,parent__isnull=True,is_deleted=False).exists() if request.user.is_authenticated else False,
                         'own_prs':[{'id':str(p.pk),'label':p.head.explanation[:120]} for p in own_prs],**stats(anchor)})


@private_response
@require_GET
def replies(request, comment_id):
    root = visible_comment(comment_id)
    if root.parent_id:
        return JsonResponse({'error':'Choose a top-level discussion.'},status=400)
    start = offset(request)
    rows = list(vote_query(root.descendants.all())[start:start+101])
    return JsonResponse({'replies':[comment_data(c,request.user) for c in rows[:100]],'next':start+100 if len(rows)>100 else None})


def text_value(data, name='text', limit=5000):
    text = data.get(name)
    if not isinstance(text,str) or not text.strip() or len(text)>limit:
        raise ValidationError(f'Write between 1 and {limit} characters.')
    return text.strip()


def score_value(data):
    score = data.get('score')
    if type(score) is not int or not 1 <= score <= 5:
        raise ValidationError('Choose a rating from 1 to 5 and explain it in your comment.')
    return score


def record(comment):
    PassageCommentRevision.objects.create(comment=comment,number=comment.revision,text=comment.text,
                                          score=comment.score,is_deleted=comment.is_deleted)


@browser_write
def create(request, data, submission_id):
    submission = visible_submission(submission_id)
    selected, quote, key = passages.validate(submission.markdown,data.get('spans'))
    text, score = text_value(data), score_value(data)
    canonical = [{'block':s['id'],'start':s['start'],'end':s['end']} for s in selected]
    with transaction.atomic():
        # Serialize canonical-anchor creation across users and inherited versions.
        Paper.objects.select_for_update().get(pk=submission.paper_id)
        available = passages.blocks(submission.markdown)
        anchor = None
        for candidate in anchors_for(submission):
            state, spans = mapping(candidate,submission,available)
            if state == 'current' and spans == canonical:
                anchor = candidate
                break
        if anchor is None:
            anchor, _ = Passage.objects.get_or_create(submission=submission,key=key,defaults={'spans':selected,'quote':quote})
        if anchor.comments.filter(user=request.user,parent__isnull=True,is_deleted=False).exists():
            return JsonResponse({'error':'You already rated this passage. Edit your existing discussion or reply to it.', 'passage':str(anchor.pk)},status=409)
        comment = PassageComment.objects.create(passage=anchor,user=request.user,text=text,score=score)
        record(comment)
        discussion_activity(comment,request.user,'passage')
    return JsonResponse({'passage':str(anchor.pk),'comment':str(comment.pk)},status=201)


@browser_write
def reply(request, data, comment_id):
    with transaction.atomic():
        parent = visible_comment(comment_id,lock=True)
        comment = PassageComment.objects.create(passage=parent.passage,user=request.user,parent=parent,
            root_id=parent.root_id or parent.pk,depth=parent.depth+1,text=text_value(data))
        record(comment)
        discussion_activity(comment,request.user,'reply')
    return JsonResponse({'comment':str(comment.pk),'passage':str(parent.passage_id)},status=201)


@browser_write
def edit(request, data, comment_id):
    with transaction.atomic():
        comment = visible_comment(comment_id,lock=True)
        if comment.user_id != request.user.pk or comment.is_hidden or comment.is_deleted:
            return JsonResponse({'error':'Only the author can edit this visible comment.'},status=403)
        if type(data.get('revision')) is not int or data['revision'] != comment.revision:
            return JsonResponse({'error':'This comment changed elsewhere. Reopen it before editing.'},status=409)
        deleting = data.get('delete') is True
        comment.text = '' if deleting else text_value(data)
        if not deleting and not comment.parent_id:
            comment.score = score_value(data)
        comment.is_deleted = deleting
        comment.revision += 1
        comment.save(update_fields=['text','score','is_deleted','revision','updated_at'])
        record(comment)
        if not deleting:
            discussion_activity(comment,request.user,'edit')
    return JsonResponse({'ok':True})


@private_response
@require_GET
def history(request, comment_id):
    comment = visible_comment(comment_id)
    if comment.is_hidden or comment.is_deleted:
        return JsonResponse({'error':'This comment is unavailable.'},status=404)
    start = offset(request)
    rows = list(comment.history.order_by('-number').values('number','text','score','created_at')[start:start+51])
    return JsonResponse({'revisions':rows[:50],'next':start+50 if len(rows)>50 else None})


@browser_write
def vote(request, data, comment_id):
    value = data.get('value')
    if type(value) is not int or value not in (-1,0,1):
        raise ValidationError('Choose thumbs-up, thumbs-down, or remove your vote.')
    with transaction.atomic():
        comment = visible_comment(comment_id,lock=True)
        if comment.is_hidden or comment.is_deleted:
            return JsonResponse({'error':'This comment is unavailable.'},status=404)
        if value:
            previous = PassageVote.objects.filter(comment=comment,user=request.user).values_list('value',flat=True).first()
            PassageVote.objects.update_or_create(comment=comment,user=request.user,defaults={'value':value})
            if previous != value:
                notify([comment.user_id],request.user,comment.passage.submission.paper,'vote',thread=comment.root or comment)
        else:
            PassageVote.objects.filter(comment=comment,user=request.user).delete()
    return JsonResponse({'ok':True})


@browser_write
def resolve(request, data, comment_id):
    with transaction.atomic():
        comment = visible_comment(comment_id,lock=True)
        if comment.parent_id or comment.user_id != request.user.pk or comment.is_hidden or comment.is_deleted:
            return JsonResponse({'error':'Only the person who started this discussion can resolve or reopen it.'},status=403)
        if type(data.get('resolved')) is not bool:
            raise ValidationError('Choose resolved or open.')
        changed = comment.resolved != data['resolved']
        comment.resolved = data['resolved']
        comment.save(update_fields=['resolved'])
        if changed:
            discussion_activity(comment,request.user,'resolved')
    return JsonResponse({'ok':True})


@browser_write
def report(request, data, comment_id):
    comment = visible_comment(comment_id)
    if comment.is_hidden or comment.is_deleted:
        return JsonResponse({'error':'This comment is already unavailable.'},status=400)
    PassageReport.objects.update_or_create(comment=comment,reporter=request.user,
        defaults={'reason':text_value(data,'reason',2000),'reviewed':False})
    from accounts.models import User
    notify(User.objects.filter(is_staff=True,is_active=True).values_list('pk',flat=True),
           request.user,comment.passage.submission.paper,'report',thread=comment.root or comment)
    return JsonResponse({'ok':True})


@browser_write
def link_pr(request, data, comment_id):
    comment = visible_comment(comment_id)
    if comment.parent_id or comment.is_hidden or comment.is_deleted:
        return JsonResponse({'error':'Link a PR to a visible top-level discussion.'},status=400)
    pr = get_object_or_404(PullRequest,pk=data.get('pr'),contributor=request.user,paper_id=comment.passage.submission.paper_id)
    link, created = PassagePRLink.objects.get_or_create(thread=comment,pull_request=pr,defaults={'user':request.user})
    if created:
        link_activity(link)
    return JsonResponse({'ok':True})
