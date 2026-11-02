"""V1.5 experimental source identity, not an approval or execution check.

Python and browser implementations must produce identical UTF-8 JSON bytes.
This projection deliberately does not cover context or the human decision event.
"""

import hashlib
import json
import re

_CATEGORIES = frozenset(("视觉", "文案", "交互", "产品逻辑", "反馈/建议"))
_HASH = re.compile(r"[a-f0-9]{64}\Z")
_IMAGE = re.compile(r"(?:shots|refs)/(?:[^/\\\x00-\x1f\x7f]+/)*[^/\\\x00-\x1f\x7f]+\.(?:png|jpg|jpeg|webp)\Z")
_MAX_ID = 2**53 - 1


class SourceIdentityError(ValueError):
    """Invalid source, image path or image fingerprint."""


def _string(value, name, nullable=False):
    if nullable and value is None:
        return None
    if not isinstance(value, str):
        raise SourceIdentityError(name + " must be text or null")
    if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise SourceIdentityError(name + " contains an invalid Unicode surrogate")
    return value


def _path(value):
    _string(value, "image path")
    if not _IMAGE.fullmatch(value) or any(part in (".", "..") for part in value.split("/")):
        raise SourceIdentityError("image path is invalid")
    return value


def source_record(annotation, image_hashes):
    """Select unchanged user source fields and verified image-byte hashes.

    image_hashes must be calculated by the caller from actual referenced image bytes;
    never trust filenames, data URLs or hashes supplied as user approval.
    """
    if not isinstance(annotation, dict) or type(annotation.get("id")) is not int or not (1 <= annotation["id"] <= _MAX_ID):
        raise SourceIdentityError("source item id must be a safe positive integer")
    if not isinstance(image_hashes, dict):
        raise SourceIdentityError("image_hashes must be a map")
    category = _string(annotation.get("category"), "category", nullable=True)
    if category is not None and category not in _CATEGORIES:
        raise SourceIdentityError("unknown source category")
    shot = annotation.get("shot")
    if shot is not None:
        _path(shot)
        if not shot.startswith("shots/"):
            raise SourceIdentityError("screenshot must be under shots/")
    refs = annotation.get("refs", [])
    if not isinstance(refs, list):
        raise SourceIdentityError("refs must be a list")
    for ref in refs:
        _path(ref)
        if not ref.startswith("refs/"):
            raise SourceIdentityError("reference must be under refs/")
    paths = ([shot] if shot is not None else []) + refs
    if len(paths) != len(set(paths)) or set(paths) != set(image_hashes):
        raise SourceIdentityError("image hashes must exactly match unique source references")
    for path, value in image_hashes.items():
        _path(path)
        if not isinstance(value, str) or not _HASH.fullmatch(value):
            raise SourceIdentityError("image SHA-256 must be lowercase hexadecimal")
    images = [{"path": path, "sha256": image_hashes[path]} for path in sorted(paths, key=lambda p: p.encode("utf-8"))]
    return {
        "schemaVersion": 1,
        "id": annotation["id"],
        "text": _string(annotation.get("text", ""), "text"),
        "category": category,
        "observed": _string(annotation.get("observed"), "observed", nullable=True),
        "expected": _string(annotation.get("expected"), "expected", nullable=True),
        "reproduction": _string(annotation.get("reproduction"), "reproduction", nullable=True),
        "shot": shot,
        "refs": list(refs),
        "images": images,
    }


def source_json(annotation, image_hashes):
    return json.dumps(source_record(annotation, image_hashes), ensure_ascii=False,
                      separators=(",", ":"), allow_nan=False)


def source_hash(annotation, image_hashes):
    return hashlib.sha256(source_json(annotation, image_hashes).encode("utf-8")).hexdigest()
