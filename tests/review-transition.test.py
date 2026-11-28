"""B3 H0/H1 structural transformation only. No browser, model, or real user data."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
module = importlib.util.spec_from_file_location("review_transition", ROOT / "review_transition.py")
review = importlib.util.module_from_spec(module)
module.loader.exec_module(review)
VECTORS = json.loads((ROOT / "tests/fixtures/review-transition-v1.json").read_text(encoding="utf-8"))["vectors"]


class SourceTransitionTest(unittest.TestCase):
    def validate(self, vector, **changes):
        return review.validate_transition(changes.get("basis", vector["basis"]), changes.get("basisHashes", vector["basisHashes"]),
                                          changes.get("applies", vector["applies"]), changes.get("appliesHashes", vector["appliesHashes"]),
                                          changes.get("transform", vector["transform"]))

    def test_cross_language_golden_h0_h1_hashes(self):
        for vector in VECTORS:
            with self.subTest(name=vector["name"]):
                before = copy.deepcopy(vector)
                result = self.validate(vector)
                self.assertEqual(result, {"basisSourceHash": vector["basisSourceHash"],
                                          "appliesToSourceHash": vector["appliesToSourceHash"]})
                self.assertEqual(vector, before)

    def test_raw_words_fields_and_id_cannot_be_rewritten(self):
        vector = VECTORS[2]
        for update in ({"text": "替换原话"}, {"observed": "不同观察"}, {"expected": "推测的预期"},
                       {"reproduction": "伪造步骤"}, {"id": 10}):
            with self.subTest(update=update), self.assertRaises(review.SourceTransitionError):
                self.validate(vector, applies=dict(vector["applies"], **update))

    def test_category_adoption_requires_matching_explicit_change(self):
        vector = VECTORS[1]
        for action in (None, "文案", True):
            with self.subTest(action=action), self.assertRaises(review.SourceTransitionError):
                self.validate(vector, transform=dict(vector["transform"], adoptedCategory=action))
        with self.assertRaises(review.SourceTransitionError):
            self.validate(vector, applies=vector["basis"])
        with self.assertRaises(review.SourceTransitionError):
            self.validate(vector, applies=dict(vector["applies"], category=None))

    def test_existing_evidence_cannot_be_replaced_removed_or_reordered(self):
        vector = VECTORS[2]
        bad = [
            {"applies": dict(vector["applies"], refs=list(reversed(vector["applies"]["refs"])))},
            {"applies": dict(vector["applies"], shot=None), "appliesHashes": {k: v for k, v in vector["appliesHashes"].items() if k != "shots/ui.png"}},
            {"appliesHashes": dict(vector["appliesHashes"], **{"shots/ui.png": "0" * 64})},
            {"transform": dict(vector["transform"], addedEvidence=[])},
            {"transform": dict(vector["transform"], addedEvidence=[{"path": "refs/📐图B.png", "sha256": "0" * 64}])},
            {"transform": dict(vector["transform"], addedEvidence=[{"path": "refs/📐图B.png", "sha256": vector["appliesHashes"]["refs/📐图B.png"], "run": True}])},
        ]
        for change in bad:
            with self.subTest(change=change), self.assertRaises((review.SourceTransitionError, ValueError)):
                self.validate(vector, **change)

    def test_closed_versioned_transform_and_ordered_additions(self):
        vector = VECTORS[3]
        self.validate(vector)
        for change in ({"schemaVersion": True}, {"schemaVersion": 1.0}, {"schemaVersion": 2},
                       {"command": "execute"}, {"addedEvidence": list(reversed(vector["transform"]["addedEvidence"]))},
                       {"addedEvidence": [{}]}, {"adoptedCategory": None}):
            with self.subTest(change=change), self.assertRaises(review.SourceTransitionError):
                self.validate(vector, transform=dict(vector["transform"], **change))


if __name__ == "__main__":
    unittest.main()
