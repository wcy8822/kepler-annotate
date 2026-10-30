#!/usr/bin/env python3
"""本地 Kepler 批注查询与结果登记；不执行业务代码或发送消息。"""
import argparse
import json
from pathlib import Path
import runpy
import sys

sys.dont_write_bytecode = True


def main(argv=None):
    parser = argparse.ArgumentParser(description="绑定本地项目、查询批注及登记精确版本处理结果",
                                     epilog="需要 POSIX 文件锁与权限、PATH 中的 Git；Windows 暂不支持。本地项目功能无需 Codex 或默认对话。默认读取同目录 native-host-config.json；隔离联调用 KEPLER_ANNOTATE_CONFIG 指定绝对配置路径。")
    commands = parser.add_subparsers(dest="command", required=True)
    bind = commands.add_parser("bind", help="绑定 Git 根目录")
    bind.add_argument("--project", required=True)
    bind.add_argument("--path", required=True)
    bind.add_argument("--name")
    commands.add_parser("projects", help="列出已绑定项目")
    batches = commands.add_parser("batches", help="列出项目已同步批次")
    batches.add_argument("--project", required=True)
    read = commands.add_parser("read", help="读取批注；--since 返回新增、修改和删除")
    read.add_argument("--project", required=True)
    read.add_argument("--batch", required=True)
    read.add_argument("--since")
    result = commands.add_parser("result", help="登记当前条目版本结果，保留待人工验收状态")
    result.add_argument("--project", required=True)
    result.add_argument("--batch", required=True)
    result.add_argument("--id", required=True, type=int)
    result.add_argument("--revision", required=True)
    result.add_argument("--status", required=True, choices=("处理中", "待验收", "待确认", "无需修改"))
    result.add_argument("--summary", required=True)
    result.add_argument("--branch")
    result.add_argument("--commit")
    result.add_argument("--checks-file", help="JSON 数组或含 commands/checks 数组的 JSON 对象")
    result.add_argument("--requirements", help="只登记需求文件路径，不读取或生成文件")
    args = parser.parse_args(argv)
    try:
        source = Path(__file__).resolve().parent
        native = runpy.run_path(str(source / "native-host.py"))
        store_module = runpy.run_path(str(source / "project_store.py"))
        store = store_module["ProjectStore"](native["load_config"]())
        if args.command == "bind":
            response = store.bind(args.project, args.path, args.name)
        elif args.command == "projects":
            response = store.projects()
        elif args.command == "batches":
            response = store.batches(args.project)
        elif args.command == "read":
            response = store.read(args.project, args.batch, since=args.since)
        else:
            checks = store_module["read_json"](Path(args.checks_file).absolute()) if args.checks_file else None
            if isinstance(checks, dict):
                checks = checks.get("commands", checks.get("checks"))
            response = store.result(args.project, args.batch, args.id, args.revision, args.status, args.summary,
                                    branch=args.branch, commit=args.commit, checks=checks, requirements=args.requirements)
        print(json.dumps(response, ensure_ascii=False, allow_nan=False))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)[:2000], "code": getattr(error, "code", "PROJECT_STORE_ERROR")}, ensure_ascii=True))
        return 1


if __name__ == "__main__":
    sys.exit(main())
