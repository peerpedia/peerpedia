from django.urls import path
from django.views.generic import RedirectView, TemplateView
from . import views, drafts, notifications
from . import licensing, reading

urlpatterns = [
    path("submissions/<paper_code:public_id>/", views.snapshot_detail, name="snapshot"),
    path("submissions/<paper_code:public_id>/read/", views.snapshot_read, name="read_snapshot"),
    path(
        "submissions/<paper_code:public_id>/download/",
        views.snapshot_download,
        name="snapshot_download",
    ),
    path(
        "submissions/<paper_code:public_id>/manifest/",
        views.snapshot_manifest,
        name="snapshot_manifest",
    ),
    path("papers/<paper_code:public_id>/", views.paper_permalink, name="paper_permalink"),
    path("papers/<paper_code:public_id>/read/", views.read_permalink, name="read_paper_permalink"),
    path(
        "papers/<paper_code:public_id>/versions/<uuid:submission_id>/read/",
        views.read_version,
        name="read_version",
    ),
    path("papers/<uuid:paper_id>/progress/", reading.progress, name="reading_progress"),
    path("terms/", licensing.terms, name="terms"),
    path("terms/<str:version>/", licensing.terms, name="terms_version"),
    path("licenses/", licensing.licenses, name="licenses"),
    path("agreements/", licensing.agreements, name="agreements"),
    path("rights/", licensing.rights_request, name="rights_request"),
    path("privacy/", TemplateView.as_view(template_name="privacy.html"), name="privacy"),
    path("about/", TemplateView.as_view(template_name="about.html"), name="about"),
    path("inbox/", notifications.inbox, name="inbox"),
    path("inbox/read/", notifications.mark_read, name="inbox_read"),
    path("inbox/<int:notification_id>/open/", notifications.open_notification, name="inbox_open"),
    path("write/", RedirectView.as_view(pattern_name="publish"), name="write"),
    path(
        "papers/<uuid:paper_id>/edit/",
        RedirectView.as_view(pattern_name="propose"),
        name="edit_paper",
    ),
    path(
        "prs/<uuid:pr_id>/edit/", RedirectView.as_view(pattern_name="pull_request"), name="edit_pr"
    ),
    path("prs/<uuid:pr_id>/", views.pull_request_detail, name="pull_request"),
    path("drafts/", drafts.listing, name="drafts"),
    path("drafts/<uuid:draft_id>/", drafts.detail),
    path("drafts/<uuid:draft_id>/export/", drafts.export, name="draft_export"),
    path("", views.browse, name="browse"),
    path("health/", views.health, name="health"),
    path("help/", TemplateView.as_view(template_name="publishing/help.html"), name="help"),
    path(
        "help/writing/",
        TemplateView.as_view(template_name="publishing/help_writing.html"),
        name="help_writing",
    ),
    path(
        "help/cli/",
        TemplateView.as_view(template_name="publishing/help_cli.html"),
        name="help_cli",
    ),
    path(
        "help/obsidian/",
        TemplateView.as_view(template_name="publishing/help_obsidian.html"),
        name="help_obsidian",
    ),
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
