"""v2 review storage is preserved but cannot execute before source binding is validated."""
import copy
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[1]
FIXTURES = runpy.run_path(str(SOURCE / "tests/project-store.test.py"))
payload = FIXTURES["payload"]
PNG = FIXTURES["PNG"]
GIT = shutil.which("git")
SOURCE_HASH = runpy.run_path(str(SOURCE / "review_source.py"))["source_hash"]


def review_payload(state="approved", ids=(7,)):
    data = payload(ids=ids)
    data["aiTasks"]["schemaVersion"] = 2
    data["aiTasks"]["project"] = {"id": data["batch"]["projectId"]}
    annotation = data["batch"]["annotations"][0]
    evidence = [annotation["shot"], *annotation["refs"]]
    decision_id = "12345678-1234-4234-9234-" + {
        "approved": "123456789abc", "needs_confirmation": "123456789abd",
        "needs_reconfirmation": "123456789abe", "withdrawn": "123456789abf",
    }[state]
    spec = {"schemaVersion": 1, "state": state, "decisionId": decision_id,
            "problem": "合成卡片的按钮未对齐", "requestedChange": "按现有布局规则对齐按钮",
            "acceptanceCriteria": ["同一行按钮的起始边缘对齐"], "evidenceRefs": evidence,
            "evidenceHashes": {path: hashlib.sha256(PNG).hexdigest() for path in evidence},
            "contextHash": "c" * 64, "needsConfirmation": []}
    if state in ("needs_confirmation", "needs_reconfirmation"):
        spec["needsConfirmation"] = ["请确认当前页面布局要求"]
    entry = {"approvalId": spec["decisionId"], "basisSourceHash": "a" * 64,
             "appliesToSourceHash": SOURCE_HASH(annotation, {path: hashlib.sha256(PNG).hexdigest() for path in evidence}), "contextHash": spec["contextHash"],
             "sourceItemRevision": "d" * 64, "state": state, "spec": copy.deepcopy(spec)}
    data["batch"]["approvedSnapshot"] = {"schemaVersion": 1, "entries": {str(annotation["id"]): entry}}
    data["aiTasks"]["tasks"][0]["approvedReview"] = spec
    return data


