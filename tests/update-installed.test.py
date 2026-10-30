"""原位更新契约：仅使用临时副本，不接触浏览器与日常数据。"""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "update-installed.py"
FILES = (
    "manifest.json", "service-worker.js", "kp-annotate.js",
    "kp-annotate-store.js", "kp-annotate-project.js", "kp-annotate.css",
    "vendor/jszip.min.js", "vendor/jszip.LICENSE", "INSTALL.html",
)


class UpdateInstalledTest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), "缺少原位更新脚本")
        temporary = tempfile.TemporaryDirectory(prefix="kepler-update-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.source = self.root / "public source"
        self.target = self.root / "installed target"
        self.backups = self.root / "backups"
        for root, version in ((self.source, "new"), (self.target, "old")):
            root.mkdir()
            for name in FILES:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                value = json.dumps({"manifest_version": 3, "version": version}) if name == "manifest.json" else version + ":" + name
                path.write_text(value)
        (self.source / "scripts").mkdir()
        self.script = self.source / "scripts" / SCRIPT.name
        shutil.copyfile(SCRIPT, self.script)

    def run_update(self, *args, target=None, backup=True):
        command = [sys.executable, "-B", str(self.script), "--target", str(target or self.target)]
        if backup:
            command += ["--backup-dir", str(self.backups)]
        return subprocess.run(command + list(args), cwd=self.root, capture_output=True, text=True)

    def snapshot(self, root):
        return {str(path.relative_to(root)): path.read_bytes() for path in root.rglob("*") if path.is_file()}

    def module(self):
        spec = importlib.util.spec_from_file_location("update_installed", self.script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def receipt(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        receipt_path = Path(output["receipt"])
        return json.loads(receipt_path.read_text()), receipt_path.parent

    def test_only_whitelist_changes_and_backup_is_complete(self):
        protected = (
            "native-host-config.json", "native-host-config.json.bak",
            "native-host-launcher", "native-host-launcher.bak", "native-host.py",
            "project_store.py", "Chrome/Profile/Preferences",
            ".kepler-annotate/batch.json", "notes.txt",
        )
        for root, value in ((self.source, "source-only"), (self.target, "keep")):
            for name in protected:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(value)
        before = self.snapshot(self.target)
        source_before = self.snapshot(self.source)
        (self.target / "kp-annotate.js").chmod(0o640)
        result = self.run_update()
        receipt, backup = self.receipt(result)
        self.assertEqual(receipt["status"], "completed")
        self.assertEqual(set(receipt["files"]), set(FILES))
        self.assertEqual(self.snapshot(backup / "files"), {name: before[name] for name in FILES})
        for name in FILES:
            self.assertEqual((self.target / name).read_bytes(), (self.source / name).read_bytes())
            entry = receipt["files"][name]
            self.assertTrue(entry["existed"])
            self.assertEqual(entry["sha256"], hashlib.sha256(before[name]).hexdigest())
        for name in protected:
            self.assertEqual((self.target / name).read_bytes(), before[name])
        self.assertEqual(self.snapshot(self.source), source_before)
        self.assertEqual((self.target / "kp-annotate.js").stat().st_mode & 0o777, 0o640)
        self.assertIn("Chrome", result.stdout)
        self.assertIn("Reload", result.stdout)

    def test_target_argument_is_required(self):
        result = subprocess.run([sys.executable, "-B", str(self.script)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--target", result.stderr)
        self.assertFalse(self.backups.exists())

    def test_same_or_overlapping_roots_are_rejected(self):
        for target in (self.source, self.source / "scripts", self.root):
            with self.subTest(target=target):
                result = self.run_update(target=target)
                self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.backups.exists())

    def test_missing_target_is_rejected(self):
        missing = self.root / "missing"
        self.assertNotEqual(self.run_update(target=missing).returncode, 0)
        self.assertFalse(missing.exists())
        self.assertFalse(self.backups.exists())

    def test_both_manifests_must_be_mv3(self):
        for root in (self.source, self.target):
            manifest = root / "manifest.json"
            original = manifest.read_bytes()
            for value in ('{"manifest_version": 2}', '{"manifest_version": "3"}', '[]', 'invalid'):
                with self.subTest(root=root, value=value):
                    manifest.write_text(value)
                    before = self.snapshot(self.target)
                    self.assertNotEqual(self.run_update().returncode, 0)
                    self.assertEqual(self.snapshot(self.target), before)
                    self.assertFalse(self.backups.exists())
            manifest.write_bytes(original)

    def test_target_symlink_files_and_vendor_directory_are_rejected(self):
        external = self.root / "untouched"
        external.write_text("keep")
        for name in FILES:
            with self.subTest(name=name):
                path = self.target / name
                original = path.read_bytes()
                path.unlink()
                path.symlink_to(external)
                self.assertNotEqual(self.run_update().returncode, 0)
                self.assertTrue(path.is_symlink())
                self.assertEqual(external.read_text(), "keep")
                self.assertFalse(self.backups.exists())
                path.unlink()
                path.write_bytes(original)
        vendor = self.target / "vendor"
        vendor.rename(self.root / "real-vendor")
        vendor.symlink_to(self.root / "real-vendor", target_is_directory=True)
        self.assertNotEqual(self.run_update().returncode, 0)
        self.assertFalse(self.backups.exists())

    def test_source_symlink_is_rejected(self):
        path = self.source / "kp-annotate.js"
        path.unlink()
        path.symlink_to(self.target / "kp-annotate.js")
        before = self.snapshot(self.target)
        self.assertNotEqual(self.run_update().returncode, 0)
        self.assertEqual(self.snapshot(self.target), before)

    def test_missing_optional_source_file_is_skipped(self):
        (self.source / "INSTALL.html").unlink()
        previous = (self.target / "INSTALL.html").read_bytes()
        receipt, _ = self.receipt(self.run_update())
        self.assertNotIn("INSTALL.html", receipt["files"])
        self.assertEqual((self.target / "INSTALL.html").read_bytes(), previous)

    def test_each_required_source_file_missing_fails_before_any_writes(self):
        before = self.snapshot(self.target)
        for name in FILES:
            if name == "INSTALL.html":
                continue
            with self.subTest(name=name):
                path = self.source / name
                original = path.read_bytes()
                path.unlink()
                try:
                    result = self.run_update()
                    self.assertNotEqual(result.returncode, 0, name)
                    self.assertIn(name, result.stderr)
                    self.assertEqual(self.snapshot(self.target), before)
                    self.assertFalse(self.backups.exists())
                finally:
                    path.write_bytes(original)

    def test_new_target_file_records_absence(self):
        shutil.rmtree(self.target / "vendor")
        receipt, backup = self.receipt(self.run_update())
        for name in ("vendor/jszip.min.js", "vendor/jszip.LICENSE"):
            self.assertFalse(receipt["files"][name]["existed"])
            self.assertIsNone(receipt["files"][name]["sha256"])
            self.assertFalse((backup / "files" / name).exists())
            self.assertEqual((self.target / name).read_bytes(), (self.source / name).read_bytes())

    def test_repeated_updates_never_overwrite_previous_backup(self):
        _, first = self.receipt(self.run_update())
        previous = self.snapshot(first)
        _, second = self.receipt(self.run_update())
        self.assertNotEqual(first, second)
        self.assertEqual(self.snapshot(first), previous)

    def test_default_backup_is_external(self):
        receipt, backup = self.receipt(self.run_update(backup=False))
        self.addCleanup(shutil.rmtree, backup)
        self.assertEqual(receipt["status"], "completed")
        for root in (self.source, self.target):
            self.assertNotIn(root, backup.parents)

    def test_backup_inside_source_or_target_is_rejected(self):
        for root in (self.source, self.target):
            with self.subTest(root=root):
                result = self.run_update("--backup-dir", str(root / "backups"))
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((root / "backups").exists())

    def test_all_backups_and_receipt_exist_before_first_replace(self):
        module = self.module()
        replace = module.os.replace
        seen = []
        before = self.snapshot(self.target)

        def inspect(source, destination):
            if Path(destination).is_relative_to(self.target):
                receipts = list(self.backups.glob("*/receipt.json"))
                self.assertEqual(len(receipts), 1)
                receipt = json.loads(receipts[0].read_text())
                self.assertEqual(set(receipt["files"]), set(FILES))
                saved = receipts[0].parent / "files"
                self.assertEqual(self.snapshot(saved), before)
                self.assertEqual(Path(source).parent, Path(destination).parent)
                seen.append(destination)
            return replace(source, destination)

        with patch.object(module.os, "replace", side_effect=inspect):
            module.update(self.target, self.backups)
        self.assertEqual(len(seen), len(FILES))

    def test_replace_failure_restores_changed_files_and_keeps_backup(self):
        module = self.module()
        replace = module.os.replace
        before = self.snapshot(self.target)
        failed = False

        def fail_once(source, destination):
            nonlocal failed
            if Path(destination) == self.target / "kp-annotate.js" and not failed:
                failed = True
                raise OSError("synthetic replacement failure")
            return replace(source, destination)

        with patch.object(module.os, "replace", side_effect=fail_once):
            with self.assertRaisesRegex(OSError, "synthetic replacement failure"):
                module.update(self.target, self.backups)
        self.assertEqual(self.snapshot(self.target), before)
        receipt_path, = self.backups.glob("*/receipt.json")
        self.assertEqual(json.loads(receipt_path.read_text())["status"], "rolled_back")
        self.assertEqual(self.snapshot(receipt_path.parent / "files"), before)

    def test_backup_failure_leaves_target_untouched(self):
        module = self.module()
        before = self.snapshot(self.target)
        with patch.object(module.shutil, "copy2", side_effect=OSError("synthetic backup failure")):
            with self.assertRaisesRegex(OSError, "synthetic backup failure"):
                module.update(self.target, self.backups)
        self.assertEqual(self.snapshot(self.target), before)

    def test_failure_removes_new_files_and_new_vendor_directory(self):
        shutil.rmtree(self.target / "vendor")
        before = self.snapshot(self.target)
        module = self.module()
        replace = module.os.replace

        def fail(source, destination):
            if Path(destination) == self.target / "INSTALL.html":
                raise OSError("synthetic final-file failure")
            return replace(source, destination)

        with patch.object(module.os, "replace", side_effect=fail):
            with self.assertRaisesRegex(OSError, "synthetic final-file failure"):
                module.update(self.target, self.backups)
        self.assertEqual(self.snapshot(self.target), before)
        self.assertFalse((self.target / "vendor").exists())

    def test_rollback_failure_is_reported_and_originals_remain_available(self):
        module = self.module()
        replace = module.os.replace
        original = (self.target / "manifest.json").read_bytes()

        def fail(source, destination):
            path = Path(destination)
            if path == self.target / "kp-annotate.js":
                raise OSError("synthetic update failure")
            if path == self.target / "manifest.json" and path.read_bytes() != original:
                raise OSError("synthetic rollback failure")
            return replace(source, destination)

        with patch.object(module.os, "replace", side_effect=fail):
            with self.assertRaisesRegex(OSError, "手动恢复"):
                module.update(self.target, self.backups)
        receipt_path, = self.backups.glob("*/receipt.json")
        receipt = json.loads(receipt_path.read_text())
        self.assertEqual(receipt["status"], "rollback_failed")
        self.assertTrue(receipt["rollback_errors"])
        self.assertEqual((receipt_path.parent / "files/manifest.json").read_bytes(), original)

    def test_missing_manifest_and_non_file_destination_are_rejected(self):
        for root in (self.source, self.target):
            with self.subTest(root=root):
                manifest = root / "manifest.json"
                original = manifest.read_bytes()
                manifest.unlink()
                self.assertNotEqual(self.run_update().returncode, 0)
                self.assertFalse(self.backups.exists())
                manifest.write_bytes(original)
        path = self.target / "INSTALL.html"
        path.unlink()
        path.mkdir()
        self.assertNotEqual(self.run_update().returncode, 0)
        self.assertFalse(self.backups.exists())

    def test_even_skipped_target_symlinks_are_rejected(self):
        (self.source / "INSTALL.html").unlink()
        path = self.target / "INSTALL.html"
        path.unlink()
        path.symlink_to(self.root / "missing")
        self.assertNotEqual(self.run_update().returncode, 0)
        self.assertTrue(path.is_symlink())
        self.assertFalse(self.backups.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
