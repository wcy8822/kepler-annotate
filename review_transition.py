"""B3: compare H0/H1 source changes without granting user approval.

The caller must supply image hashes computed from actual bytes and separately
verify the H0 snapshot, user gesture, and context. Never use this to open gates.
"""
from pathlib import Path
import runpy

_source = runpy.run_path(str(Path(__file__).with_name("review_source.py")))
source_record = _source["source_record"]
source_hash = _source["source_hash"]


class SourceTransitionError(ValueError):
    """An undeclared, destructive, or ill-formed source change."""


def validate_transition(basis, basis_hashes, applies, applies_hashes, transform):
    """Check only explicit category adoption and appended image evidence.

    This verifies structural consistency, NOT that a human approved the change
    or that the supplied basis came from an immutable historical revision.
    """
    before = source_record(basis, basis_hashes)
    after = source_record(applies, applies_hashes)
    if (not isinstance(transform, dict) or set(transform) != {"schemaVersion", "adoptedCategory", "addedEvidence"}
            or type(transform["schemaVersion"]) is not int or transform["schemaVersion"] != 1
            or not isinstance(transform["addedEvidence"], list) or len(transform["addedEvidence"]) > 20):
        raise SourceTransitionError("sourceTransform must be a closed v1 object")
    if before["id"] != after["id"]:
        raise SourceTransitionError("item id must not change")
    for field in ("text", "observed", "expected", "reproduction"):
        if before[field] != after[field]:
            raise SourceTransitionError("original feedback cannot change: " + field)
    if before["category"] == after["category"]:
        if transform["adoptedCategory"] is not None:
            raise SourceTransitionError("category adoption must describe an actual change")
    elif after["category"] is None or transform["adoptedCategory"] != after["category"]:
        raise SourceTransitionError("category changes require a declared adoption")
    if before["shot"] is not None and before["shot"] != after["shot"]:
        raise SourceTransitionError("original screenshot cannot be replaced or removed")
    if after["refs"][:len(before["refs"])] != before["refs"]:
        raise SourceTransitionError("original references cannot be removed or reordered")
    old_images = {image["path"]: image["sha256"] for image in before["images"]}
    new_images = {image["path"]: image["sha256"] for image in after["images"]}
    if any(new_images.get(path) != sha for path, sha in old_images.items()):
        raise SourceTransitionError("existing evidence bytes cannot change")
    additions = ([after["shot"]] if before["shot"] is None and after["shot"] is not None else [])
    additions += after["refs"][len(before["refs"]):]
    expected = [{"path": path, "sha256": new_images[path]} for path in additions]
    if transform["addedEvidence"] != expected:
        raise SourceTransitionError("new evidence must be declared in append order with exact hashes")
    # This strict object comparison also rejects extraneous keys in declarations.
    return {"basisSourceHash": source_hash(basis, basis_hashes),
            "appliesToSourceHash": source_hash(applies, applies_hashes)}