@unittest.skipUnless(GIT, "Project storage tests require Git")
class ReviewStoreTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="kepler-review-store-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.repo = self.root / "repository"
        self.repo.mkdir()
        subprocess.run([GIT, "-c", "core.hooksPath=/dev/null", "-C", str(self.repo), "init", "-q"],
                       shell=False, capture_output=True, check=True)
        self.config = {"dataRoot": str(self.root / "support/handoffs")}
        self.module = runpy.run_path(str(SOURCE / "project_store.py"))
        self.store = self.module["ProjectStore"](self.config)
        self.store.bind("project-1", str(self.repo))

    def read(self, **kwargs):
        return self.store.read("project-1", "batch-1", **kwargs)

    def result(self, revision, status="待确认", number=7, **kwargs):
        return self.store.result("project-1", "batch-1", number, revision, status, "合成测试记录", **kwargs)

    def assert_error(self, code, function, *args, **kwargs):
        with self.assertRaises(ValueError) as caught:
            function(*args, **kwargs)
        self.assertEqual(getattr(caught.exception, "code", None), code, str(caught.exception))

    def rewrite_snapshot(self, response, data):
        """Make checksums self-consistent; semantic validation must still reject invalid review data."""
        folder = Path(response["folder"])
        meta = self.module["read_json"](folder / "snapshot.json")
        revision = self.module["snapshot_hash"]("project-1", data["batch"], data["aiTasks"],
                                                   data["markdown"], meta["images"])
        meta["revision"] = revision
        meta["itemRevisions"] = self.module["item_revisions"](data["batch"], data["aiTasks"], meta["images"])
        self.module["save_json"](folder / "annotations.json", data["batch"])
        self.module["save_json"](folder / "ai-tasks.json", data["aiTasks"])
        self.module["save_json"](folder / "snapshot.json", meta)
        folder.rename(folder.with_name(revision))
        self.module["save_json"](folder.parent.parent / "HEAD", {
            "projectId": "project-1", "batchId": "batch-1", "revision": revision})
        # Semantic corruption tests intentionally rewrite both pointers. This
        # exercises snapshot validation rather than the separate rollback guard.
        anchor = folder.parent.parent / "review-head-checkpoint.json"
        if anchor.exists():
            self.module["save_json"](anchor, {"schemaVersion": 1, "projectId": "project-1",
                                              "batchId": "batch-1", "revision": revision})

    def test_v1_golden_hashes_and_read_shape_remain_unchanged(self):
        response = self.store.sync(payload())
        self.assertEqual(response["revision"], "8b8b1e81b00cad98d2fec5b85e569d536054d50a67625d7d3d31f839b06af2c7")
        item = self.read()["items"][0]
        self.assertEqual(item["revision"], "4d06de314225fd70cddc0c507603228e339e42c243ffbc7555f096d037ceba11")
        self.assertNotIn("reviewGate", item)
        self.assertNotIn("approvedReview", item["task"])
        self.result(item["revision"], status="无需修改")
        self.assertFalse(self.read()["items"][0]["needsWork"])

    def test_h1_mismatch_rejects_sync_without_replacing_good_head(self):
        good = self.store.sync(review_payload())
        forged = review_payload()
        forged["batch"]["approvedSnapshot"]["entries"]["7"]["appliesToSourceHash"] = "b" * 64
        self.assert_error("INVALID_REVIEW_CONTRACT", self.store.sync, forged)
        self.assertEqual(self.read(accept_task_contract=2)["revision"], good["revision"])

    def test_changed_original_text_cannot_reuse_approved_h1_hash(self):
        good = self.store.sync(review_payload())
        changed = review_payload()
        changed["batch"]["annotations"][0]["text"] = "新批注原话"
        changed["aiTasks"]["tasks"][0]["rawComment"] = "新批注原话"
        self.assert_error("INVALID_REVIEW_CONTRACT", self.store.sync, changed)
        self.assertEqual(self.read(accept_task_contract=2)["revision"], good["revision"])


    def test_review_uuid_cannot_be_reused_for_modified_item_or_decision(self):
        original = self.store.sync(review_payload())
        self.assertEqual(self.store.sync(review_payload())["revision"], original["revision"])
        changed_spec = review_payload()
        changed_spec["batch"]["approvedSnapshot"]["entries"]["7"]["spec"]["requestedChange"] = "另一项改动"
        changed_spec["aiTasks"]["tasks"][0]["approvedReview"]["requestedChange"] = "另一项改动"

        changed_source = review_payload()
        annotation = changed_source["batch"]["annotations"][0]
        annotation["text"] = "另一个合成问题"
        changed_source["aiTasks"]["tasks"][0]["rawComment"] = annotation["text"]
        changed_source["batch"]["approvedSnapshot"]["entries"]["7"]["appliesToSourceHash"] = SOURCE_HASH(
            annotation, {path: hashlib.sha256(PNG).hexdigest()
                         for path in [annotation["shot"], *annotation["refs"]]})

        changed_approval_id = review_payload()
        changed_approval_id["batch"]["approvedSnapshot"]["entries"]["7"]["approvalId"] = (
            "12345678-1234-4234-9234-123456789acd")
        changed_decision_id = review_payload()
        new_id = "12345678-1234-4234-9234-123456789ace"
        changed_decision_id["batch"]["approvedSnapshot"]["entries"]["7"]["spec"]["decisionId"] = new_id
        changed_decision_id["aiTasks"]["tasks"][0]["approvedReview"]["decisionId"] = new_id

        for data in (changed_spec, changed_source, changed_approval_id, changed_decision_id):
            with self.subTest(version=data["batch"]["approvedSnapshot"]["entries"]["7"]):
                self.assert_error("REVIEW_DECISION_REPLAY", self.store.sync, data)
                self.assertEqual(self.read(accept_task_contract=2)["revision"], original["revision"])

    def test_same_review_survives_unrelated_batch_edits_but_withdrawal_needs_fresh_ids(self):
        first = self.store.sync(review_payload())
        expanded = self.store.sync(review_payload(ids=(7, 11)))
        old = {item["id"]: item["revision"] for item in first["items"]}
        new = {item["id"]: item["revision"] for item in expanded["items"]}
        self.assertEqual(old[7], new[7])
        self.assertEqual(expanded["items"][0]["reviewGate"]["executable"], False)

        withdrawn = self.store.sync(review_payload(state="withdrawn", ids=(7, 11)))
        self.assertNotEqual(withdrawn["items"][0]["revision"], new[7])
        self.assertEqual(self.store.sync(review_payload(state="withdrawn", ids=(7, 11)))["revision"],
                         withdrawn["revision"])
        self.assertFalse(self.read(accept_task_contract=2)["items"][0]["reviewGate"]["executable"])

    def test_old_review_cannot_be_restored_after_withdrawal(self):
        first = self.store.sync(review_payload())
        newer = self.store.sync(review_payload(state="withdrawn"))
        self.assertNotEqual(first["revision"], newer["revision"])
        self.assert_error("REVIEW_DECISION_REWIND", self.store.sync, review_payload())
        self.assertEqual(self.read(accept_task_contract=2)["revision"], newer["revision"])
        self.assertEqual(self.store.sync(review_payload(state="withdrawn"))["revision"], newer["revision"])

    def test_old_review_cannot_be_restored_after_item_deletion(self):
        first = self.store.sync(review_payload())
        deleted = self.store.sync(payload(ids=()))
        self.assertNotEqual(first["revision"], deleted["revision"])
        self.assert_error("REVIEW_DECISION_REWIND", self.store.sync, review_payload())
        self.assertEqual(self.read()["revision"], deleted["revision"])
        fresh = self.store.sync(review_payload(state="withdrawn"))
        self.assertFalse(fresh["items"][0]["reviewGate"]["executable"])

    def test_v2_read_and_result_require_exact_explicit_acknowledgement(self):
        response = self.store.sync(review_payload())
        revision = response["items"][0]["revision"]
        for accepted in (None, True, "2", 2.0, 1):
            with self.subTest(accepted=accepted):
                self.assert_error("TASK_CONTRACT_ACK_REQUIRED", self.read, accept_task_contract=accepted)
                self.assert_error("TASK_CONTRACT_ACK_REQUIRED", self.result, revision, accept_task_contract=accepted)
        item = self.read(accept_task_contract=2)["items"][0]
        self.assertEqual(item["reviewGate"], {"code": "SOURCE_VALIDATION_PENDING", "executable": False})
        self.assertEqual(item["task"]["approvedReview"]["state"], "approved")
        self.assertEqual(item["rawComment"], "原话 #7")
        self.assertEqual(self.store.batches("project-1")["batches"][0]["count"], 1)

    def test_acknowledgement_never_unblocks_review_completion(self):
        for state in ("approved", "needs_confirmation", "needs_reconfirmation", "withdrawn"):
            with self.subTest(state=state):
                response = self.store.sync(review_payload(state=state))
                revision = response["items"][0]["revision"]
                for status in ("待验收", "无需修改"):
                    self.assert_error("REVIEW_SOURCE_VALIDATION_PENDING", self.result, revision,
                                      status=status, accept_task_contract=2)
                self.result(revision, status="处理中", accept_task_contract=2)
                self.result(revision, status="待确认", accept_task_contract=2)
                item = self.read(accept_task_contract=2)["items"][0]
                self.assertEqual(item["result"]["revision"], revision)
                self.assertEqual(item["result"]["status"], "待确认")
                self.assertTrue(item["needsWork"])
                self.assertEqual(item["task"]["approvedReview"]["state"], state)

    def test_mixed_batch_preserves_unreviewed_revision_and_result_behavior(self):
        ordinary = self.store.sync(payload(ids=(7, 11)))
        old = {item["id"]: item["revision"] for item in ordinary["items"]}
        self.result(old[7], status="无需修改")
        current = self.store.sync(review_payload(ids=(7, 11)))
        items = {item["id"]: item for item in current["items"]}
        self.assertNotEqual(items[7]["revision"], old[7])
        self.assertIsNone(items[7]["result"])
        self.assertEqual(items[11]["revision"], old[11])
        self.assertNotIn("reviewGate", items[11])
        self.assert_error("TASK_CONTRACT_ACK_REQUIRED", self.result, old[11], number=11, status="无需修改")
        self.result(old[11], number=11, status="无需修改", accept_task_contract=2)
        ordinary_item = self.read(accept_task_contract=2)["items"][1]
        self.assertFalse(ordinary_item["needsWork"])
        self.assert_error("STALE_ITEM_REVISION", self.result, old[7], accept_task_contract=2)

    def test_sync_cannot_drop_review_from_a_surviving_item(self):
        response = self.store.sync(review_payload())
        self.assert_error("TASK_CONTRACT_DOWNGRADE", self.store.sync, payload())
        self.assert_error("TASK_CONTRACT_DOWNGRADE", self.store.sync, review_payload(ids=(11, 7)))
        self.assertEqual(self.read(accept_task_contract=2)["revision"], response["revision"])
        withdrawn = self.store.sync(review_payload(state="withdrawn"))
        self.assertNotEqual(withdrawn["items"][0]["revision"], response["items"][0]["revision"])

    def test_delete_and_reintroduce_same_id_cannot_revive_old_v1_result(self):
        original = self.store.sync(payload())
        self.result(original["items"][0]["revision"], status="无需修改")
        self.store.sync(review_payload())
        deleted = self.store.sync(payload(ids=()))
        self.assertEqual(self.read()["items"], [])
        self.assert_error("TASK_CONTRACT_DOWNGRADE", self.store.sync, payload())
        self.assertEqual(self.read()["revision"], deleted["revision"])
        restored = self.store.sync(review_payload(state="withdrawn"))
        self.assertIsNone(restored["items"][0]["result"])
        self.assertFalse(restored["items"][0]["reviewGate"]["executable"])

    def test_older_host_head_rollback_cannot_revive_v1_results(self):
        original = self.store.sync(payload())
        self.result(original["items"][0]["revision"], status="无需修改")
        self.store.sync(review_payload())
        # An older host can repoint HEAD without knowing the v2 guard. New readers
        # still have the immutable history and must reject the downgraded task.
        head = Path(original["folder"]).parent.parent / "HEAD"
        self.module["save_json"](head, {"projectId": "project-1", "batchId": "batch-1",
                                      "revision": original["revision"]})
        self.assert_error("REVIEW_HEAD_ROLLBACK", self.read)
        self.assert_error("REVIEW_HEAD_ROLLBACK", self.result, original["items"][0]["revision"])

    def test_since_v2_history_requires_ack_even_when_current_is_v1(self):
        reviewed = self.store.sync(review_payload())
        self.store.sync(payload(ids=()))
        self.assert_error("TASK_CONTRACT_ACK_REQUIRED", self.read, since=reviewed["cursor"])
        delta = self.read(since=reviewed["cursor"], accept_task_contract=2)
        self.assertEqual(delta["deleted"], [{"id": 7, "revision": reviewed["items"][0]["revision"],
                                           "tombstone": True, "needsWork": False}])

    def test_since_v1_history_does_not_bypass_current_v2_ack(self):
        previous = self.store.sync(payload())
        self.store.sync(review_payload())
        self.assert_error("TASK_CONTRACT_ACK_REQUIRED", self.read, since=previous["cursor"])
        delta = self.read(since=previous["cursor"], accept_task_contract=2)
        self.assertEqual([item["id"] for item in delta["modified"]], [7])

    def test_disk_semantics_are_validated_even_with_correct_checksums(self):
        data = review_payload()
        response = self.store.sync(data)
        data["aiTasks"]["tasks"][0]["approvedReview"]["requestedChange"] = "与批准快照不一致"
        self.rewrite_snapshot(response, data)
        self.assert_error("INVALID_REVIEW_CONTRACT", self.read, accept_task_contract=2)
        self.assert_error("INVALID_REVIEW_CONTRACT", self.result,
                          response["items"][0]["revision"], accept_task_contract=2)

    def test_disk_evidence_hash_is_checked_against_actual_image_bytes(self):
        data = review_payload()
        response = self.store.sync(data)
        data["aiTasks"]["tasks"][0]["approvedReview"]["evidenceHashes"]["shots/7.png"] = "e" * 64
        data["batch"]["approvedSnapshot"]["entries"]["7"]["spec"] = copy.deepcopy(
            data["aiTasks"]["tasks"][0]["approvedReview"])
        self.rewrite_snapshot(response, data)
        self.assert_error("INVALID_REVIEW_CONTRACT", self.read, accept_task_contract=2)

    def test_review_disguised_as_v1_on_disk_is_rejected(self):
        data = payload()
        response = self.store.sync(data)
        data["batch"]["approvedSnapshot"] = review_payload()["batch"]["approvedSnapshot"]
        self.rewrite_snapshot(response, data)
        self.assert_error("TASK_CONTRACT_DOWNGRADE", self.read)

    def test_v2_snapshot_internal_project_must_match_requested_project(self):
        data = review_payload()
        response = self.store.sync(data)
        data["batch"]["projectId"] = "project-2"
        data["aiTasks"]["project"]["id"] = "project-2"
        data["aiTasks"]["tasks"][0]["key"] = "project-2:batch-1:7"
        self.rewrite_snapshot(response, data)
        self.assert_error("CORRUPT_SNAPSHOT", self.read, accept_task_contract=2)

    def test_v2_snapshot_internal_batch_must_match_requested_batch(self):
        data = review_payload()
        response = self.store.sync(data)
        data["batch"]["batchId"] = "batch-2"
        data["aiTasks"]["batch"]["id"] = "batch-2"
        data["aiTasks"]["tasks"][0]["key"] = "project-1:batch-2:7"
        self.rewrite_snapshot(response, data)
        self.assert_error("CORRUPT_SNAPSHOT", self.read, accept_task_contract=2)

    def test_native_project_read_forwards_acknowledgement(self):
        host = runpy.run_path(str(SOURCE / "native-host.py"))["Host"](self.config)
        synced = host.handle(review_payload())
        self.assertTrue(synced["ok"], synced)
        request = {"op": "project-read", "projectId": "project-1", "batchId": "batch-1"}
        rejected = host.handle(request)
        self.assertFalse(rejected["ok"])
        self.assertEqual(rejected["code"], "TASK_CONTRACT_ACK_REQUIRED")
        accepted = host.handle(dict(request, acceptTaskContract=2))
        self.assertTrue(accepted["ok"], accepted)
        self.assertEqual(accepted["items"], synced["items"])
        self.assertFalse(accepted["items"][0]["reviewGate"]["executable"])

    def test_cli_read_result_acknowledgement_and_gate(self):
        synced = self.store.sync(review_payload())
        config_file = self.root / "native-test-config.json"
        self.module["save_json"](config_file, self.config)
        environment = dict(os.environ, KEPLER_ANNOTATE_CONFIG=str(config_file))

        def cli(command, *extra):
            process = subprocess.run([sys.executable, "-B", str(SOURCE / "kepler-annotations.py"),
                                      command, "--project", "project-1", "--batch", "batch-1", *extra],
                                     shell=False, capture_output=True, text=True, env=environment)
            return process.returncode, json.loads(process.stdout)

        exit_code, rejected = cli("read")
        self.assertEqual(exit_code, 1)
        self.assertEqual(rejected["code"], "TASK_CONTRACT_ACK_REQUIRED")
        exit_code, accepted = cli("read", "--accept-task-contract", "2")
        self.assertEqual(exit_code, 0)
        self.assertFalse(accepted["items"][0]["reviewGate"]["executable"])
        arguments = ("--id", "7", "--revision", synced["items"][0]["revision"], "--summary", "合成 CLI 结果")
        exit_code, rejected = cli("result", *arguments, "--status", "待确认")
        self.assertEqual(exit_code, 1)
        self.assertEqual(rejected["code"], "TASK_CONTRACT_ACK_REQUIRED")
        exit_code, accepted = cli("result", *arguments, "--status", "待确认", "--accept-task-contract", "2")
        self.assertEqual(exit_code, 0)
        self.assertEqual(accepted["result"]["status"], "待确认")
        for status in ("待验收", "无需修改"):
            exit_code, rejected = cli("result", *arguments, "--status", status, "--accept-task-contract", "2")
            self.assertEqual(exit_code, 1)
            self.assertEqual(rejected["code"], "REVIEW_SOURCE_VALIDATION_PENDING")


    def linked_review(self):
        """Construct a synthetic opt-in review referencing a real v1 item revision."""
        baseline = self.store.sync(payload())
        data = review_payload()
        record = data["batch"]["approvedSnapshot"]["entries"]["7"]
        record["sourceItemRevision"] = baseline["items"][0]["revision"]
        basis = payload()["batch"]["annotations"][0]
        hashes = {name: hashlib.sha256(PNG).hexdigest() for name in [basis["shot"], *basis["refs"]]}
        record["basisSourceHash"] = SOURCE_HASH(basis, hashes)
        record["sourceTransform"] = {"schemaVersion": 1, "adoptedCategory": None, "addedEvidence": []}
        return baseline, data

    def test_historical_h0_revision_is_bound_but_cannot_grant_execution(self):
        baseline, data = self.linked_review()
        accepted = self.store.sync(data)
        self.assertNotEqual(accepted["revision"], baseline["revision"])
        item = self.read(accept_task_contract=2)["items"][0]
        self.assertEqual(item["reviewGate"], {"code": "SOURCE_VALIDATION_PENDING", "executable": False})
        self.assert_error("REVIEW_SOURCE_VALIDATION_PENDING", self.result, item["revision"],
                          status="待验收", accept_task_contract=2)

    def test_h0_mismatch_or_undeclared_changes_fail_without_changing_head(self):
        baseline, linked = self.linked_review()
        for mutation in ("fake_item_revision", "cursor_instead_of_item", "wrong_basis_hash",
                         "undeclared_category", "rewritten_comment", "invalid_transform"):
            with self.subTest(mutation=mutation):
                data = copy.deepcopy(linked)
                entry = data["batch"]["approvedSnapshot"]["entries"]["7"]
                if mutation == "fake_item_revision":
                    entry["sourceItemRevision"] = "0" * 64
                elif mutation == "cursor_instead_of_item":
                    entry["sourceItemRevision"] = baseline["cursor"]
                elif mutation == "wrong_basis_hash":
                    entry["basisSourceHash"] = "a" * 64
                elif mutation in ("undeclared_category", "rewritten_comment"):
                    annotation = data["batch"]["annotations"][0]
                    task = data["aiTasks"]["tasks"][0]
                    if mutation == "undeclared_category":
                        annotation["category"] = "交互"
                        task["category"] = "交互"
                    else:
                        annotation["text"] = "篡改后原话"
                        task["rawComment"] = annotation["text"]
                    hashes = {name: hashlib.sha256(PNG).hexdigest() for name in
                              [annotation["shot"], *annotation["refs"]]}
                    entry["appliesToSourceHash"] = SOURCE_HASH(annotation, hashes)
                else:
                    entry["sourceTransform"]["adoptedCategory"] = "交互"
                expected = ("REVIEW_BASIS_NOT_FOUND" if mutation in
                            ("fake_item_revision", "cursor_instead_of_item") else "INVALID_REVIEW_BASIS")
                self.assert_error(expected, self.store.sync, data)
                self.assertEqual(self.read()["revision"], baseline["revision"])

    def test_missing_historical_basis_rejects_read_and_result_after_sync(self):
        baseline, data = self.linked_review()
        accepted = self.store.sync(data)
        original = Path(baseline["folder"])
        hidden = original.with_name("temporarily-hidden-" + original.name)
        original.rename(hidden)
        try:
            self.assert_error("REVIEW_BASIS_NOT_FOUND", self.read, accept_task_contract=2)
            self.assert_error("REVIEW_BASIS_NOT_FOUND", self.result,
                              accepted["items"][0]["revision"], accept_task_contract=2)
        finally:
            hidden.rename(original)
        self.assertEqual(self.read(accept_task_contract=2)["revision"], accepted["revision"])


    def test_review_head_checkpoint_rejects_byte_identical_old_decision(self):
        old = self.store.sync(review_payload())
        latest = self.store.sync(review_payload(state="withdrawn"))
        location = Path(latest["folder"]).parent.parent
        anchor = location / "review-head-checkpoint.json"
        self.assertEqual(self.module["read_json"](anchor)["revision"], latest["revision"])
        head = location / "HEAD"
        self.module["save_json"](head, {"projectId": "project-1", "batchId": "batch-1",
                                        "revision": old["revision"]})
        self.assert_error("REVIEW_HEAD_ROLLBACK", self.read, accept_task_contract=2)
        self.assert_error("REVIEW_HEAD_ROLLBACK", self.result, old["items"][0]["revision"],
                          accept_task_contract=2)
        self.assert_error("REVIEW_HEAD_ROLLBACK", self.store.batches, "project-1")
        self.assert_error("REVIEW_HEAD_ROLLBACK", self.store.sync, review_payload(state="withdrawn"))
        self.assertEqual(self.module["read_json"](head)["revision"], old["revision"])
        # Recover only by restoring the known-good checkpointed HEAD.
        self.module["save_json"](head, {"projectId": "project-1", "batchId": "batch-1",
                                        "revision": latest["revision"]})
        self.assertEqual(self.read(accept_task_contract=2)["revision"], latest["revision"])

    def test_checkpoint_survives_deleted_review_and_preserves_v1_behavior(self):
        initial = self.store.sync(payload())
        location = Path(initial["folder"]).parent.parent
        anchor = location / "review-head-checkpoint.json"
        self.assertFalse(anchor.exists())
        self.store.sync(review_payload())
        deleted = self.store.sync(payload(ids=()))
        self.assertEqual(self.module["read_json"](anchor)["revision"], deleted["revision"])
        self.assertEqual(self.read()["items"], [])
        self.assertEqual(self.store.sync(payload(ids=()))["revision"], deleted["revision"])
        # Old hosts may know v1 and write HEAD, but cannot silently go backward.
        self.module["save_json"](location / "HEAD", {"projectId": "project-1",
                                                      "batchId": "batch-1", "revision": initial["revision"]})
        self.assert_error("REVIEW_HEAD_ROLLBACK", self.read)
        self.module["save_json"](location / "HEAD", {"projectId": "project-1",
                                                      "batchId": "batch-1", "revision": deleted["revision"]})
        self.assertEqual(self.read()["items"], [])

    def test_corrupt_review_head_checkpoint_is_not_silently_recreated(self):
        saved = self.store.sync(review_payload())
        location = Path(saved["folder"]).parent.parent
        anchor = location / "review-head-checkpoint.json"
        valid = self.module["read_json"](anchor)
        for changed in (dict(valid, projectId="wrong"), dict(valid, revision="0" * 64),
                        dict(valid, schemaVersion=True)):
            with self.subTest(changed=changed):
                self.module["save_json"](anchor, changed)
                self.assert_error("REVIEW_HEAD_ROLLBACK", self.read, accept_task_contract=2)
                self.assert_error("REVIEW_HEAD_ROLLBACK", self.store.sync, review_payload())
        self.module["save_json"](anchor, valid)
        self.assertEqual(self.read(accept_task_contract=2)["revision"], saved["revision"])


if __name__ == "__main__":
    unittest.main()
