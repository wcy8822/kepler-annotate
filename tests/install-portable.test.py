"""公开包便携安装契约：仅临时目录、假 Codex、临时 Git，不注册日常浏览器。"""
import importlib.util
import json
import os
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
EXTENSION = "abcdefghijklmnopabcdefghijklmnop"
THREAD = "00000000-0000-4000-8000-000000000001"
NO_THREAD_INFO = {"ok": True, "defaultThread": None, "capabilities": {
    "taskContracts": [1, 2], "reviewTaskValidation": "structure_and_evidence",
    "sourceBindingValidation": False, "reviewExecution": False}}


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def frame(value):
    raw = json.dumps(value).encode()
    return struct.pack("<I", len(raw)) + raw


def decode(raw):
    size = struct.unpack("<I", raw[:4])[0]
    assert len(raw) == size + 4
    return json.loads(raw[4:])


class PortableInstallTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workspace = Path(tempfile.mkdtemp(prefix="kepler-portable-tests-")).resolve()
        print("测试数据保留于：" + str(cls.workspace), flush=True)

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(dir=self.workspace))
        self.source = self.root / "source with spaces 'quoted'"
        self.source.mkdir()
        for name in ["install-native-host.py", "native-host.py", "project_store.py", "kepler-annotations.py",
                     "review_source.py", "review_transition.py", "review_basis.py"]:
            shutil.copyfile(SOURCE / name, self.source / name)
        self.support = self.root / "isolated-support"
        self.installer = load("kepler_portable_installer", self.source / "install-native-host.py")
        self.native = load("kepler_portable_native", self.source / "native-host.py")
        self.fake = self.root / "fake codex"
        self.fake.write_text("#!" + sys.executable + "\nraise SystemExit('不应调用 fake codex')\n")
        self.fake.chmod(0o700)
        self.environment = patch.dict(os.environ, {"PATH": "", "CODEX_THREAD_ID": ""})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def install(self, *args):
        command = [sys.executable, "-B", str(self.source / "install-native-host.py"), "--config-root", str(self.support), *args]
        return subprocess.run(command, capture_output=True, text=True)

    def config(self):
        return json.loads((self.source / "native-host-config.json").read_text())

    def test_extension_id_is_required_without_writing(self):
        response = self.install()
        self.assertNotEqual(response.returncode, 0)
        self.assertIn("--extension-id", response.stderr)
        self.assertFalse((self.source / "native-host-config.json").exists())
        self.assertFalse(self.support.exists())

    def test_skill_only_install_has_no_codex_or_default_thread(self):
        response = self.install("--extension-id", EXTENSION)
        self.assertEqual(response.returncode, 0, response.stderr)
        config = self.config()
        self.assertIsNone(config["defaultThread"])
        self.assertIsNone(config["codexPath"])
        host = self.native.Host(config)
        self.assertEqual(host.handle({"op": "info"}), NO_THREAD_INFO)
        self.assertIsNone(host.handle({"op": "project-info", "projectId": "public-demo"})["binding"])

    def test_launcher_uses_installing_python_with_empty_path_and_quoted_location(self):
        response = self.install("--extension-id", EXTENSION)
        self.assertEqual(response.returncode, 0, response.stderr)
        installed = json.loads(response.stdout)
        launcher = Path(installed["launcher"])
        self.assertEqual(launcher.stat().st_mode & 0o777, 0o700)
        self.assertIn(sys.executable, launcher.read_text())
        for manifest_path in installed["manifests"]:
            manifest = json.loads(Path(manifest_path).read_text())
            self.assertEqual(manifest["path"], str(launcher))
            self.assertEqual(manifest["allowed_origins"], ["chrome-extension://" + EXTENSION + "/"])
        result = subprocess.run([str(launcher), "chrome-extension://" + EXTENSION + "/"], input=frame({"op": "info"}), capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(decode(result.stdout), NO_THREAD_INFO)

    def test_explicit_codex_path_and_thread_are_preserved_without_running_codex(self):
        response = self.install("--extension-id", EXTENSION, "--codex-path", str(self.fake), "--thread", THREAD)
        self.assertEqual(response.returncode, 0, response.stderr)
        self.assertEqual(self.config()["codexPath"], str(self.fake))
        self.assertEqual(self.config()["defaultThread"], THREAD)

    def test_codex_is_discovered_on_path_without_executing_it(self):
        executable = self.root / "codex"
        executable.write_text(self.fake.read_text())
        executable.chmod(0o700)
        with patch.dict(os.environ, {"PATH": str(self.root)}):
            response = self.install("--extension-id", EXTENSION)
        self.assertEqual(response.returncode, 0, response.stderr)
        self.assertEqual(self.config()["codexPath"], str(executable))

    def test_explicit_codex_path_rejects_relative_missing_and_non_executable(self):
        non_executable = self.root / "not-executable"
        non_executable.write_text("not executable")
        non_executable.chmod(0o600)
        for path in ["relative-codex", str(self.root / "missing"), str(non_executable)]:
            with self.subTest(path=path):
                response = self.install("--extension-id", EXTENSION, "--codex-path", path)
                self.assertNotEqual(response.returncode, 0)
        self.assertFalse((self.source / "native-host-config.json").exists())

    def test_send_without_default_thread_guides_input_and_preserves_info(self):
        for default in [None, ""]:
            with self.subTest(default=default):
                host = self.native.Host({"defaultThread": default, "codexPath": str(self.fake), "dataRoot": str(self.root / "handoffs")})
                self.assertEqual(host.handle({"op": "info"}), NO_THREAD_INFO)
                result = host.handle({"op": "send"})
                self.assertFalse(result["ok"])
                self.assertIn("thread", result["error"].lower())
                self.assertFalse((self.root / "handoffs").exists())

    def test_send_with_target_but_without_codex_guides_install_configuration(self):
        host = self.native.Host({"defaultThread": None, "codexPath": None, "dataRoot": str(self.root / "handoffs")})
        response = host.handle({"op": "send", "threadId": THREAD})
        self.assertFalse(response["ok"])
        self.assertIn("--codex-path", response["error"])

    def test_git_executable_is_discovered_instead_of_fixed_path(self):
        store = load("kepler_portable_store", self.source / "project_store.py")
        fake_git = str(self.root / "discovered-git")
        with patch.object(store.shutil, "which", return_value=fake_git) as discover:
            with patch.object(store.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout="git-ok", stderr="")) as run:
                self.assertEqual(store.git(self.root, "rev-parse", "--show-toplevel"), "git-ok")
        discover.assert_called_once_with("git")
        self.assertEqual(run.call_args.args[0][0], fake_git)
        self.assertIs(run.call_args.kwargs["shell"], False)

    def test_no_git_gives_actionable_error(self):
        store = load("kepler_portable_no_git", self.source / "project_store.py")
        with patch.object(store.shutil, "which", return_value=None):
            with self.assertRaisesRegex(ValueError, "Git|git"):
                store.git(self.root, "rev-parse", "--show-toplevel")

    def test_installer_help_states_platform_scope_and_optional_codex(self):
        response = subprocess.run([sys.executable, str(self.source / "install-native-host.py"), "--help"], capture_output=True, text=True)
        self.assertEqual(response.returncode, 0)
        for text in ["macOS", "POSIX", "Windows", "--codex-path", "--extension-id"]:
            self.assertIn(text, response.stdout)

    def test_no_default_registration_on_other_posix_platforms(self):
        with patch.object(self.installer.sys, "platform", "linux"), patch("builtins.print"):
            self.assertNotEqual(self.installer.main(["--extension-id", EXTENSION]), 0)
        self.assertFalse((self.source / "native-host-config.json").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
