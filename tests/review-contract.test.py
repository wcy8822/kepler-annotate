"""V1.5 契约边界；全部使用虚构批注和合成像素，不调用模型。"""
import base64
import copy
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1]
module_spec = importlib.util.spec_from_file_location("native_review_contract", SOURCE / "native-host.py")
native = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(native)
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=")
PNG_HASH = hashlib.sha256(PNG).hexdigest()
UUID = "12345678-1234-4234-9234-123456789abc"


def payload():
    annotation = {"id": 7, "text": "这里需要对齐", "category": "视觉", "shot": "shots/007.png", "refs": []}
    task = {"id": 7, "key": "project-1:batch-1:7", "rawComment": annotation["text"], "category": annotation["category"],
            "evidence": {"screenshot": annotation["shot"], "references": []}}
    return {"batch": {"schemaVersion": 1, "projectId": "project-1", "batchId": "batch-1", "nextId": 8,
                      "annotations": [annotation]},
            "aiTasks": {"schemaVersion": 1, "project": {"id": "project-1"}, "batch": {"id": "batch-1"}, "tasks": [task]},
            "markdown": "# 合成批注\n", "assets": {"shots/007.png": "data:image/png;base64," + base64.b64encode(PNG).decode()}}


def reviewed(state="approved"):
    data = payload()
    spec = {"schemaVersion": 1, "state": state, "decisionId": UUID, "problem": "左右内容未对齐",
            "requestedChange": "使左右边界对齐", "acceptanceCriteria": ["对齐且正文不被裁切"],
            "evidenceRefs": ["shots/007.png"], "evidenceHashes": {"shots/007.png": PNG_HASH},
            "contextHash": "c" * 64, "needsConfirmation": []}
    entry = {"approvalId": UUID, "basisSourceHash": "a" * 64, "appliesToSourceHash": "b" * 64,
             "contextHash": "c" * 64, "sourceItemRevision": None, "state": state, "spec": spec}
    data["batch"]["approvedSnapshot"] = {"schemaVersion": 1, "entries": {"7": entry}}
    data["aiTasks"]["schemaVersion"] = 2
    data["aiTasks"]["tasks"][0]["approvedReview"] = copy.deepcopy(spec)
    return data


def entry(data):
    return data["batch"]["approvedSnapshot"]["entries"]["7"]


def set_spec(data, field, value):
    entry(data)["spec"][field] = value
    data["aiTasks"]["tasks"][0]["approvedReview"] = copy.deepcopy(entry(data)["spec"])


