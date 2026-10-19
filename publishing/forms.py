from django import forms
from django.conf import settings
from .rendering import has_images
from .subjects import ALIASES, choices


class UploadForm(forms.Form):
    title = forms.CharField(max_length=250)
    authors = forms.CharField(
        max_length=2000,
        widget=forms.Textarea(attrs={"rows": 3}),
        help_text="Enter author names manually, one per line, in publication order.",
    )
    abstract = forms.CharField(max_length=10000, widget=forms.Textarea(attrs={"rows": 5}))
    primary_category = forms.ChoiceField(
        choices=[("", "Choose a primary subject"), *choices()],
        label="Primary subject",
        help_text="Choose the closest arXiv subject. This is part of the frozen submission.",
    )
    secondary_categories = forms.MultipleChoiceField(
        choices=choices(),
        required=False,
        label="Cross-list subjects",
        widget=forms.CheckboxSelectMultiple,
        help_text="Optional: select other subjects whose readers would find this paper relevant.",
    )
    file = forms.FileField(
        label="Markdown document",
        widget=forms.ClearableFileInput(attrs={"accept": ".md"}),
        help_text="One UTF-8 .md file, up to 1 MB. Text, equations, links, and references; no images or embedded HTML.",
    )
    explanation = forms.CharField(
        max_length=5000, label="What changed?", widget=forms.Textarea(attrs={"rows": 3})
    )
    base = forms.UUIDField(required=False, widget=forms.HiddenInput)

    def __init__(self, *args, initial_publication=False, **kwargs):
        super().__init__(*args, **kwargs)
        if initial_publication:
            self.fields["explanation"].widget = forms.HiddenInput()
            self.fields["explanation"].required = False
        else:
            self.fields["base"].required = True

    def clean(self):
        data = super().clean()
        primary = data.get("primary_category")
        secondary = data.get("secondary_categories", [])
        codes = [ALIASES.get(code, code) for code in [primary, *secondary] if code]
        if len(codes) != len(set(codes)):
            self.add_error(
                "secondary_categories",
                "Choose each subject only once, including its arXiv aliases; do not repeat the primary subject.",
            )
        data["secondary_categories"] = sorted(secondary)
        return data

    def clean_file(self):
        upload = self.cleaned_data["file"]
        if not upload.name.lower().endswith(".md"):
            raise forms.ValidationError("Upload a Markdown file ending in .md.")
        if upload.size > settings.MAX_MARKDOWN_BYTES:
            raise forms.ValidationError("The Markdown file must be 1 MB or smaller.")
        try:
            source = upload.read().decode("utf-8")
        except UnicodeDecodeError:
            raise forms.ValidationError("Save your Markdown using UTF-8 encoding.")
        if not source.strip() or "\x00" in source:
            raise forms.ValidationError("Upload a nonempty text document.")
        if has_images(source):
            raise forms.ValidationError(
                "Images are not supported in this release. Remove image references before submitting."
            )
        # Raw HTML is displayed as text rather than interpreted.
        self.markdown = source
        return upload

    def submission_data(self):
        return {
            "title": self.cleaned_data["title"],
            "authors": self.cleaned_data["authors"],
            "abstract": self.cleaned_data["abstract"],
            "explanation": self.cleaned_data["explanation"] or "Initial publication.",
            "markdown": self.markdown,
            "primary_category": self.cleaned_data["primary_category"],
            "secondary_categories": self.cleaned_data["secondary_categories"],
        }


class ReviewForm(forms.Form):
    score = forms.TypedChoiceField(
        coerce=int,
        choices=[(i, f"{i} {'star' if i == 1 else 'stars'}") for i in range(1, 6)],
        widget=forms.RadioSelect,
        label="Your rating",
    )
    text = forms.CharField(
        max_length=10000,
        widget=forms.Textarea(
            attrs={"rows": 5, "placeholder": "Share your assessment of this paper…"}
        ),
        label="Your review",
        help_text="Both a rating and a written review are required.",
    )


class CommentForm(forms.Form):
    text = forms.CharField(
        max_length=5000,
        widget=forms.Textarea(attrs={"rows": 4, "placeholder": "Discuss this submission…"}),
        label="Add to the conversation",
    )
