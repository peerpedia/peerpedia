"""Section ranges are derived from parsed Markdown, never from rendered text."""
import re
from django.core.exceptions import ValidationError
from .rendering import parser, heading_tokens


def sections(source):
    offsets = [0]
    # Match Markdown's newline normalization; Unicode paragraph separators are text.
    offsets.extend(match.end() for match in re.finditer(r'\r\n|\r|\n', source))
    headings = [h for h in heading_tokens(parser().parse(source)) if h['token'].level == 0]
    result, parents = [], []
    for i, heading in enumerate(headings):
        while parents and parents[-1]['level'] >= heading['level']:
            parents.pop()
        path = [h['label'] for h in parents] + [heading['label']]
        parents.append(heading)
        if heading['title']:
            continue
        end = next((offsets[h['line'] - 1] for h in headings[i + 1:] if h['level'] <= heading['level']), len(source))
        result.append({'anchor': heading['id'], 'label': heading['label'], 'level': heading['level'],
                       'path': path, 'start': offsets[heading['line'] - 1], 'end': end})
    return result


def find(source, anchor):
    return next((s for s in sections(source) if s['anchor'] == anchor), None)


def text(source, section):
    return source[section['start']:section['end']]


def match(base, section, latest):
    """Prefer a unique structural path. Never guess among duplicate headings."""
    candidates = sections(latest)
    same_path = [s for s in candidates if s['path'] == section['path'] and s['level'] == section['level']]
    old_paths = [s for s in sections(base) if s['path'] == section['path']]
    if len(same_path) == len(old_paths) == 1:
        return same_path[0]
    exact = [s for s in candidates if text(latest, s) == text(base, section)]
    old_exact = [s for s in sections(base) if text(base, s) == text(base, section)]
    return exact[0] if len(exact) == len(old_exact) == 1 else None


def combine(base, section, replacement):
    # Separate the following heading even when the editor removed trailing newlines.
    suffix = base[section['end']:]
    if suffix and replacement and not replacement.endswith('\n\n'):
        replacement = replacement.rstrip('\r\n') + '\n\n'
    result = base[:section['start']] + replacement + suffix
    # A fence/list/heading edit must not swallow or restructure neighboring sections.
    tokens = parser().parse(replacement)
    roots = [h for h in heading_tokens(tokens) if h['token'].level == 0]
    if (not roots or roots[0]['line'] != 1 or roots[0]['level'] != section['level']
            or any(h['level'] <= section['level'] for h in roots[1:])):
        raise ValidationError('Keep one section heading at its original level. Add lower-level headings inside it, or use the full-paper editor.')
    before = sections(base)
    after = sections(result)
    delta = len(result) - len(base)
    outside = [(s['start'] if s['start'] < section['start'] else s['start'] + delta, s['label'], s['level'])
               for s in before if s['start'] < section['start'] or s['start'] >= section['end']]
    actual = [(s['start'], s['label'], s['level']) for s in after
              if s['start'] < section['start'] or s['start'] >= section['start'] + len(replacement)]
    if outside != actual:
        raise ValidationError('This edit changes the structure outside its section. Check unclosed code or math blocks, or use the full-paper editor.')
    return result


def extract(base, section, snapshot):
    suffix = base[section['end']:]
    if not snapshot.startswith(base[:section['start']]) or (suffix and not snapshot.endswith(suffix)):
        raise ValidationError('This snapshot changes text outside its section.')
    return snapshot[section['start']:len(snapshot) - len(suffix) if suffix else len(snapshot)]
