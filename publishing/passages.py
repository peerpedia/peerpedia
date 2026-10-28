"""Versioned passage anchors derived from the same tokens as the reader."""

import hashlib
import json
from difflib import SequenceMatcher
from .bananamark import structure


def blocks(source):
    if isinstance(source, str):
        return structure(source)["blocks"]
    from .artifacts import load

    result = load(source)
    return [block for page in result["pages"] for block in page["blocks"]]


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
