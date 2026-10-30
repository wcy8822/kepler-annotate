#!/usr/bin/env python3
"""仅更新现有扩展的公开运行文件；备份在外部，Chrome 由用户手动 Reload。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile


FILES = (
    "manifest.json", "service-worker.js", "kp-annotate.js",
    "kp-annotate-store.js", "kp-annotate-project.js", "kp-annotate.css",
    "vendor/jszip.min.js", "vendor/jszip.LICENSE", "INSTALL.html",
)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def checked_file(root, name):
    path = root
    for part in Path(name).parts:
        path = path / part
        if path.is_symlink():
            raise ValueError(f"拒绝符号链接：{path}")
        if path.exists() and path != root / name and not path.is_dir():
            raise ValueError(f"父路径须为目录：{path}")
    if path.exists() and not stat.S_ISREG(path.stat().st_mode):
        raise ValueError(f"须为普通文件：{path}")
    return path


def check_manifest(root):
    path = checked_file(root, "manifest.json")
    if not path.is_file():
        raise ValueError(f"缺少 manifest.json：{root}")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or type(manifest.get("manifest_version")) is not int or manifest["manifest_version"] != 3:
        raise ValueError(f"manifest 必须为 MV3：{root}")


def atomic_write(path, data, mode=0o600):
    descriptor, temporary = tempfile.mkstemp(prefix=".kepler-update-", dir=path.parent)
    temporary = Path(temporary)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def write_receipt(path, receipt):
    atomic_write(path, (json.dumps(receipt, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def update(target, backup_dir=None):
    source = Path(__file__).resolve().parents[1]
    target = Path(target).expanduser()
    if target.is_symlink():
        raise ValueError("目标根目录须为真实目录")
    target = target.resolve(strict=True)
    if not source.is_dir() or not target.is_dir():
        raise ValueError("源与目标须为现有扩展目录")
    if source == target or source in target.parents or target in source.parents:
        raise ValueError("源与目标须不同且互不包含")
    check_manifest(source)
    check_manifest(target)

    payloads = {}
    originals = {}
    for name in FILES:
        destination = checked_file(target, name)
        origin = checked_file(source, name)
        if not origin.exists():
            if name != "INSTALL.html":
                raise ValueError(f"源码缺少必需运行文件：{name}")
            continue
        payloads[name] = (origin.read_bytes(), stat.S_IMODE(origin.stat().st_mode))
        originals[name] = {
            "existed": destination.exists(),
            "sha256": sha256(destination.read_bytes()) if destination.exists() else None,
            "mode": stat.S_IMODE(destination.stat().st_mode) if destination.exists() else None,
        }

    base = Path(backup_dir).expanduser().resolve() if backup_dir is not None else Path(tempfile.gettempdir()).resolve()
    if any(base == root or root in base.parents for root in (source, target)):
        raise ValueError("备份目录须位于源与目标之外")
    base.mkdir(parents=True, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix="kepler-annotate-backup-", dir=base))
    receipt_path = backup / "receipt.json"
    receipt = {
        "schema_version": 1,
        "source": str(source), "target": str(target),
        "status": "preparing", "files": originals, "changed": [],
        "rollback": "按 files 将 existed=true 的 files/ 同名备份原子恢复到 target，核对 sha256 并恢复 mode；existed=false 的文件恢复为不存在。最后在 Chrome 手动 Reload。",
    }
    changed = receipt["changed"]
    created_directories = []
    try:
        for name, entry in originals.items():
            if entry["existed"]:
                origin = checked_file(target, name)
                saved = backup / "files" / name
                saved.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(origin, saved, follow_symlinks=False)
                if saved.is_symlink() or sha256(saved.read_bytes()) != entry["sha256"]:
                    raise OSError(f"备份校验失败：{name}")
                with saved.open("rb") as stream:
                    os.fsync(stream.fileno())
        receipt["status"] = "prepared"
        write_receipt(receipt_path, receipt)
        for name, (data, source_mode) in payloads.items():
            path = checked_file(target, name)
            entry = originals[name]
            current = sha256(path.read_bytes()) if path.exists() else None
            if current != entry["sha256"]:
                raise OSError(f"目标在备份后发生变化，停止更新：{name}")
            if not path.parent.exists():
                path.parent.mkdir()
                created_directories.append(path.parent)
            atomic_write(path, data, entry["mode"] if entry["existed"] else source_mode)
            changed.append(name)
            receipt["status"] = "updating"
            write_receipt(receipt_path, receipt)
        receipt["status"] = "completed"
        write_receipt(receipt_path, receipt)
    except (Exception, KeyboardInterrupt) as error:
        failures = []
        for name in reversed(changed):
            try:
                path = checked_file(target, name)
                entry = originals[name]
                if entry["existed"]:
                    data = (backup / "files" / name).read_bytes()
                    if sha256(data) != entry["sha256"]:
                        raise OSError("原始备份校验失败")
                    atomic_write(path, data, entry["mode"])
                else:
                    path.unlink(missing_ok=True)
            except (Exception, KeyboardInterrupt) as rollback_error:
                failures.append(f"{name}: {rollback_error}")
        for directory in reversed(created_directories):
            try:
                directory.rmdir()
            except OSError as directory_error:
                failures.append(str(directory_error))
        receipt.update(status="rollback_failed" if failures else "rolled_back", error=str(error), rollback_errors=failures)
        try:
            write_receipt(receipt_path, receipt)
        except (Exception, KeyboardInterrupt) as receipt_error:
            failures.append(f"回执写入失败：{receipt_error}")
        recovery = "；需根据回执手动恢复：" + "; ".join(failures) if failures else "；已恢复本次已改文件"
        raise OSError(f"{error}{recovery}；保留备份：{backup}") from error
    return {
        "status": "completed", "updated": list(payloads),
        "backup_dir": str(backup), "receipt": str(receipt_path),
        "next_step": "请在 Chrome 扩展管理页手动点击 Reload（重新加载），再刷新目标网页。",
        "backup_note": "默认临时备份可能被系统清理；需长期保留时请使用 --backup-dir。",
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, metavar="EXISTING_EXTENSION_ROOT", help="现有扩展根目录，原位更新并保留用户数据")
    parser.add_argument("--backup-dir", type=Path, help="外部备份父目录；每次创建独立子目录，默认系统 tempfile 目录")
    args = parser.parse_args(argv)
    try:
        result = update(args.target, args.backup_dir)
    except (OSError, ValueError) as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