class ReviewContractTest(unittest.TestCase):
    def test_v1_validation_does_not_mutate_or_add_review_fields(self):
        data = payload()
        before = copy.deepcopy(data)
        batch, tasks, markdown, decoded = native.validate_payload(data)
        self.assertEqual(data, before)
        self.assertEqual((batch, tasks, markdown), (data["batch"], data["aiTasks"], data["markdown"]))
        self.assertEqual(decoded, {"shots/007.png": PNG})

    def test_all_review_states_are_preserved_without_source_validation(self):
        for state in ("approved", "needs_confirmation", "needs_reconfirmation", "withdrawn"):
            with self.subTest(state=state):
                data = reviewed(state)
                before = copy.deepcopy(data)
                native.validate_payload(data)
                self.assertEqual(data, before)
        # Format-valid H0/H1 are deliberately unrelated to current data in this slice.
        # The store must keep the execution gate closed, not treat this as source approval.
        self.assertEqual(entry(reviewed())["appliesToSourceHash"], "b" * 64)

    def test_v1_rejects_presence_of_review_semantics_even_null(self):
        for location in ("batch", "task"):
            for value in (None, {}, False):
                with self.subTest(location=location, value=value):
                    data = payload()
                    if location == "batch":
                        data["batch"]["approvedSnapshot"] = value
                    else:
                        data["aiTasks"]["tasks"][0]["approvedReview"] = value
                    with self.assertRaises(native.ReviewContractError) as raised:
                        native.validate_payload(data)
                    self.assertEqual(raised.exception.code, "TASK_CONTRACT_DOWNGRADE")

    def test_snapshot_entry_and_reviewed_task_sets_must_match(self):
        for mutation in ("missing_snapshot", "empty", "extra", "padded_id", "no_task_spec", "duplicate_task"):
            with self.subTest(mutation=mutation):
                data = reviewed()
                if mutation == "missing_snapshot":
                    del data["batch"]["approvedSnapshot"]
                elif mutation == "empty":
                    data["batch"]["approvedSnapshot"]["entries"] = {}
                elif mutation == "extra":
                    data["batch"]["approvedSnapshot"]["entries"]["8"] = copy.deepcopy(entry(data))
                elif mutation == "padded_id":
                    data["batch"]["approvedSnapshot"]["entries"] = {"07": entry(data)}
                elif mutation == "no_task_spec":
                    del data["aiTasks"]["tasks"][0]["approvedReview"]
                else:
                    data["aiTasks"]["tasks"].append(copy.deepcopy(data["aiTasks"]["tasks"][0]))
                with self.assertRaises(ValueError):
                    native.validate_payload(data)

    def test_mixed_v2_batch_keeps_unreviewed_task_unmodified(self):
        data = reviewed()
        annotation = {"id": 9, "text": "补充文案", "category": "文案", "refs": []}
        task = {"id": 9, "key": "project-1:batch-1:9", "rawComment": "补充文案", "category": "文案",
                "evidence": {"screenshot": None, "references": []}}
        data["batch"]["nextId"] = 10
        data["batch"]["annotations"].append(annotation)
        data["aiTasks"]["tasks"].append(copy.deepcopy(task))
        native.validate_payload(data)
        self.assertEqual(data["aiTasks"]["tasks"][1], task)

    def test_spec_correspondence_uses_json_types_not_python_number_equality(self):
        for field, value in (("requestedChange", "不同改动"), ("schemaVersion", True), ("schemaVersion", 1.0)):
            with self.subTest(field=field, value=value):
                data = reviewed()
                data["aiTasks"]["tasks"][0]["approvedReview"][field] = value
                with self.assertRaises(native.ReviewContractError):
                    native.validate_payload(data)

    def test_spec_shape_types_states_and_limits_are_strict(self):
        cases = [("schemaVersion", True), ("state", "complete"), ("state", []), ("decisionId", "not-a-uuid"),
                 ("problem", " "), ("problem", "x" * 2001), ("requestedChange", ""), ("requestedChange", "x" * 3001),
                 ("acceptanceCriteria", []), ("acceptanceCriteria", [" "]), ("acceptanceCriteria", ["ok"] * 9),
                 ("needsConfirmation", ["业务规则是什么"]), ("extraAuthority", True)]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                data = reviewed()
                set_spec(data, field, value)
                if field == "state":
                    entry(data)["state"] = value
                with self.assertRaises(native.ReviewContractError):
                    native.validate_payload(data)

    def test_entry_shape_identity_and_context_correspondence_are_strict(self):
        cases = [("approvalId", UUID.upper()), ("basisSourceHash", "g" * 64), ("appliesToSourceHash", "b" * 63),
                 ("contextHash", "d" * 64), ("sourceItemRevision", "old"), ("state", "withdrawn"),
                 ("runCommand", "echo ignored"), ("contextSnapshot", []), ("basisSnapshot", {"text": "x" * 32768})]
        for field, value in cases:
            with self.subTest(field=field):
                data = reviewed()
                entry(data)[field] = value
                with self.assertRaises(native.ReviewContractError):
                    native.validate_payload(data)

    def test_only_referenced_actual_image_bytes_satisfy_evidence_hashes(self):
        cases = [("evidenceHashes", {"shots/007.png": "d" * 64}), ("evidenceHashes", {}),
                 ("evidenceHashes", {"shots/007.png": PNG_HASH, "refs/extra.png": PNG_HASH}),
                 ("evidenceRefs", ["shots/007.png", "shots/007.png"]), ("evidenceRefs", ["refs/../secret.png"])]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                data = reviewed()
                set_spec(data, field, value)
                with self.assertRaises(ValueError):
                    native.validate_payload(data)
        data = reviewed()
        set_spec(data, "evidenceRefs", ["refs/unreferenced.png"])
        set_spec(data, "evidenceHashes", {"refs/unreferenced.png": PNG_HASH})
        with self.assertRaises(native.ReviewContractError):
            native.validate_payload(data)

    def test_direct_snapshot_validation_rechecks_original_identity_and_content(self):
        for field, value in (("key", "other:batch-1:7"), ("rawComment", "替换原话"), ("category", "交互")):
            with self.subTest(field=field):
                data = reviewed()
                data["aiTasks"]["tasks"][0][field] = value
                with self.assertRaises(native.ReviewContractError):
                    native.validate_review_contract(data["batch"], data["aiTasks"], {"shots/007.png": PNG_HASH})
        data = reviewed()
        data["aiTasks"]["project"]["id"] = "other"
        with self.assertRaises(native.ReviewContractError):
            native.validate_payload(data)

    def test_task_key_matches_existing_javascript_encoding(self):
        data = reviewed()
        project, batch = "项目:一/!*'()", "批次二:三/"
        data["batch"].update(projectId=project, batchId=batch)
        data["aiTasks"]["project"]["id"] = project
        data["aiTasks"]["batch"]["id"] = batch
        data["aiTasks"]["tasks"][0]["key"] = "%E9%A1%B9%E7%9B%AE%3A%E4%B8%80%2F!*'():%E6%89%B9%E6%AC%A1%E4%BA%8C%3A%E4%B8%89%2F:7"
        native.validate_payload(data)

    def test_v2_send_rejects_before_config_queue_or_disk_access(self):
        with tempfile.TemporaryDirectory(prefix="kepler-review-contract-") as folder:
            for configured in (False, True):
                with self.subTest(configured=configured):
                    root = Path(folder) / "handoffs"
                    config = {"dataRoot": str(root)}
                    if configured:
                        config.update(defaultThread=UUID, codexPath=str(Path(folder) / "unused"))
                    host = native.Host(config)
                    data = reviewed()
                    data["op"] = "send"
                    with patch.object(native.subprocess, "run", side_effect=AssertionError("no queue")), \
                            patch.object(native, "secure_dir", side_effect=AssertionError("no disk")):
                        result = host.handle(data)
                    self.assertFalse(result["ok"])
                    self.assertEqual(result["code"], "TASK_CONTRACT_UNSUPPORTED_FOR_SEND")
                    self.assertFalse(root.exists())

    def test_project_read_forwards_explicit_acknowledgement(self):
        class FakeStore:
            def read(self, project, batch, **kwargs):
                return {"project": project, "batch": batch, **kwargs}
        with tempfile.TemporaryDirectory(prefix="kepler-review-contract-") as folder:
            host = native.Host({"dataRoot": str(Path(folder) / "handoffs")})
            host.project_store = FakeStore()
            self.assertEqual(host.handle({"op": "project-read", "projectId": "p", "batchId": "b", "acceptTaskContract": 2}),
                             {"project": "p", "batch": "b", "compact": True, "accept_task_contract": 2})


if __name__ == "__main__":
    unittest.main()
