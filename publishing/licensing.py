"""Versioned permissions, separate from immutable historical content."""

from functools import lru_cache, wraps
import hashlib
from pathlib import Path
from urllib.parse import urlencode
from django import forms
from django.conf import settings
from django.core.exceptions import ValidationError
from django.shortcuts import redirect, render
from django.urls import reverse
from django.utils.http import url_has_allowed_host_and_scheme
from django.views.decorators.http import require_http_methods
from accounts.security import verified_required, limited
from .models import AgreementAcceptance, PaperLicense, RightsRequest

VERSION = "2026-10-19"
LICENSES = {
    "CC-BY-4.0": (
        "CC BY 4.0",
        "https://creativecommons.org/licenses/by/4.0/",
        "Share and adapt, including commercially, with attribution and notice of changes.",
    ),
    "CC-BY-SA-4.0": (
        "CC BY-SA 4.0",
        "https://creativecommons.org/licenses/by-sa/4.0/",
        "Share and adapt, including commercially, with attribution. Shared adaptations must use the same license.",
    ),
    "CC-BY-NC-SA-4.0": (
        "CC BY-NC-SA 4.0",
        "https://creativecommons.org/licenses/by-nc-sa/4.0/",
        "Share and adapt for noncommercial purposes, with attribution and the same license for shared adaptations.",
    ),
    "CC-BY-NC-ND-4.0": (
        "CC BY-NC-ND 4.0",
        "https://creativecommons.org/licenses/by-nc-nd/4.0/",
        "Share unadapted copies noncommercially with attribution. Separate Peerpedia permission allows public PRs here.",
    ),
    "CC0-1.0": (
        "CC0 1.0",
        "https://creativecommons.org/publicdomain/zero/1.0/",
        "Dedicate the work to the public domain to the extent legally possible. Reuse does not require attribution under CC0.",
    ),
    "LicenseRef-Peerpedia-1.0": (
        "Peerpedia non-exclusive license 1.0",
        "/terms/2026-10-19/#distribution",
        "Permit Peerpedia distribution and on-platform collaboration. Other reuse requires permission or another legal basis.",
    ),
}
CHOICES = [(code, value[0]) for code, value in LICENSES.items()]


@lru_cache(maxsize=1)
def document_hash():
    return hashlib.sha256(
        (Path(settings.BASE_DIR) / "templates/policies/2026-10-19.html").read_bytes()
    ).hexdigest()


def acceptance(user):
    if not user.is_authenticated:
        return None
    return AgreementAcceptance.objects.filter(
        user=user, version=VERSION, document_hash=document_hash()
    ).first()


def require_agreement(user):
    record = acceptance(user)
    if not record:
        raise ValidationError(
            "Review and accept the current submission and discussion agreement on the website at /agreements/ before contributing.",
            code="agreement_required",
        )
    return record


def paper_license(paper):
    try:
        return paper.license_declaration.license_code
    except PaperLicense.DoesNotExist:
        raise ValidationError(
            "The corresponding author must declare this paper's license before a new revision can be published.",
            code="license_required",
        )


def snapshot_license(submission):
    declaration = None
    code = submission.license_code if submission.manifest_version >= 3 else ""
    if not code:
        try:
            grant = submission.paper.license_declaration
            if submission.hash in grant.legacy_hashes:
                code, declaration = grant.license_code, grant
        except PaperLicense.DoesNotExist:
            pass
    if not code:
        return {"code": None, "label": "License not recorded", "url": reverse("licenses")}
    label, url, description = LICENSES[code]
    return {
        "code": code,
        "label": label,
        "url": url,
        "description": description,
        "declaration": {
            "declared_at": declaration.created_at.isoformat(),
            "actor": declaration.actor.username,
            "agreement_version": declaration.agreement_version,
            "document_hash": declaration.document_hash,
            "scope": "This historical snapshot; its original manifest and hash are unchanged.",
        }
        if declaration
        else None,
    }


class PublicationConsentForm(forms.Form):
    license = forms.ChoiceField(
        choices=[("", "Choose a license"), *CHOICES], label="Content license"
    )
    rights_confirmed = forms.BooleanField(
        label="I have authority to submit this material, including the necessary coauthor and third-party permissions. I grant the hosting and collaboration permissions in the submission agreement and apply the stated license to my contribution."
    )

    def __init__(self, *args, paper=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.license_info = None
        if paper:
            del self.fields["license"]
            self.license_info = snapshot_license(paper.current)

    def code(self):
        return self.cleaned_data.get("license")


class AcceptanceForm(forms.Form):
    version = forms.CharField(widget=forms.HiddenInput, initial=VERSION)
    agree = forms.BooleanField(
        label="I have read and accept this version of the submission and discussion agreement, including public revision proposals and preservation of published history."
    )

    def clean_version(self):
        if self.cleaned_data["version"] != VERSION:
            raise forms.ValidationError(
                "The agreement changed. Reload this page and review the current version."
            )
        return VERSION


def terms(request, version=VERSION):
    from django.http import Http404

    if version != VERSION:
        raise Http404()
    return render(
        request, "policies/terms.html", {"version": version, "document_hash": document_hash()}
    )


def licenses(request):
    return render(request, "policies/licenses.html", {"licenses": LICENSES})


@verified_required
@require_http_methods(["GET", "POST"])
def agreements(request):
    target = request.POST.get("next", request.GET.get("next", "/"))
    if not url_has_allowed_host_and_scheme(
        target, allowed_hosts={request.get_host()}, require_https=request.is_secure()
    ):
        target = "/"
    form = AcceptanceForm(request.POST or None)
    record = acceptance(request.user)
    if request.method == "POST" and form.is_valid():
        record, _ = AgreementAcceptance.objects.get_or_create(
            user=request.user, version=VERSION, defaults={"document_hash": document_hash()}
        )
        if record.document_hash != document_hash():
            raise ValidationError("The agreement version must change when its text changes.")
        return redirect(target)
    response = render(
        request,
        "policies/accept.html",
        {"form": form, "accepted": record, "version": VERSION, "next": target},
    )
    response["Cache-Control"] = "private, no-store"
    return response


def agreement_required(view):
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        if not acceptance(request.user):
            # Return to the saved draft or paper, never replay a POST.
            target = request.get_full_path() if request.method == "GET" else "/publish/"
            for key, route in (
                ("draft_id", "editor"),
                ("paper_id", "paper"),
                ("submission_id", "submission"),
            ):
                if request.method == "POST" and key in kwargs:
                    target = reverse(route, args=[kwargs[key]])
                    break
            return redirect(reverse("agreements") + "?" + urlencode({"next": target}))
        return view(request, *args, **kwargs)

    return wrapped


class RightsForm(forms.ModelForm):
    accurate = forms.BooleanField(
        label="I believe this request is accurate and I am authorized to make it."
    )

    class Meta:
        model = RightsRequest
        fields = ["name", "email", "work_url", "details"]
        labels = {
            "work_url": "Peerpedia paper or submission URL",
            "details": "Request and evidence",
        }
        help_texts = {
            "details": "Explain your connection to the work, the issue, and the action requested. Include links to supporting material. Do not send passwords or identity documents."
        }


@require_http_methods(["GET", "POST"])
@limited("rights_request", limit=5, seconds=3600)
def rights_request(request):
    form = RightsForm(request.POST or None)
    received = False
    if request.method == "POST" and form.is_valid():
        form.save()
        received = True
        form = RightsForm()
    response = render(request, "policies/rights.html", {"form": form, "received": received})
    response["Cache-Control"] = "private, no-store"
    return response
