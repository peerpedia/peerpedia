from django.urls import path
from django.views.generic import TemplateView
from . import views, drafts

urlpatterns = [
    path("write/", drafts.start, name="write"),
    path("papers/<uuid:paper_id>/edit/", drafts.start, name="edit_paper"),
    path("prs/<uuid:pr_id>/edit/", drafts.start, name="edit_pr"),
    path("prs/<uuid:pr_id>/", views.pull_request_detail, name="pull_request"),
    path("drafts/", drafts.listing, name="drafts"),
    path("drafts/<uuid:draft_id>/", drafts.editor, name="editor"),
    path("drafts/<uuid:draft_id>/save/", drafts.save, name="draft_save"),
    path("drafts/<uuid:draft_id>/preview/", drafts.preview, name="draft_preview"),
    path("drafts/<uuid:draft_id>/rebase/", drafts.rebase, name="draft_rebase"),
    path("drafts/<uuid:draft_id>/review/", drafts.review, name="draft_review"),
    path("drafts/<uuid:draft_id>/submit/", drafts.submit, name="draft_submit"),
    path("drafts/<uuid:draft_id>/discard/", drafts.discard, name="draft_discard"),
    path("", views.browse, name="browse"), path("health/", views.health, name="health"),
    path("help/", TemplateView.as_view(template_name="publishing/help.html"), name="help"),
    path("publish/", views.upload, name="publish"),
    path("papers/<uuid:paper_id>/", views.paper_detail, name="paper"),
    path("papers/<uuid:paper_id>/read/", views.read_paper, name="read_paper"),
    path("papers/<uuid:paper_id>/submit/", views.upload, name="propose"),
    path("papers/<uuid:paper_id>/review/", views.review, name="review"),
    path("papers/<uuid:paper_id>/compare/", views.compare, name="compare"),
    path("submissions/<uuid:submission_id>/", views.submission_detail, name="submission"),
    path("submissions/<uuid:submission_id>/read/", views.read_submission, name="read_submission"),
    path("submissions/<uuid:submission_id>/download/", views.download, name="download"),
    path("submissions/<uuid:submission_id>/manifest/", views.manifest, name="manifest"),
    path("submissions/<uuid:submission_id>/decision/", views.decision, name="decision"),
    path("submissions/<uuid:submission_id>/comment/", views.comment, name="comment"),
]
