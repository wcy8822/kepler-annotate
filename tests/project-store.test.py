"""项目存储契约测试：临时 Git 仓库与假数据，禁止调用真实 queue。"""
import base64
import concurrent.futures
import copy
import hashlib
import importlib.util
import json
import os
import shutil
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[1]
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=")
GIT = shutil.which("git")


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def payload(project="project-1", batch="batch-1", ids=(7,)):
    annotations = [{"id": number, "text": "原话 #" + str(number), "category": "视觉", "status": "待处理",
                    "expected": "左右对齐", "url": "https://example.invalid/view", "elements": [{"selector": "#card"}],
                    "shot": "shots/%s.png" % number, "refs": ["refs/example.png"]} for number in ids]
    tasks = [{"id": item["id"], "key": project + ":" + batch + ":" + str(item["id"]),
              "rawComment": item["text"], "category": item["category"], "expected": item["expected"], "status": item["status"],
              "evidence": {"screenshot": item["shot"], "references": item["refs"], "url": item["url"], "elements": item["elements"]}}
             for item in annotations]
    data = "data:image/png;base64," + base64.b64encode(PNG).decode()
    return {"op": "project-sync", "batch": {"schemaVersion": 1, "projectId": project, "projectName": "项目一",
            "batchId": batch, "name": "第一批", "nextId": max(ids, default=0) + 1, "annotations": annotations},
            "aiTasks": {"schemaVersion": 1, "batch": {"id": batch}, "tasks": tasks}, "markdown": "# 原格式批注\n",
            "assets": {path: data for item in annotations for path in [item["shot"], *item["refs"]]}}


class ProjectStoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if GIT is None:
            raise unittest.SkipTest("项目存储测试需要 PATH 中的 Git")
        cls.workspace = Path(tempfile.mkdtemp(prefix="kepler-project-tests-")).resolve()
        print("测试数据保留于：" + str(cls.workspace), flush=True)

    def setUp(self):
        self.assertTrue((SOURCE / "project_store.py").is_file(), "project_store.py 尚未实现")
        self.root = Path(tempfile.mkdtemp(dir=self.workspace))
        self.repo = self.root / "repository"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("-c", "user.name=KeplerTest", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "--no-verify", "-qm", "测试基线")
        self.commit = self.git("rev-parse", "HEAD").stdout.strip()
        self.config = {"dataRoot": str(self.root / "support/KeplerAnnotate/handoffs"),
                       "codexPath": None, "defaultThread": None}
        self.module = load("kepler_project_store_test", SOURCE / "project_store.py")
        self.store = self.module.ProjectStore(self.config)
        self.host = load("kepler_project_host_test", SOURCE / "native-host.py").Host(self.config)

    def git(self, *args, root=None):
        command = [GIT, "-c", "core.hooksPath=/dev/null", "-C", str(root or self.repo), *args]
        return subprocess.run(command, shell=False, capture_output=True, text=True, check=True)

    def bind(self, project="project-1", root=None):
        return self.store.bind(project, str(root or self.repo), "项目一")

    def sync(self, data=None):
        return self.store.sync(copy.deepcopy(data or payload()))

    def read(self, batch="batch-1", project="project-1", since=None):
        return self.store.read(project, batch, since=since)

    def result(self, revision, **kwargs):
        return self.store.result("project-1", "batch-1", 7, revision, "处理中", "已定位", **kwargs)

    def test_native_info_unbound_and_bind_no_queue(self):
        with patch("subprocess.run", side_effect=AssertionError("info 不运行命令")):
            self.assertEqual(self.host.handle({"op": "project-info", "projectId": "project-1"})["binding"], None)
        response = self.host.handle({"op": "project-bind", "projectId": "project-1", "projectName": "项目一", "projectRoot": str(self.repo)})
        self.assertTrue(response["ok"], response)
        self.assertEqual(response["binding"], {"projectId": "project-1", "projectName": "项目一", "projectRoot": str(self.repo)})
        info = self.host.handle({"op": "info"})
        self.assertTrue(info["ok"])
        self.assertIsNone(info["defaultThread"])
        self.assertEqual(info["capabilities"]["taskContracts"], [1, 2])
        self.assertFalse(info["capabilities"]["sourceBindingValidation"])
        self.assertFalse(info["capabilities"]["reviewExecution"])

    def test_registry_exclude_binding_and_no_tracked_changes(self):
        exclude = self.repo / ".git/info/exclude"
        old = exclude.read_bytes()
        self.bind()
        registry = Path(self.config["dataRoot"]).parent / "projects.json"
        self.assertTrue(registry.is_file())
        self.assertEqual(self.store.projects()["projects"][0]["projectRoot"], str(self.repo))
        self.assertTrue(exclude.read_bytes().startswith(old))
        self.assertIn(b"/.kepler-annotate/", exclude.read_bytes().splitlines())
        before = exclude.read_bytes()
        self.bind()
        self.assertEqual(exclude.read_bytes(), before)
        self.assertFalse((self.repo / ".gitignore").exists())
        self.assertEqual(self.git("status", "--porcelain").stdout, "")

    def test_unbound_sync_is_explicit_and_no_project_writes(self):
        result = self.sync()
        self.assertTrue(result["ok"])
        self.assertFalse(result["bound"])
        self.assertFalse((self.repo / ".kepler-annotate").exists())

    def test_bind_requires_absolute_real_git_root(self):
        child = self.repo / "child"
        child.mkdir()
        outside = self.root / "not-git"
        outside.mkdir()
        link = self.root / "linked-repo"
        link.symlink_to(self.repo, target_is_directory=True)
        for bad in ["relative", str(child), str(outside), str(link), str(self.repo / ".." / "repository")]:
            with self.subTest(root=bad), self.assertRaises(ValueError):
                self.store.bind("p", bad)

    def test_snapshots_original_assets_idempotence_and_private_permissions(self):
        self.bind()
        data = payload()
        first = self.sync(data)
        second = self.sync(data)
        self.assertEqual(first["revision"], second["revision"])
        self.assertEqual(first["folder"], second["folder"])
        folder = Path(first["folder"])
        self.assertRegex(folder.name, r"^[a-f0-9]{64}$")
        self.assertEqual(folder.parent.name, "revisions")
        self.assertEqual(json.loads((folder / "annotations.json").read_text()), data["batch"])
        self.assertEqual(json.loads((folder / "ai-tasks.json").read_text()), data["aiTasks"])
        self.assertEqual((folder / "annotations.md").read_text(), data["markdown"])
        self.assertEqual((folder / "shots/7.png").read_bytes(), PNG)
        for path in [self.repo / ".kepler-annotate", *(self.repo / ".kepler-annotate").rglob("*")]:
            self.assertFalse(path.is_symlink())
            self.assertEqual(path.stat().st_mode & 0o777, 0o700 if path.is_dir() else 0o600)

    def test_read_has_full_original_tasks_absolute_evidence_and_needs_work(self):
        self.bind()
        response = self.sync()
        read = self.read()
        self.assertEqual(read["revision"], response["revision"])
        self.assertEqual(read["cursor"], response["revision"])
        item = read["items"][0]
        self.assertEqual(item["id"], 7)
        self.assertEqual(item["rawComment"], "原话 #7")
        self.assertEqual(item["task"]["expected"], "左右对齐")
        self.assertEqual(Path(item["evidence"]["screenshot"]), Path(response["folder"]) / "shots/7.png")
        self.assertTrue(Path(item["evidence"]["references"][0]).is_absolute())
        self.assertTrue(item["needsWork"])
        self.assertIsNone(item["result"])

    def test_native_sync_and_read_compact_contract(self):
        self.bind()
        synced = self.host.handle(payload())
        self.assertTrue(synced["ok"], synced)
        self.assertEqual(synced["binding"]["projectRoot"], str(self.repo))
        read = self.host.handle({"op": "project-read", "projectId": "project-1", "batchId": "batch-1"})
        self.assertEqual(read["items"], synced["items"])
        self.assertEqual(read["projectRoot"], str(self.repo))

    def test_item_hash_excludes_noise_and_result_survives_other_additions(self):
        self.bind()
        first = self.sync()
        item_revision = first["items"][0]["revision"]
        data = payload(ids=(7, 11))
        for key in ["createdAt", "updatedAt", "status", "batchId", "libraryRevision"]:
            data["batch"]["annotations"][0][key] = "noise"
            data["aiTasks"]["tasks"][0][key] = "noise"
            data["aiTasks"]["tasks"][0]["evidence"][key] = "noise"
        data["aiTasks"]["tasks"][0]["key"] = "changed-global-key"
        second = self.sync(data)
        self.assertEqual(second["items"][0]["revision"], item_revision)
        result = self.result(item_revision)
        self.assertTrue(result["ok"])
        self.assertEqual(self.read()["items"][0]["result"]["summary"], "已定位")
        self.assertTrue(Path(first["folder"]).is_dir())

    def test_every_material_change_invalidates_item_revision(self):
        self.bind()
        first = self.sync()
        revision = first["items"][0]["revision"]
        for field, value in [("text", "修改原话"), ("category", "交互"), ("expected", "新的预期"), ("url", "https://example.invalid/other"), ("elements", [{"selector": "#other"}])]:
            data = payload()
            data["batch"]["annotations"][0][field] = value
            task = data["aiTasks"]["tasks"][0]
            if field == "text": task["rawComment"] = value
            elif field in ("category", "expected"): task[field] = value
            else: task["evidence"][field] = value
            self.assertNotEqual(self.sync(data)["items"][0]["revision"], revision)
        data = payload()
        data["assets"]["refs/example.png"] = "data:image/png;base64," + base64.b64encode(PNG + b"changed-image-bytes").decode()
        self.assertNotEqual(self.sync(data)["items"][0]["revision"], revision)

    def test_old_result_rejected_and_current_result_is_exact_version(self):
        self.bind()
        old = self.sync()["items"][0]["revision"]
        self.result(old)
        data = payload()
        data["batch"]["annotations"][0]["text"] = "新原话"
        data["aiTasks"]["tasks"][0]["rawComment"] = "新原话"
        latest = self.sync(data)["items"][0]
        self.assertNotEqual(latest["revision"], old)
        self.assertIsNone(latest["result"])
        with self.assertRaisesRegex(ValueError, "版本|revision"):
            self.result(old)
        self.assertIsNone(self.read()["items"][0]["result"])

    def test_cursor_added_modified_deleted_tombstones_no_renumber(self):
        self.bind()
        first = self.sync(payload(ids=(7, 11)))
        data = payload(ids=(7, 19))
        data["batch"]["annotations"][0]["text"] = "修改 #7"
        data["aiTasks"]["tasks"][0]["rawComment"] = "修改 #7"
        current = self.sync(data)
        delta = self.read(since=first["revision"])
        self.assertEqual([item["id"] for item in delta["added"]], [19])
        self.assertEqual([item["id"] for item in delta["modified"]], [7])
        self.assertEqual([item["id"] for item in delta["deleted"]], [11])
        self.assertTrue(delta["deleted"][0]["tombstone"])
        self.assertEqual([item["id"] for item in self.read()["items"]], [7, 19])
        same = self.read(since=current["revision"])
        self.assertEqual(same["added"] + same["modified"] + same["deleted"], [])
        with self.assertRaises(ValueError): self.read(since="../bad")

    def test_deleted_item_rejects_writeback(self):
        self.bind()
        first = self.sync()
        self.sync(payload(ids=()))
        with self.assertRaises(ValueError): self.result(first["items"][0]["revision"])

    def test_batch_and_project_isolation_even_same_root(self):
        self.bind()
        self.bind("project-2")
        first = self.sync()
        other_batch = self.sync(payload(batch="batch-2"))
        other_project = self.sync(payload(project="project-2"))
        self.assertEqual(len({first["folder"], other_batch["folder"], other_project["folder"]}), 3)
        self.result(first["items"][0]["revision"])
        self.assertIsNone(self.read(batch="batch-2")["items"][0]["result"])
        self.assertIsNone(self.read(project="project-2")["items"][0]["result"])
        with self.assertRaises(ValueError): self.read(project="project-2", since=first["revision"])
        self.assertEqual({b["batchId"] for b in self.store.batches("project-1")["batches"]}, {"batch-1", "batch-2"})

    def test_untrusted_identifiers_are_hashed_not_used_as_paths(self):
        project, batch = "../../p", "../../batch"
        self.bind(project)
        result = self.sync(payload(project=project, batch=batch))
        self.assertTrue(Path(result["folder"]).is_relative_to(self.repo / ".kepler-annotate"))
        self.assertEqual(self.read(project=project, batch=batch)["batchId"], batch)

    def test_missing_or_escaping_images_rejected_before_head_changes(self):
        self.bind()
        first = self.sync()
        data = payload()
        del data["assets"]["shots/7.png"]
        with self.assertRaises(ValueError): self.sync(data)
        data = payload()
        data["batch"]["annotations"][0]["shot"] = "shots/../../escape.png"
        with self.assertRaises(ValueError): self.sync(data)
        self.assertEqual(self.read()["revision"], first["revision"])

    def test_symlink_project_storage_registry_and_git_exclude_rejected(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.repo / ".kepler-annotate").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError): self.bind()
        self.assertEqual(list(outside.iterdir()), [])

    def test_symlink_registry_does_not_read_or_overwrite_target(self):
        support = Path(self.config["dataRoot"]).parent
        support.mkdir(parents=True)
        target = self.root / "unrelated.json"
        target.write_text('{"keep":true}')
        (support / "projects.json").symlink_to(target)
        with self.assertRaises(ValueError): self.bind()
        self.assertEqual(target.read_text(), '{"keep":true}')

    def test_symlink_git_exclude_does_not_touch_other_file(self):
        exclude = self.repo / ".git/info/exclude"
        target = self.root / "other-exclude"
        exclude.rename(target)
        old = target.read_bytes()
        exclude.symlink_to(target)
        with self.assertRaises(ValueError): self.bind()
        self.assertEqual(target.read_bytes(), old)

    def test_symlink_saved_screenshot_read_rejected(self):
        self.bind()
        response = self.sync()
        image = Path(response["folder"]) / "shots/7.png"
        target = image.with_name("preserved.png")
        image.rename(target)
        image.symlink_to(target)
        with self.assertRaises(ValueError): self.read()

    def test_parallel_sync_and_results_keep_atomic_head_and_no_lost_results(self):
        self.bind()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            replies = list(pool.map(lambda _: self.sync(), range(8)))
        self.assertEqual(len({reply["revision"] for reply in replies}), 1)
        many = self.sync(payload(ids=(7, 11, 19)))
        def write(item):
            return self.module.ProjectStore(self.config).result("project-1", "batch-1", item["id"], item["revision"], "处理中", "逐条结果")
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            replies = list(pool.map(write, many["items"]))
        self.assertTrue(all(r["ok"] for r in replies))
        self.assertTrue(all(item["result"] for item in self.read()["items"]))

    def test_failed_head_write_keeps_previous_snapshot(self):
        self.bind()
        first = self.sync()
        real = self.module.atomic_json
        def save(path, value):
            if Path(path).name == "HEAD": raise OSError("fake HEAD failure")
            return real(path, value)
        with patch.object(self.module, "atomic_json", side_effect=save), self.assertRaises(OSError):
            self.sync(payload(ids=(7, 11)))
        self.assertEqual(self.read()["revision"], first["revision"])
        self.assertEqual([item["id"] for item in self.read()["items"]], [7])

    def test_acceptance_status_requires_branch_existing_commit_green_checks(self):
        self.bind()
        revision = self.sync()["items"][0]["revision"]
        self.git("branch", "codex/test", self.commit)
        good = {"branch": "codex/test", "commit": self.commit, "checks": [{"cmd": "fake check", "exitCode": 0}]}
        for bad in [{}, dict(good, branch="feature/test"), dict(good, branch="codex/missing"), dict(good, commit="0" * 40), dict(good, checks=[]),
                    dict(good, checks=[{"cmd": "fake", "exitCode": 1}]), dict(good, checks=[{"cmd": "fake", "exitCode": False}]),
                    dict(good, checks=[{"exitCode": 0}]), dict(good, checks=[{"command": "  ", "exitCode": 0}])]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.store.result("project-1", "batch-1", 7, revision, "待验收", "候选修复", **bad)
        response = self.store.result("project-1", "batch-1", 7, revision, "待验收", "等待验收", **good)
        self.assertTrue(response["ok"])
        item = self.read()["items"][0]
        self.assertEqual(item["result"]["status"], "待验收")
        self.assertEqual(item["result"]["checks"][0].get("command"), "fake check")
        self.assertFalse(item["needsWork"])

    def test_acceptance_commit_must_be_on_the_named_branch(self):
        self.bind()
        revision = self.sync()["items"][0]["revision"]
        self.git("branch", "codex/before", self.commit)
        self.git("-c", "user.name=KeplerTest", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "--no-verify", "-qm", "新提交")
        newer = self.git("rev-parse", "HEAD").stdout.strip()
        checks = [{"command": "fake evidence", "exitCode": 0}]
        with self.assertRaises(ValueError):
            self.store.result("project-1", "batch-1", 7, revision, "待验收", "分支不包含该提交", branch="codex/before", commit=newer, checks=checks)
        self.git("branch", "codex/after", newer)
        result = self.store.result("project-1", "batch-1", 7, revision, "待验收", "祖先提交有效", branch="codex/after", commit=self.commit, checks=checks)
        self.assertTrue(result["ok"])

    def test_statuses_requirements_path_only_and_no_automatic_completion(self):
        self.bind()
        revision = self.sync()["items"][0]["revision"]
        for status in ["处理中", "待确认", "无需修改"]:
            self.store.result("project-1", "batch-1", 7, revision, status, "保留判断", requirements="docs/not-created.md")
            item = self.read()["items"][0]
            self.assertEqual(item["result"]["requirements"], "docs/not-created.md")
            self.assertEqual(item["needsWork"], status != "无需修改")
        with self.assertRaises(ValueError): self.store.result("project-1", "batch-1", 7, revision, "已完成", "禁止自动完成")
        self.assertFalse((self.repo / "docs/not-created.md").exists())

    def test_cli_help_bind_projects_batches_read_and_result(self):
        self.assertTrue((SOURCE / "kepler-annotations.py").is_file())
        scripts = self.root / "cli"
        scripts.mkdir()
        for name in ["native-host.py", "project_store.py", "kepler-annotations.py"]:
            shutil.copyfile(SOURCE / name, scripts / name)
        command = [sys.executable, "-B", str(scripts / "kepler-annotations.py")]
        help_result = subprocess.run(command + ["--help"], capture_output=True, text=True)
        self.assertEqual(help_result.returncode, 0)
        (scripts / "native-host-config.json").write_text(json.dumps(self.config))
        def cli(*args, success=True):
            response = subprocess.run(command + list(args), capture_output=True, text=True)
            self.assertEqual(response.returncode == 0, success, response.stdout + response.stderr)
            return json.loads(response.stdout)
        self.assertTrue(cli("bind", "--project", "project-1", "--path", str(self.repo), "--name", "项目一")["ok"])
        self.assertEqual(cli("projects")["projects"][0]["projectId"], "project-1")
        initial = self.sync()
        self.assertEqual(cli("batches", "--project", "project-1")["batches"][0]["batchId"], "batch-1")
        read = cli("read", "--project", "project-1", "--batch", "batch-1")
        self.assertEqual(read["cursor"], initial["revision"])
        self.assertEqual(cli("read", "--project", "project-1", "--batch", "batch-1", "--since", read["cursor"])["items"], [])
        checks = self.root / "checks.json"
        checks.write_text(json.dumps({"commands": [{"cmd": "fake acceptance", "exitCode": 0}]}))
        self.git("branch", "codex/acceptance", self.commit)
        response = cli("result", "--project", "project-1", "--batch", "batch-1", "--id", "7", "--revision", read["items"][0]["revision"],
                       "--status", "待验收", "--summary", "待人工验收", "--branch", "codex/acceptance", "--commit", self.commit,
                       "--checks-file", str(checks), "--requirements", "docs/requirements.md")
        self.assertTrue(response["ok"])
        cli("read", "--project", "project-1", "--batch", "missing", success=False)

    def test_isolated_config_real_native_process_and_cli_share_registry(self):
        config = self.root / "isolated-config.json"
        config.write_text(json.dumps(self.config))
        environment = dict(os.environ, KEPLER_ANNOTATE_CONFIG=str(config))
        requests = [{"op": "info"}, {"op": "project-bind", "projectId": "project-1", "projectRoot": str(self.repo)},
                    payload(), {"op": "project-read", "projectId": "project-1", "batchId": "batch-1"}]
        data = bytearray()
        for request in requests:
            raw = json.dumps(request).encode()
            data.extend(struct.pack("<I", len(raw)) + raw)
        response = subprocess.run([sys.executable, "-B", str(SOURCE / "native-host.py")], input=bytes(data), capture_output=True, env=environment)
        self.assertEqual(response.returncode, 0, response.stderr)
        replies, raw = [], response.stdout
        while raw:
            length = struct.unpack("<I", raw[:4])[0]
            replies.append(json.loads(raw[4:4 + length]))
            raw = raw[4 + length:]
        self.assertEqual(len(replies), 4)
        self.assertTrue(all(reply["ok"] for reply in replies), replies)
        self.assertIsNone(replies[0]["defaultThread"])
        self.assertEqual(replies[2]["revision"], replies[3]["revision"])
        cli = subprocess.run([sys.executable, "-B", str(SOURCE / "kepler-annotations.py"), "projects"], capture_output=True, text=True, env=environment)
        self.assertEqual(cli.returncode, 0, cli.stderr)
        self.assertEqual([project["projectId"] for project in json.loads(cli.stdout)["projects"]], ["project-1"])

    def test_cross_process_parallel_result_writes_do_not_lose_items(self):
        self.bind()
        current = self.sync(payload(ids=(7, 11, 19, 23)))
        config = self.root / "parallel-config.json"
        config.write_text(json.dumps(self.config))
        environment = dict(os.environ, KEPLER_ANNOTATE_CONFIG=str(config))
        children = [subprocess.Popen([sys.executable, "-B", str(SOURCE / "kepler-annotations.py"), "result", "--project", "project-1",
                    "--batch", "batch-1", "--id", str(item["id"]), "--revision", item["revision"], "--status", "处理中", "--summary", "并发写回"],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment) for item in current["items"]]
        for child in children:
            stdout, stderr = child.communicate(timeout=15)
            self.assertEqual(child.returncode, 0, stderr)
            self.assertTrue(json.loads(stdout)["ok"])
        self.assertTrue(all(item["result"]["summary"] == "并发写回" for item in self.read()["items"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
