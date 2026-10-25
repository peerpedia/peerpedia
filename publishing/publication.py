"""Publication requirements shared by the website and local editor."""

from django.core.files.uploadedfile import SimpleUploadedFile
from .forms import UploadForm

REQUIREMENTS = [
    ("title", "Title", "Add a title that tells readers what this note covers."),
    ("authors", "Authors", "Add the author names, one per line."),
    ("abstract", "Abstract", "Write a short summary of the question and what readers will learn."),
    ("primary_category", "Primary subject", "Choose the closest subject in Paper details."),
    ("markdown", "Paper text", "Write your note or import a Markdown file."),
]
CHANGE = (
    "explanation",
    "What changed?",
    "Describe your changes and why they help. For example, ‘Correct the sign in Equation 2 and add the missing assumption to its proof.’",
)


def requirements(is_revision):
    return [
        dict(field=field, label=label, help=help_text)
        for field, label, help_text in [*REQUIREMENTS, *([CHANGE] if is_revision else [])]
    ]


def form(data, markdown, *, is_revision, base=None):
    return UploadForm(
        {**data, "base": base},
        {"file": SimpleUploadedFile("paper.md", markdown.encode("utf-8"))},
        initial_publication=not is_revision,
    )


def issues(form):
    hints = {item["field"]: item for item in requirements(True)}
    result = []
    for key, errors in form.errors.as_data().items():
        field = "markdown" if key == "file" else key
        label = hints.get(field, {}).get("label") or (
            form.fields[key].label or key.replace("_", " ").capitalize()
            if key in form.fields
            else "Submission"
        )
        for error in errors:
            message = (
                hints[field]["help"]
                if error.code == "required" and field in hints
                else " ".join(error.messages)
            )
            if field == "markdown" and message == "Upload a nonempty text document.":
                message = hints[field]["help"]
            result.append({"field": field, "label": label, "message": message})
    return result
