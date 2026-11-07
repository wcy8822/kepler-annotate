"""Frozen V1.5 cross-language source identities; no real user data or AI calls."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parents[1]
module_spec = importlib.util.spec_from_file_location("review_source", SOURCE / "review_source.py")
source = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(source)
VECTORS = json.loads((SOURCE / "tests/fixtures/review-source-v1.json").read_text(encoding="utf-8"))["vectors"]


class SourceIdentityTest(unittest.TestCase):
    def test_python_hash_matches_frozen_browser_vectors(self):
        for vector in VECTORS:
            with self.subTest(vector=vector["name"]):
                original = copy.deepcopy(vector["annotation"])
                self.assertEqual(source.source_hash(vector["annotation"], vector["imageHashes"]), vector["sha256"])
                self.assertEqual(original, vector["annotation"])
                self.assertEqual(source.source_record(original, vector["imageHashes"])["id"], original["id"])

    def test_metadata_exclusion_and_immutable_source_binding(self):
        annotation, images = VECTORS[0]["annotation"], VECTORS[0]["imageHashes"]
        original = source.source_hash(annotation, images)
        noise = dict(annotation, updatedAt="later", status="已完成", modelCandidate="unapproved")
        self.assertEqual(original, source.source_hash(noise, images))
        for update in ({"text": "替换原话"}, {"category": "交互"}, {"expected": "更改预期"}):
            with self.subTest(update=update):
                self.assertNotEqual(original, source.source_hash(dict(annotation, **update), images))
        self.assertNotEqual(original, source.source_hash(annotation, {"shots/007.png": "0" * 64}))

    def test_ascii_paths_and_control_bytes_regression(self):
        # 34eec6d CI: Python regex escaping rejected ordinary ASCII screenshots.
        annotation, images = VECTORS[0]["annotation"], VECTORS[0]["imageHashes"]
        self.assertEqual(source.source_hash(annotation, images), VECTORS[0]["sha256"])
        for invalid in ("shots/evil\x00.png", "shots/evil\n.png", "shots/evil\x7f.png",
                        "shots/folder\\evil.png", "shots/../evil.png", "shots/evil.svg"):
            with self.subTest(path=repr(invalid)), self.assertRaises(source.SourceIdentityError):
                source.source_hash(dict(annotation, shot=invalid), {invalid: next(iter(images.values()))})

    def test_malformed_evidence_or_unicode_rejected(self):
        annotation, images = VECTORS[1]["annotation"], VECTORS[1]["imageHashes"]
        for hashes in ({}, dict(images, **{"refs/extra.png": "a" * 64}),
                       dict(images, **{"refs/设计图.png": "A" * 64})):
            with self.assertRaises(source.SourceIdentityError):
                source.source_json(annotation, hashes)
        for patch in ({"refs": ["refs/../oops.png"]}, {"refs": ["refs/设计图.png"] * 2},
                      {"shot": "refs/fake.png"}, {"text": "\ud800"},
                      {"refs": ["refs/\udc00.png"]}, {"category": "其他"},
                      {"id": 2**53}, {"id": True}, {"text": None}):
            with self.subTest(patch=repr(patch)), self.assertRaises(source.SourceIdentityError):
                source.source_json(dict(annotation, **patch), images)


if __name__ == "__main__":
    unittest.main()
