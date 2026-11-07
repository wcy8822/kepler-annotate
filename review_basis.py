"""Verify a review transition against a checksum-verified historical H0 item.

The caller must load the H0 annotation from an immutable validated snapshot of
the same project and batch, and calculate image hashes from actual image bytes.
Matching a source transition is not a human approval or an execution permit.
"""
from pathlib import Path
import re
import runpy

_transition = runpy.run_path(str(Path(__file__).with_name("review_transition.py")))
_validate_transition = _transition["validate_transition"]
_REVISION = re.compile(r"[a-f0-9]{64}\Z")


class ReviewBasisError(ValueError):
    """A claimed historical source revision or transition cannot be verified."""


def validate_basis_entry(entry, historical_revision, basis, basis_hashes, current, current_hashes):
    """Verify the exact historical item revision and declared source differences."""
    if not isinstance(entry, dict) or not isinstance(historical_revision, str) or not _REVISION.fullmatch(historical_revision):
        raise ReviewBasisError("historical item revision must be lowercase SHA-256")
    if entry.get("sourceItemRevision") != historical_revision:
        raise ReviewBasisError("sourceItemRevision does not match immutable H0 item revision")
    if "sourceTransform" not in entry:
        raise ReviewBasisError("explicit sourceTransform is required for history binding")
    try:
        calculated = _validate_transition(basis, basis_hashes, current, current_hashes, entry["sourceTransform"])
    except (ValueError, TypeError, KeyError) as error:
        raise ReviewBasisError("H0 to H1 source transformation is invalid: " + str(error)) from error
    if (entry.get("basisSourceHash") != calculated["basisSourceHash"]
            or entry.get("appliesToSourceHash") != calculated["appliesToSourceHash"]):
        raise ReviewBasisError("declared H0 or H1 hash disagrees with actual source evidence")
    return calculated
