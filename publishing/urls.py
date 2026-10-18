from django.urls import path
from django.views.generic import TemplateView
from . import views

urlpatterns = [
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
