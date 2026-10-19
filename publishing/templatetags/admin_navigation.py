from django import template

register = template.Library()

SECTIONS = (
    (
        "Moderation",
        "Review reports and manage the visibility of public content.",
        (
            (
                "publishing",
                "PassageReport",
                "Reported comments",
                "Review concerns raised by readers.",
            ),
            ("publishing", "Paper", "Papers", "Find papers and manage their visibility."),
            (
                "publishing",
                "PassageComment",
                "Passage discussions",
                "Review comments and replies on specific passages.",
            ),
            (
                "publishing",
                "Review",
                "Paper reviews",
                "Manage overall ratings and written reviews.",
            ),
            (
                "publishing",
                "Comment",
                "PR conversations",
                "Review conversations about proposed changes.",
            ),
        ),
    ),
    (
        "Accounts",
        "Manage access to Peerpedia and its administration.",
        (
            (
                "accounts",
                "User",
                "People",
                "Manage accounts, email verification, and staff access.",
            ),
            ("auth", "Group", "Permission groups", "Organize staff permissions."),
        ),
    ),
    (
        "History",
        "Inspect preserved records of publication and moderation.",
        (
            (
                "publishing",
                "Submission",
                "Paper snapshots",
                "Read frozen documents and their hashes.",
            ),
            (
                "publishing",
                "Decision",
                "Publication decisions",
                "See acceptance, rejection, and withdrawal records.",
            ),
            (
                "publishing",
                "ModerationEvent",
                "Moderation history",
                "See who hid or restored content.",
            ),
            (
                "publishing",
                "Passage",
                "Quoted passages",
                "Inspect the original text attached to discussions.",
            ),
            (
                "publishing",
                "PassageCommentRevision",
                "Comment edit history",
                "Read preserved versions of comments.",
            ),
            (
                "publishing",
                "SubmissionSource",
                "Tool attribution",
                "Inspect CLI and AI-assisted submission records.",
            ),
        ),
    ),
)


@register.simple_tag
def admin_model_label(app_label, object_name, fallback):
    for _, _, entries in SECTIONS:
        for app, model, label, _ in entries:
            if (app, model) == (app_label, object_name):
                return label
    return str(fallback).capitalize()


@register.simple_tag
def admin_sections(app_list):
    # Use only Django's permission-filtered links; never build privileged URLs.
    remaining = {
        (app["app_label"], model["object_name"]): model
        for app in app_list
        for model in app["models"]
    }
    sections = []
    for title, description, entries in SECTIONS:
        items = []
        for app, model, label, detail in entries:
            item = remaining.pop((app, model), None)
            if item:
                items.append({**item, "label": label, "description": detail})
        if items:
            sections.append({"title": title, "description": description, "items": items})
    if remaining:
        sections.append(
            {
                "title": "Other tools",
                "description": "",
                "items": [
                    {**model, "label": model["name"], "description": ""}
                    for model in remaining.values()
                ],
            }
        )
    return sections
