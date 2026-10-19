"""Trusted interface icons shared by rendered Markdown and page templates."""

from django.templatetags.static import static
from django.utils.html import format_html


def icon(name):
    return format_html(
        '<svg class="ui-icon" width="18" height="18" viewBox="0 0 24 24" '
        'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" '
        'stroke-linejoin="round" aria-hidden="true" focusable="false">'
        '<use href="{}#{}"></use></svg>',
        static("ui-icons.svg"),
        name,
    )
