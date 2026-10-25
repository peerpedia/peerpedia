"""Shared public visibility queries for website and API readers."""

from django.db import connection
from django.db.models import Avg, Count, Q, F
from django.http import Http404
from .subjects import CATEGORIES, equivalent_codes, filter_codes
from .models import Paper, Submission


def public_papers():
    return Paper.objects.filter(is_hidden=False, current__isnull=False).select_related(
        "current", "owner"
    )


def submission_queryset():
    return Submission.objects.filter(paper__is_hidden=False).select_related(
        "paper__owner", "base", "decision", "contributor"
    )


def category_match(codes):
    match = Q(current__primary_category__in=codes)
    for code in codes:
        if connection.vendor == "postgresql":
            match |= Q(current__secondary_categories__contains=[code])
        else:
            # Exact quoted identifiers in the JSON array; SQLite has no JSON contains.
            match |= Q(current__secondary_categories__icontains='"' + code + '"')
    return match


def search_papers(query="", subject="", sort="latest"):
    papers = public_papers().annotate(
        average=Avg("reviews__score", filter=Q(reviews__is_hidden=False)),
        review_count=Count("reviews", filter=Q(reviews__is_hidden=False)),
    )
    codes = filter_codes(subject)
    if subject == "unclassified":
        papers = papers.filter(current__primary_category="")
    elif codes:
        papers = papers.filter(category_match(codes))
    elif subject:
        raise Http404("Unknown subject")
    if query:
        matching = (
            Q(public_id__icontains=query)
            | Q(pk__in=Submission.objects.filter(public_id=query).values("paper_id"))
            | Q(current__title__icontains=query)
            | Q(current__authors__icontains=query)
            | Q(current__abstract__icontains=query)
            | Q(current__markdown__icontains=query)
        )
        matching_codes = [
            code
            for code, row in CATEGORIES.items()
            if query.casefold() in (code + " " + row["name"]).casefold()
        ]
        if matching_codes:
            matching |= category_match(equivalent_codes(matching_codes))
        if connection.vendor == "postgresql":
            from django.contrib.postgres.search import SearchQuery, SearchVector

            papers = papers.annotate(
                search=SearchVector(
                    "current__title",
                    "current__authors",
                    "current__abstract",
                    "current__markdown",
                    config="simple",
                )
            )
            matching |= Q(search=SearchQuery(query, config="simple", search_type="websearch"))
        papers = papers.filter(matching)
    if sort == "rating":
        papers = papers.order_by(
            F("average").desc(nulls_last=True), "-review_count", "-accepted_at", "-pk"
        )
    else:
        sort = "latest"
        papers = papers.order_by("-accepted_at", "-pk")
    return papers
