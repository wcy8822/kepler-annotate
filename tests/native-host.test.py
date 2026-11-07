"""Native host 契约测试；只调用临时 fake codex，保留测试交接目录便于检查。"""
import base64
import concurrent.futures
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[1]
EXTENSION = "abcdefghijklmnopabcdefghijklmnop"
THREAD = "00000000-0000-4000-8000-000000000001"
OTHER_THREAD = "00000000-0000-4000-8000-000000000002"
CAPABILITIES = {"taskContracts": [1, 2], "reviewTaskValidation": "structure_and_evidence",
                "sourceBindingValidation": False, "reviewExecution": False}
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=")
DATA = "data:image/png;base64," + base64.b64encode(PNG).decode()


def payload():
    return {
        "op": "send", "threadId": THREAD,
        "batch": {"schemaVersion": 1, "batchId": "batch/../用户批次", "name": "第一批",
                  "nextId": 8, "annotations": [{"id": 7, "text": "原话保留：这里需要对齐",
                  "category": "视觉", "shot": "shots/007.png", "refs": ["refs/sample.png"]}]},
        "aiTasks": {"schemaVersion": 1, "batch": {"id": "batch/../用户批次"}, "tasks": [
            {"id": 7, "rawComment": "原话保留：这里需要对齐", "category": "视觉",
             "evidence": {"screenshot": "shots/007.png", "references": ["refs/sample.png"]}}]},
        "markdown": "# 浏览器批注\n\n原话保留：这里需要对齐\n",
        "assets": {"shots/007.png": DATA, "refs/sample.png": DATA}}


def frame(value):
    data = json.dumps(value, ensure_ascii=False).encode()
    return struct.pack("<I", len(data)) + data


def frames(raw):
    result = []
    while raw:
        if len(raw) < 4:
            raise AssertionError("响应头不完整")
        size = struct.unpack("<I", raw[:4])[0]
        if size > 1024 * 1024 or len(raw) < 4 + size:
            raise AssertionError("响应大小或协议无效")
        result.append(json.loads(raw[4:4 + size]))
        raw = raw[4 + size:]
    return result


class NativeHostTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workspace = Path(tempfile.mkdtemp(prefix="kepler-native-tests-")).resolve()
        print("测试数据保留于：" + str(cls.workspace), flush=True)

    def setUp(self):
        self.assertTrue((SOURCE / "native-host.py").is_file(), "native-host.py 尚未实现")
        self.root = Path(tempfile.mkdtemp(dir=self.workspace))
        self.log = self.root / "fake-codex.jsonl"
        self.fake = self.root / "fake-codex"
        self.fake.write_text("#!" + sys.executable + "\n" + '''import json, os, sys, time
from pathlib import Path
args = sys.argv[1:]
with open(os.environ["FAKE_CODEX_LOG"], "a") as out:
    out.write(json.dumps(args, ensure_ascii=False) + "\\n")
mode = os.environ.get("FAKE_CODEX_MODE", "ok")
if mode == "slow": time.sleep(2)
if mode == "fail":
    print("fake queue rejected", file=sys.stderr)
    sys.exit(9)
if mode == "large-error":
    print("错误" * 600000, file=sys.stderr)
    sys.exit(9)
if mode == "signal": os.kill(os.getpid(), 15)
print("queued")
''')
        self.fake.chmod(0o700)
        self.env = patch.dict(os.environ, {"FAKE_CODEX_LOG": str(self.log), "FAKE_CODEX_MODE": "ok"})
        self.env.start()
        self.addCleanup(self.env.stop)
        spec = importlib.util.spec_from_file_location("kepler_native", SOURCE / "native-host.py")
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.config = {"codexPath": str(self.fake), "defaultThread": THREAD,
                       "dataRoot": str(self.root / "handoffs")}
        self.host = self.module.Host(self.config)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def invoke(self, data):
        return self.host.handle(copy.deepcopy(data))

    def test_info_and_default_thread(self):
        self.assertEqual(self.invoke({"op": "info"}), {"ok": True, "defaultThread": THREAD, "capabilities": CAPABILITIES})
        data = payload()
        del data["threadId"]
        self.assertEqual(self.invoke(data)["threadId"], THREAD)
        self.host = self.module.Host(dict(self.config, defaultThread=None))
        self.assertEqual(self.invoke({"op": "info"}), {"ok": True, "defaultThread": None, "capabilities": CAPABILITIES})
        explicit = payload()
        explicit["threadId"] = OTHER_THREAD
        queued = self.invoke(explicit)
        self.assertTrue(queued["ok"], queued)
        self.assertEqual(queued["state"], "queued")
        self.assertEqual(queued["threadId"], OTHER_THREAD)
        self.assertEqual(self.calls()[-1][2], OTHER_THREAD)

    def test_screenshot_original_files_and_secure_permissions(self):
        data = payload()
        result = self.invoke(data)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["state"], "queued")
        self.assertFalse(result["duplicate"])
        folder = Path(result["folder"])
        self.assertEqual(folder.parent, Path(self.config["dataRoot"]))
        self.assertRegex(result["deliveryId"], r"^[a-f0-9]{64}$")
        self.assertEqual(json.loads((folder / "annotations.json").read_text()), data["batch"])
        self.assertEqual(json.loads((folder / "ai-tasks.json").read_text()), data["aiTasks"])
        self.assertEqual((folder / "annotations.md").read_text(), data["markdown"])
        for name in data["assets"]:
            self.assertEqual((folder / name).read_bytes(), PNG)
        for path in [folder.parent, folder, *folder.rglob("*")]:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if path.is_dir() else 0o600, str(path))
        args = self.calls()[0]
        self.assertEqual(args[:4], ["queue", "--thread", THREAD, "--message"])
        prompt = args[4]
        for word in [str(folder), "第一批", "#7", "原话保留", "视觉", "annotations.json", "annotations.md", "ai-tasks.json", "截图", "参考图", "逐项", "网页文本", "证据", "执行指令"]:
            self.assertIn(word, prompt)
        self.assertEqual(len(args), 5)

    def test_duplicate_across_process_instances_and_different_target(self):
        data = payload()
        first = self.invoke(data)
        second = self.module.Host(self.config).handle(copy.deepcopy(data))
        self.assertEqual(second["deliveryId"], first["deliveryId"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(len(self.calls()), 1)
        reordered = dict(reversed(list(data.items())))
        reordered["assets"] = dict(reversed(list(data["assets"].items())))
        self.assertTrue(self.invoke(reordered)["duplicate"])
        data["threadId"] = OTHER_THREAD
        third = self.invoke(data)
        self.assertTrue(third["ok"])
        self.assertNotEqual(third["deliveryId"], first["deliveryId"])
        self.assertEqual(len(self.calls()), 2)

    def test_parallel_duplicate_queues_once(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.module.Host(self.config).handle(payload()), range(4)))
        self.assertTrue(all(r["ok"] for r in results), results)
        self.assertEqual(sum(not r["duplicate"] for r in results), 1)
        self.assertEqual(len(self.calls()), 1)

    def test_global_library_revision_noise_does_not_queue_twice(self):
        data = payload()
        data["batch"]["libraryRevision"] = 8
        data["aiTasks"]["batch"]["libraryRevision"] = 8
        first = self.invoke(data)
        data["batch"]["libraryRevision"] = 15
        data["aiTasks"]["batch"]["libraryRevision"] = 15
        second = self.invoke(data)
        self.assertEqual(second["deliveryId"], first["deliveryId"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(json.loads((Path(first["folder"]) / "annotations.json").read_text())["libraryRevision"], 8)

    def test_text_only_and_optional_task_fields(self):
        data = payload()
        data["batch"]["annotations"] = [{"id": 7, "text": "仅文字"}]
        data["aiTasks"]["tasks"] = [{"id": 7, "rawComment": "仅文字", "category": None,
                                     "evidence": {"screenshot": None, "references": []}}]
        data["assets"] = {}
        result = self.invoke(data)
        self.assertTrue(result["ok"], result)

    def test_all_supported_image_extensions(self):
        for extension, mime, content in [("jpeg", "jpeg", b"\xff\xd8\xff\xe0test\xff\xd9"),
                                         ("jpg", "jpeg", b"\xff\xd8\xff\xe0test\xff\xd9"),
                                         ("webp", "webp", b"RIFF\x10\x00\x00\x00WEBPVP8 test")]:
            data = payload()
            path = "shots/007." + extension
            data["batch"]["annotations"][0]["shot"] = path
            data["aiTasks"]["tasks"][0]["evidence"]["screenshot"] = path
            del data["assets"]["shots/007.png"]
            data["assets"][path] = "data:image/" + mime + ";base64," + base64.b64encode(content).decode()
            result = self.invoke(data)
            self.assertTrue(result["ok"], result)
            self.assertEqual((Path(result["folder"]) / path).read_bytes(), content)

    def test_uuid_schema_and_annotation_ids(self):
        cases = []
        for value in ["../bad", "--thread=x", "$(touch /tmp/kepler-bad)", "", None]:
            data = payload(); data["threadId"] = value; cases.append(data)
        for field, value in [("schemaVersion", True), ("schemaVersion", 2), ("nextId", 7), ("nextId", True), ("nextId", 1.5), ("nextId", 2**53), ("annotations", [{}])]:
            data = payload(); data["batch"][field] = value; cases.append(data)
        for value in [True, 0, -1, "7", 7.0]:
            data = payload(); data["batch"]["annotations"][0]["id"] = value; cases.append(data)
        data = payload(); data["batch"]["annotations"] *= 2; cases.append(data)
        for data in cases:
            with self.subTest(data=str(data)[:140]):
                self.assertFalse(self.invoke(data)["ok"])
        self.assertEqual(self.calls(), [])

    def test_path_traversal_all_reference_locations_and_assets(self):
        for bad in ["shots/../oops.png", "refs/nested/a.png", "/shots/a.png", "shots\\a.png", "shots/%2e%2e.png", "shots/.hidden.png", "refs/a.svg", "other/a.png", "shots/a.png\x00", "shots/a.png\n"]:
            for location in ["shot", "refs", "asset", "ai"]:
                data = payload()
                if location == "shot": data["batch"]["annotations"][0]["shot"] = bad
                if location == "refs": data["batch"]["annotations"][0]["refs"] = [bad]
                if location == "asset": data["assets"][bad] = DATA
                if location == "ai": data["aiTasks"]["tasks"][0]["evidence"]["screenshot"] = bad
                with self.subTest(path=bad, location=location):
                    self.assertFalse(self.invoke(data)["ok"])
        self.assertEqual(self.calls(), [])

    def test_missing_extra_invalid_base64_and_wrong_image_format(self):
        cases = []
        data = payload(); del data["assets"]["shots/007.png"]; cases.append(data)
        data = payload(); data["assets"]["refs/unused.png"] = DATA; cases.append(data)
        for value in ["data:image/png;base64,!!!!", "data:image/png;base64,YQ==\n", "data:image/png;base64,AB==", "data:image/png;base64,", "data:image/svg+xml;base64,YQ==", "data:image/jpeg;base64," + base64.b64encode(PNG).decode(), "data:image/png;base64,YQ==", None]:
            data = payload(); data["assets"]["shots/007.png"] = value; cases.append(data)
        for data in cases:
            with self.subTest(asset=str(data["assets"])[:120]):
                self.assertFalse(self.invoke(data)["ok"])
        self.assertEqual(self.calls(), [])

    def test_ai_tasks_cannot_change_original_ids_words_or_evidence(self):
        for field, value in [("id", 8), ("rawComment", "被改写"), ("category", "其他"), ("evidence", {"screenshot": "refs/sample.png", "references": []})]:
            data = payload(); data["aiTasks"]["tasks"][0][field] = value
            self.assertFalse(self.invoke(data)["ok"])
        data = payload(); data["aiTasks"]["tasks"] = []
        self.assertFalse(self.invoke(data)["ok"])
        self.assertEqual(self.calls(), [])

    def test_long_original_text_is_kept_on_disk_and_prompt_is_bounded(self):
        data = payload()
        words = "原话\n$(echo 不执行);`command`\"🧪" * 30000
        data["batch"]["annotations"][0]["text"] = words
        data["aiTasks"]["tasks"][0]["rawComment"] = words
        data["markdown"] = words
        result = self.invoke(data)
        self.assertTrue(result["ok"], result)
        folder = Path(result["folder"])
        self.assertEqual(json.loads((folder / "annotations.json").read_text())["annotations"][0]["text"], words)
        self.assertEqual((folder / "annotations.md").read_text(), words)
        self.assertLess(len(self.calls()[0][4].encode()), 12000)

    def test_failed_queue_retains_data_and_never_claims_success(self):
        with patch.dict(os.environ, {"FAKE_CODEX_MODE": "fail"}):
            result = self.invoke(payload())
        self.assertFalse(result["ok"])
        self.assertIn("fake queue rejected", result["error"])
        self.assertEqual(result["exitCode"], 9)
        self.assertTrue((Path(result["folder"]) / "shots/007.png").exists())
        self.assertNotEqual(result["state"], "queued")
        self.assertFalse(self.invoke(payload())["ok"])
        self.assertEqual(len(self.calls()), 1)

    def test_pending_and_files_exist_before_shell_free_cli_call(self):
        real_run = self.module.subprocess.run
        def checked_run(command, **kwargs):
            self.assertIs(kwargs["shell"], False)
            folder = Path(kwargs["cwd"])
            self.assertEqual(json.loads((folder / "delivery.json").read_text())["state"], "pending")
            for name in ["annotations.json", "annotations.md", "ai-tasks.json", "shots/007.png", "refs/sample.png"]:
                self.assertTrue((folder / name).is_file(), name)
            return real_run(command, **kwargs)
        with patch.object(self.module.subprocess, "run", side_effect=checked_run):
            self.assertTrue(self.invoke(payload())["ok"])

    def test_partial_storage_failure_keeps_written_files_and_does_not_queue(self):
        real_save = self.module.atomic_json
        def save(path, value):
            if Path(path).name == "ai-tasks.json":
                raise OSError("fake data disk full")
            return real_save(path, value)
        with patch.object(self.module, "atomic_json", side_effect=save):
            result = self.invoke(payload())
        self.assertFalse(result["ok"])
        self.assertEqual(result["state"], "failed")
        self.assertTrue((Path(result["folder"]) / "annotations.json").is_file())
        self.assertEqual(self.calls(), [])

    def test_info_uses_installed_thread_and_does_not_write_data(self):
        with patch.dict(os.environ, {"CODEX_THREAD_ID": OTHER_THREAD}):
            result = self.invoke({"op": "info"})
        self.assertEqual(result, {"ok": True, "defaultThread": THREAD, "capabilities": CAPABILITIES})
        self.assertFalse(Path(self.config["dataRoot"]).exists())

    def test_installer_preserves_existing_application_support_permissions(self):
        self.assertTrue((SOURCE / "install-native-host.py").is_file())
        source = self.root / "source"
        source.mkdir()
        for name in ["native-host.py", "install-native-host.py"]:
            shutil.copyfile(SOURCE / name, source / name)
        support = self.root / "support"
        support.mkdir(mode=0o755)
        result = subprocess.run([sys.executable, str(source / "install-native-host.py"), "--extension-id", EXTENSION, "--config-root", str(support), "--thread", THREAD], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(stat.S_IMODE(support.stat().st_mode), 0o755)

    def test_timeout_and_terminated_queue_stay_pending_on_retry(self):
        real_run = self.module.subprocess.run
        for mode in ["timeout", "signal"]:
            effect = subprocess.TimeoutExpired([str(self.fake), "queue"], self.module.QUEUE_TIMEOUT) if mode == "timeout" else real_run
            with self.subTest(mode=mode), patch.dict(os.environ, {"FAKE_CODEX_MODE": mode}), patch.object(self.module.subprocess, "run", side_effect=effect) as queue:
                data = payload(); data["markdown"] += mode
                result = self.invoke(data)
                self.assertFalse(result["ok"])
                self.assertEqual(result["state"], "pending")
                self.assertTrue(result["needsCheck"])
                self.assertEqual(result["code"], "QUEUE_UNCERTAIN" if mode == "timeout" else "QUEUE_FAILED")
                if mode == "signal":
                    self.assertEqual(result["exitCode"], -15)
                self.assertEqual(json.loads((Path(result["folder"]) / "delivery.json").read_text())["state"], "pending")
                retry = self.invoke(data)
                self.assertFalse(retry["ok"])
                self.assertEqual(retry["state"], "pending")
                self.assertTrue(retry["needsCheck"])
                self.assertTrue(retry["duplicate"])
                queue.assert_called_once()
                self.assertEqual(len(self.calls()), 0 if mode == "timeout" else 1)

    def test_durable_pending_precedes_queue_and_receipt_failure_does_not_requeue(self):
        real_save = self.module.atomic_json
        def save(path, value):
            if Path(path).name == "delivery.json" and value.get("state") == "queued":
                raise OSError("fake receipt disk full")
            return real_save(path, value)
        with patch.object(self.module, "atomic_json", side_effect=save):
            result = self.invoke(payload())
        self.assertFalse(result["ok"])
        self.assertEqual(result["state"], "pending")
        retry = self.invoke(payload())
        self.assertFalse(retry["ok"])
        self.assertTrue(retry["needsCheck"])
        self.assertEqual(len(self.calls()), 1)

    def test_symlink_delivery_folder_is_rejected(self):
        result = self.invoke(payload())
        folder = Path(result["folder"])
        moved = folder.with_name("preserved-original")
        folder.rename(moved)
        folder.symlink_to(moved, target_is_directory=True)
        self.assertFalse(self.invoke(payload())["ok"])
        self.assertEqual(len(self.calls()), 1)

    def test_multiple_frames_short_reads_and_bad_json(self):
        class ShortReader(io.BytesIO):
            def read(self, n=-1):
                return super().read(min(n, 3) if n >= 0 else 3)
        raw = struct.pack("<I", 1) + b"{" + frame({"op": "info"}) + frame(payload())
        output = io.BytesIO()
        self.module.serve(self.host, ShortReader(raw), output)
        replies = frames(output.getvalue())
        self.assertEqual(len(replies), 3)
        self.assertFalse(replies[0]["ok"])
        self.assertEqual(replies[1], {"ok": True, "defaultThread": THREAD, "capabilities": CAPABILITIES})
        self.assertEqual(replies[2]["state"], "queued")

    def test_truncated_and_oversized_frames(self):
        for raw in [b"\x01\x00", struct.pack("<I", 10) + b"{}", struct.pack("<I", self.module.MAX_FRAME + 1), struct.pack("<I", 0)]:
            output = io.BytesIO()
            self.module.serve(self.host, io.BytesIO(raw), output)
            self.assertFalse(frames(output.getvalue())[0]["ok"])
        self.assertEqual(self.calls(), [])

    def test_json_duplicate_keys_nonfinite_and_invalid_utf8(self):
        for raw in [b'{"op":"info","op":"send"}', b'{"op":"info","value":NaN}', b'\xff', b'[]']:
            output = io.BytesIO()
            self.module.serve(self.host, io.BytesIO(struct.pack("<I", len(raw)) + raw), output)
            self.assertFalse(frames(output.getvalue())[0]["ok"])

    def test_large_cli_error_response_is_bounded(self):
        with patch.dict(os.environ, {"FAKE_CODEX_MODE": "large-error"}):
            result = self.invoke(payload())
        self.assertFalse(result["ok"])
        self.assertLess(len(json.dumps(result).encode()), 1024 * 1024)

    def test_installer_isolated_registration_backup_and_cli_framing(self):
        self.assertTrue((SOURCE / "install-native-host.py").is_file())
        source = self.root / "source"
        source.mkdir()
        for name in ["native-host.py", "install-native-host.py"]:
            shutil.copyfile(SOURCE / name, source / name)
        support = self.root / "Application Support"
        command = [sys.executable, str(source / "install-native-host.py"), "--extension-id", EXTENSION,
                   "--codex-path", str(self.fake), "--config-root", str(support)]
        environment = dict(os.environ, CODEX_THREAD_ID=THREAD)
        result = subprocess.run(command, env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        config_path = source / "native-host-config.json"
        config = json.loads(config_path.read_text())
        self.assertEqual(config["defaultThread"], THREAD)
        self.assertEqual(config["codexPath"], str(self.fake))
        self.assertEqual(Path(config["dataRoot"]), support / "KeplerAnnotate/handoffs")
        locations = [support / product / "NativeMessagingHosts/com.kepler.annotate.json"
                     for product in ["Google/Chrome", "Google/ChromeForTesting", "Chromium"]]
        self.assertEqual(json.loads(result.stdout)["manifests"], [str(path) for path in locations])
        for path in locations:
            manifest = json.loads(path.read_text())
            self.assertEqual(manifest["name"], "com.kepler.annotate")
            self.assertEqual(manifest["type"], "stdio")
            self.assertEqual(manifest["path"], str(source / "native-host-launcher"))
            self.assertEqual(manifest["allowed_origins"], ["chrome-extension://" + EXTENSION + "/"])
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(config_path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((source / "native-host.py").stat().st_mode), 0o700)
        result = subprocess.run(command + ["--thread", OTHER_THREAD, "--extension-id", "a" * 32], env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for path in [config_path, *locations]:
            backups = list(path.parent.glob(path.name + ".bak-*"))
            self.assertTrue(backups, str(path))
            self.assertEqual(stat.S_IMODE(backups[0].stat().st_mode), 0o600)
        config = json.loads(config_path.read_text())
        config["codexPath"] = str(self.fake)
        config_path.write_text(json.dumps(config))
        cli = subprocess.run([str(source / "native-host-launcher"), "chrome-extension://" + "a" * 32 + "/"], input=frame({"op": "info"}) + frame(payload()), capture_output=True, env=environment)
        self.assertEqual(cli.returncode, 0, cli.stderr)
        replies = frames(cli.stdout)
        self.assertEqual(replies[0], {"ok": True, "defaultThread": OTHER_THREAD, "capabilities": CAPABILITIES})
        self.assertTrue(replies[1]["ok"], replies)
        self.assertEqual(self.calls()[0][2], THREAD)

    def test_installer_rejects_invalid_arguments_before_writing(self):
        self.assertTrue((SOURCE / "install-native-host.py").is_file())
        source = self.root / "source"
        source.mkdir()
        for name in ["native-host.py", "install-native-host.py"]:
            shutil.copyfile(SOURCE / name, source / name)
        for args in [["--thread", "bad", "--extension-id", EXTENSION], ["--thread", THREAD, "--extension-id", "invalid"]]:
            result = subprocess.run([sys.executable, str(source / "install-native-host.py"), "--config-root", str(self.root / "support"), *args], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
        self.assertFalse((source / "native-host-config.json").exists())
        self.assertFalse((self.root / "support").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
