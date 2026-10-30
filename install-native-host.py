#!/usr/bin/env python3
"""macOS Native Messaging 安装器；POSIX 后端，Windows 暂不支持。"""
import argparse
import os
from pathlib import Path
import re
import runpy
import shlex
import shutil
import sys
import uuid

HOST_NAME = "com.kepler.annotate"


def main(argv=None):
    parser = argparse.ArgumentParser(description="安装 macOS Kepler Annotate 本机交接主机，原配置会保留备份",
                                     epilog="后端需要 POSIX 文件锁与权限；Windows 暂不支持。其他 POSIX 平台仅可用 --config-root 测试 macOS 注册布局。配置和启动器是本地安装产物，请勿发布。")
    parser.add_argument("--extension-id", required=True, help="浏览器中实际加载的扩展 ID")
    parser.add_argument("--codex-path", help="Codex 可执行文件绝对路径；默认从 PATH 查找；本地项目功能无需 Codex")
    parser.add_argument("--thread", default=os.environ.get("CODEX_THREAD_ID"), help="可选默认 Codex 对话 UUID；默认取 CODEX_THREAD_ID，也可发送时填写")
    parser.add_argument("--config-root", type=Path, help="替代 ~/Library/Application Support，用于隔离安装测试")
    args = parser.parse_args(argv)
    os.umask(0o077)
    try:
        if os.name != "posix":
            raise ValueError("后端需要 POSIX；Windows 暂不支持")
        if sys.platform != "darwin" and args.config_root is None:
            raise ValueError("默认浏览器注册仅支持 macOS；其他 POSIX 平台可用 --config-root 隔离测试")
        source = Path(__file__).resolve().parent
        host_path = source / "native-host.py"
        helpers = runpy.run_path(str(host_path))
        thread = helpers["thread_uuid"](args.thread) if args.thread else None
        if not re.fullmatch(r"[a-p]{32}", args.extension_id):
            raise ValueError("extension-id 须为 32 位 a-p 字符")
        codex = args.codex_path if args.codex_path is not None else shutil.which("codex")
        if codex is not None:
            if args.codex_path is not None and not Path(codex).is_absolute():
                raise ValueError("--codex-path 须为可执行文件的绝对路径")
            if not Path(codex).is_file() or not os.access(codex, os.X_OK):
                raise ValueError("--codex-path 指向的文件不存在或不可执行")
            codex = str(Path(codex).absolute())
        support = (args.config_root or Path.home() / "Library/Application Support").expanduser().absolute()
        data_root = support / "KeplerAnnotate/handoffs"
        config_path = source / "native-host-config.json"
        launcher_path = source / "native-host-launcher"
        launcher = "#!/bin/sh\nexec " + shlex.quote(sys.executable) + " " + shlex.quote(str(host_path)) + ' "$@"\n'
        config = {"codexPath": codex, "defaultThread": thread, "dataRoot": str(data_root)}
        manifest = {"name": HOST_NAME, "description": "Kepler Annotate 本地批注交接", "path": str(launcher_path),
                    "type": "stdio", "allowed_origins": ["chrome-extension://" + args.extension_id + "/"]}
        destinations = [(config_path, config)] + [
            (support / product / "NativeMessagingHosts" / (HOST_NAME + ".json"), manifest)
            for product in ("Google/Chrome", "Google/ChromeForTesting", "Chromium")]
        # 先检查目标类型，再写配置；现有配置按原始字节保留，交接数据始终保留。
        for path in [launcher_path, *(path for path, _ in destinations)]:
            if path.is_symlink() or (path.exists() and not path.is_file()):
                raise ValueError("已有配置须为普通文件：" + str(path))
        helpers["secure_dir"](data_root)
        backups = []
        for path, value in [(launcher_path, launcher.encode("utf-8")), *destinations]:
            if path not in (config_path, launcher_path):
                helpers["secure_dir"](path.parent)
            if path.exists():
                backup = path.with_name(path.name + ".bak-" + uuid.uuid4().hex)
                helpers["atomic_bytes"](backup, path.read_bytes())
                backups.append(str(backup))
            if path == launcher_path:
                helpers["atomic_bytes"](path, value)
                os.chmod(path, 0o700)
            else:
                helpers["atomic_json"](path, value)
        os.chmod(host_path, 0o700)
        print(helpers["json"].dumps({"ok": True, "host": HOST_NAME, "config": str(config_path),
                                    "defaultThread": thread, "codexPath": codex, "dataRoot": str(data_root), "launcher": str(launcher_path),
                                    "manifests": [str(path) for path, _ in destinations[1:]], "backups": backups}, ensure_ascii=False, indent=2))
        return 0
    except Exception as error:
        print("安装失败；现有交接数据保留：" + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
