"""Versioned passage anchors derived from the same tokens as the reader."""

import hashlib
import json
from difflib import SequenceMatcher
from html import escape
from .rendering import parser, heading_tokens


def inline_text(token):
    return "".join(
        (
            "\n"
            if c.type in {"softbreak", "hardbreak"}
            else "$" + c.content + "$"
            if c.type.startswith("math_inline")
            else "[@" + c.content + "]"
            if c.type == "citation"
            else "@" + c.content
            if c.type == "cross_reference"
            else c.content
            if c.type in {"text", "code_inline"}
            else ""
        )
        for c in token.children or []
    )


def annotate(md, tokens, decorate=False, offset=0):
    headings = {h["index"]: h for h in heading_tokens(tokens)}
    result, path, ordinals = [], [], {}
    table_end = -1
    for i, token in enumerate(tokens):
        if i in headings:
            h = headings[i]
            while path and path[-1]["level"] >= h["level"]:
                path.pop()
            path.append(h)
        if i <= table_end:
            continue
        kind, value = None, ""
        if token.type in {"paragraph_open", "heading_open"}:
            kind, value = "text", inline_text(tokens[i + 1])
            if decorate:
                token.hidden = False
                tokens[i + 2].hidden = False
        elif token.type.startswith("math_block"):
            kind, value = "equation", token.content
        elif token.type in {"fence", "code_block"}:
            kind, value = "code", token.content
        elif token.type == "table_open":
            table_end = next(
                j for j in range(i + 1, len(tokens)) if tokens[j].type == "table_close"
            )
            kind = "table"
            value = "\n".join(inline_text(t) for t in tokens[i:table_end] if t.type == "inline")
        if not kind or not value.strip():
            continue
        section_path = [h["label"] for h in path]
        key = json.dumps([section_path, kind])
        ordinal = ordinals.get(key, 0)
        ordinals[key] = ordinal + 1
        block = {
            "id": f"b{offset + len(result)}",
            "kind": kind,
            "text": value,
            "path": section_path,
            "ordinal": ordinal,
        }
        result.append(block)
        if decorate:
            token.attrSet("data-passage", block["id"])
            token.attrSet("data-passage-kind", kind)
            token.attrSet("data-passage-text", value)
    if decorate:
        # Avoid a second layout-only newline after <br>, so DOM and quote offsets agree.
        md.renderer.rules["hardbreak"] = lambda *args: "<br>"
        # Atomic rendered blocks keep a stable canonical TeX/code representation.
        for name in ("math_block", "math_block_eqno", "math_block_label", "fence", "code_block"):
            original = md.renderer.rules.get(name)
            if not original:
                continue

            def render(tokens, idx, options, env, original=original):
                token = tokens[idx]
                attrs = " ".join(
                    f'{k}="{escape(str(v), quote=True)}"'
                    for k, v in token.attrs.items()
                    if k.startswith("data-passage")
                )
                saved = token.attrs
                token.attrs = {k: v for k, v in saved.items() if not k.startswith("data-passage")}
                try:
                    rendered = original(tokens, idx, options, env)
                finally:
                    token.attrs = saved
                return "<div " + attrs + ">" + rendered + "</div>\n"

            md.renderer.rules[name] = render
        for token in tokens:
            for child in token.children or []:
                if child.type.startswith("math_inline"):
                    child.attrSet("data-passage-math", "$" + child.content + "$")
        for name in ("math_inline",):
            original = md.renderer.rules.get(name)
            if original:

                def render_math(tokens, idx, options, env, original=original):
                    value = "$" + tokens[idx].content + "$"
                    return (
                        '<span data-passage-math="'
                        + escape(value, quote=True)
                        + '">'
                        + original(tokens, idx, options, env)
                        + "</span>"
                    )

                md.renderer.rules[name] = render_math
    return result


def blocks(source):
    if not isinstance(source, str):
        if source.chapters:
            result = []
            for page in source.chapters:
                md = parser()
                items = annotate(md, md.parse(page["markdown"]), offset=len(result))
                for item in items:
                    item["chapter"] = page["id"]
                result.extend(items)
            return result
        source = source.markdown
    md = parser()
    return annotate(md, md.parse(source))


def validate(source, spans):
    from django.core.exceptions import ValidationError

    if not isinstance(spans, list) or not 1 <= len(spans) <= 50:
        raise ValidationError("Select a passage of up to 50 blocks.")
    available = blocks(source)
    by_id = {b["id"]: (i, b) for i, b in enumerate(available)}
    selected, last = [], -1
    for span in spans:
        if not isinstance(span, dict) or span.get("block") not in by_id:
            raise ValidationError("This passage is not in the selected version.")
        index, block = by_id[span["block"]]
        start, end = span.get("start"), span.get("end")
        if (
            type(start) is not int
            or type(end) is not int
            or not 0 <= start < end <= len(block["text"])
            or index <= last
        ):
            raise ValidationError("The selected text range is invalid.")
        if block["kind"] != "text" and (start != 0 or end != len(block["text"])):
            raise ValidationError("Select equations, tables, and code blocks as a whole.")
        selected.append({**block, "start": start, "end": end})
        last = index
    quote = "\n\n".join(b["text"][b["start"] : b["end"]] for b in selected)
    if not quote.strip() or len(quote) > 12000:
        raise ValidationError("Select between 1 and 12,000 characters.")
    normalized = [{"block": s["id"], "start": s["start"], "end": s["end"]} for s in selected]
    key = hashlib.sha256(
        json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return selected, quote, key


def locate(anchor, target, same_version=False):
    """Only exact, unambiguous passages carry ratings. Guesses are historical links."""
    if same_version:
        return "current", [
            {"block": s["id"], "start": s["start"], "end": s["end"]} for s in anchor.spans
        ]
    mapped = []
    for old in anchor.spans:
        quote = old["text"][old["start"] : old["end"]]
        matches = []
        for b in target:
            if b["kind"] != old["kind"]:
                continue
            if b["kind"] != "text":
                positions = [0] if b["text"] == quote else []
            else:
                positions, at = [], b["text"].find(quote)
                while at >= 0:
                    positions.append(at)
                    at = b["text"].find(quote, at + 1)
            for at in positions:
                matches.append((b, at))
        # Duplicate text never silently reattaches just by occurrence number.
        if len(matches) != 1:
            likely = [
                b
                for b in target
                if b["kind"] == old["kind"]
                and b["path"] == old["path"]
                and b["ordinal"] == old["ordinal"]
            ]
            if (
                len(likely) == 1
                and SequenceMatcher(
                    None, old["text"][:12000], likely[0]["text"][:12000], autojunk=True
                ).ratio()
                >= 0.45
            ):
                return "historical", [
                    {"block": likely[0]["id"], "start": 0, "end": len(likely[0]["text"])}
                ]
            return "unplaced", []
        b, at = matches[0]
        mapped.append({"block": b["id"], "start": at, "end": at + len(quote)})
    numbers = [int(s["block"][1:]) for s in mapped]
    if numbers != sorted(set(numbers)):
        return "unplaced", []
    return "current", mapped
