"""Kepler 项目绑定、不可变批注快照与精确版本结果；仅使用标准库。"""
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import uuid

_native = runpy.run_path(str(Path(__file__).with_name("native-host.py")))
atomic_json = _native["atomic_json"]
atomic_bytes = _native["atomic_bytes"]
validate_payload = _native["validate_payload"]
NOISE = {"createdAt", "updatedAt", "status", "batchId", "projectId", "projectName", "libraryRevision"}
STATUSES = ("处理中", "待验收", "待确认", "无需修改")


class StoreError(ValueError):
    def __init__(self, message, code="PROJECT_STORE_ERROR"):
        super().__init__(message)
        self.code = code


def digest(value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def identifier(value, label):
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise StoreError(label + " 须为非空字符串", "INVALID_IDENTIFIER")
    return value


def revision_hash(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        raise StoreError("revision/cursor 须为快照内容哈希", "INVALID_REVISION")
    return value


def safe_path(path):
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise StoreError("本地路径须为无上级跳转的绝对路径", "UNSAFE_PATH")
    for component in (path, *path.parents):
        if component.is_symlink():
            raise StoreError("本地存储路径含符号链接", "UNSAFE_PATH")
    return path


def directory(path):
    return _native["secure_dir"](safe_path(path))


def read_bytes(path):
    path = safe_path(path)
    if not path.is_file():
        raise StoreError("本地文件缺失或类型无效：" + str(path), "MISSING_FILE")
    with os.fdopen(_native["private_file"](path, os.O_RDONLY), "rb") as stream:
        return stream.read()


def read_json(path):
    return _native["strict_json"](read_bytes(path).decode("utf-8"))


def save_json(path, value):
    safe_path(path)
    atomic_json(path, value)


@contextmanager
def file_lock(path):
    safe_path(path)
    with os.fdopen(_native["private_file"](path, os.O_RDWR | os.O_CREAT), "r+b") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def git(root, *args):
    executable = shutil.which("git")
    if executable is None:
        raise StoreError("请安装 Git 并加入 PATH 后再操作本地项目", "GIT_NOT_FOUND")
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    result = subprocess.run([executable, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", str(root), *args],
                            shell=False, capture_output=True, text=True, timeout=10, env=environment)
    if result.returncode:
        raise StoreError("本地 Git 校验失败：" + result.stderr[:1000], "GIT_VALIDATION_FAILED")
    return result.stdout.strip()


def git_root(value):
    identifier(value, "projectRoot")
    root = safe_path(value)
    if not root.is_dir():
        raise StoreError("projectRoot 须为已存在的 Git 根目录", "INVALID_PROJECT_ROOT")
    safe_path(root / ".git")
    if Path(git(root, "rev-parse", "--show-toplevel")).resolve() != root:
        raise StoreError("请绑定 Git 根目录，子目录需先改为仓库根路径", "INVALID_PROJECT_ROOT")
    return root


def item_revisions(batch, tasks, images):
    task_map = {task["id"]: task for task in tasks["tasks"]}
    result = {}
    for annotation in batch["annotations"]:
        task = {key: value for key, value in task_map[annotation["id"]].items() if key not in NOISE | {"key"}}
        task["evidence"] = {key: value for key, value in task["evidence"].items() if key not in NOISE}
        content = {key: value for key, value in annotation.items() if key not in NOISE}
        paths = _native["annotation_paths"](annotation)
        result[str(annotation["id"])] = digest({"annotation": content, "task": task, "images": {path: images[path] for path in paths}})
    return result


def snapshot_hash(project, batch, tasks, markdown, images):
    return digest({"projectId": project, "batch": batch, "aiTasks": tasks, "markdown": markdown, "images": images})


class ProjectStore:
    def __init__(self, config):
        self.home = safe_path(identifier(config.get("dataRoot"), "dataRoot")).parent
        self.registry = self.home / "projects.json"

    @contextmanager
    def registry_lock(self):
        directory(self.home)
        with file_lock(self.home / ".projects.lock"):
            value = read_json(self.registry) if self.registry.exists() or self.registry.is_symlink() else {"schemaVersion": 1, "projects": {}}
            if not isinstance(value, dict) or value.get("schemaVersion") != 1 or not isinstance(value.get("projects"), dict):
                raise StoreError("项目注册表格式无效", "INVALID_REGISTRY")
            for project, binding in value["projects"].items():
                if not isinstance(binding, dict) or binding.get("projectId") != project:
                    raise StoreError("项目注册表绑定无效", "INVALID_REGISTRY")
            yield value

    @contextmanager
    def project(self, project):
        project = identifier(project, "projectId")
        with self.registry_lock() as registry:
            binding = registry["projects"].get(project)
            if binding is None:
                yield None, None
                return
            root = git_root(binding.get("projectRoot"))
            local = directory(root / ".kepler-annotate")
            with file_lock(local / ".lock"):
                base = directory(local / "projects" / digest(project))
                yield binding, base

    @staticmethod
    def header(binding, project, batch=None):
        result = {"ok": True, "bound": binding is not None, "binding": binding, "projectId": project}
        if binding:
            result["projectRoot"] = binding["projectRoot"]
        if batch is not None:
            result["batchId"] = batch
        return result

    def info(self, project):
        identifier(project, "projectId")
        with self.registry_lock() as registry:
            return self.header(registry["projects"].get(project), project)

    def projects(self):
        with self.registry_lock() as registry:
            return {"ok": True, "projects": [registry["projects"][key] for key in sorted(registry["projects"])]}

    def bind(self, project, path, name=None):
        identifier(project, "projectId")
        root = git_root(path)
        if name is not None and not isinstance(name, str):
            raise StoreError("projectName 须为字符串")
        with self.registry_lock() as registry:
            local = directory(root / ".kepler-annotate")
            with file_lock(local / ".lock"):
                exclude = Path(git(root, "rev-parse", "--git-path", "info/exclude"))
                if not exclude.is_absolute():
                    exclude = root / exclude
                exclude = safe_path(Path(os.path.abspath(exclude)))
                if not exclude.parent.exists():
                    directory(exclude.parent)
                old = read_bytes(exclude) if exclude.exists() or exclude.is_symlink() else b""
                if b"/.kepler-annotate/" not in old.splitlines():
                    atomic_bytes(exclude, old + (b"\n" if old and not old.endswith(b"\n") else b"") + b"/.kepler-annotate/\n")
                binding = {"projectId": project, "projectName": name if name is not None else project, "projectRoot": str(root)}
                registry["projects"][project] = binding
                save_json(self.registry, registry)
                return self.header(binding, project)

    @staticmethod
    def batch_dir(base, batch):
        return safe_path(base / "batches" / digest(identifier(batch, "batchId")))

    def snapshot(self, base, project, batch, revision=None):
        location = self.batch_dir(base, batch)
        if revision is None:
            head = location / "HEAD"
            if not head.exists() and not head.is_symlink():
                raise StoreError("批次尚无已同步快照", "BATCH_NOT_FOUND")
            pointer = read_json(head)
            if pointer.get("projectId") != project or pointer.get("batchId") != batch:
                raise StoreError("批次 HEAD 身份不匹配", "CORRUPT_SNAPSHOT")
            revision = pointer.get("revision")
        folder = safe_path(location / "revisions" / revision_hash(revision))
        meta = read_json(folder / "snapshot.json")
        if meta.get("projectId") != project or meta.get("batchId") != batch or meta.get("revision") != revision:
            raise StoreError("cursor 不属于当前项目批次", "INVALID_CURSOR")
        annotations, tasks = read_json(folder / "annotations.json"), read_json(folder / "ai-tasks.json")
        markdown = read_bytes(folder / "annotations.md").decode("utf-8")
        paths = {path for item in annotations["annotations"] for path in _native["annotation_paths"](item)}
        images = {path: hashlib.sha256(read_bytes(folder / _native["safe_image_path"](path))).hexdigest() for path in paths}
        items = item_revisions(annotations, tasks, images)
        if (meta.get("images") != images or meta.get("itemRevisions") != items
                or snapshot_hash(project, annotations, tasks, markdown, images) != revision):
            raise StoreError("快照内容校验失败；原文件保留供检查", "CORRUPT_SNAPSHOT")
        return {"revision": revision, "folder": folder, "batch": annotations, "aiTasks": tasks, "itemRevisions": items}

    @staticmethod
    def results(base, batch):
        path = ProjectStore.batch_dir(base, batch) / "results.json"
        value = read_json(path) if path.exists() or path.is_symlink() else {"schemaVersion": 1, "items": {}}
        if not isinstance(value, dict) or value.get("schemaVersion") != 1 or not isinstance(value.get("items"), dict):
            raise StoreError("批次结果记录无效", "INVALID_RESULTS")
        return value

    def view(self, base, project, batch, snapshot, compact=False):
        results = self.results(base, batch)["items"]
        tasks = {task["id"]: task for task in snapshot["aiTasks"]["tasks"]}
        items = []
        for annotation in snapshot["batch"]["annotations"]:
            key = str(annotation["id"])
            revision = snapshot["itemRevisions"][key]
            result = results.get(key, {}).get(revision)
            item = {"id": annotation["id"], "revision": revision, "result": result,
                    "needsWork": result is None or result["status"] not in ("待验收", "无需修改")}
            if not compact:
                task = json.loads(json.dumps(tasks[annotation["id"]], ensure_ascii=False))
                evidence = task["evidence"]
                shot = evidence.get("screenshot")
                evidence["screenshot"] = str(snapshot["folder"] / shot) if shot else None
                evidence["references"] = [str(snapshot["folder"] / ref) for ref in evidence.get("references", [])]
                item.update(rawComment=annotation.get("text", ""), category=annotation.get("category"), annotation=annotation, task=task, evidence=evidence)
            items.append(item)
        return items

    def sync(self, request):
        batch, tasks, markdown, decoded = validate_payload(request)
        project = identifier(batch.get("projectId"), "batch.projectId")
        batch_id = batch["batchId"]
        with self.project(project) as (binding, base):
            response = self.header(binding, project, batch_id)
            if binding is None:
                return dict(response, revision=None, items=[])
            location = directory(self.batch_dir(base, batch_id))
            revisions = directory(location / "revisions")
            images = {path: hashlib.sha256(raw).hexdigest() for path, raw in decoded.items()}
            revision = snapshot_hash(project, batch, tasks, markdown, images)
            folder = safe_path(revisions / revision)
            if not folder.exists():
                stage = directory(revisions / (".staging-" + uuid.uuid4().hex))
                save_json(stage / "annotations.json", batch)
                atomic_bytes(stage / "annotations.md", markdown.encode("utf-8"))
                save_json(stage / "ai-tasks.json", tasks)
                for path, raw in decoded.items():
                    destination = stage / path
                    directory(destination.parent)
                    atomic_bytes(destination, raw)
                save_json(stage / "snapshot.json", {"schemaVersion": 1, "projectId": project, "batchId": batch_id, "revision": revision,
                                                    "images": images, "itemRevisions": item_revisions(batch, tasks, images)})
                os.rename(stage, folder)
                fd = os.open(str(revisions), os.O_RDONLY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
            snapshot = self.snapshot(base, project, batch_id, revision)
            save_json(location / "HEAD", {"projectId": project, "batchId": batch_id, "revision": revision})
            return dict(response, revision=revision, cursor=revision, folder=str(folder), items=self.view(base, project, batch_id, snapshot, compact=True))

    def read(self, project, batch, since=None, compact=False):
        identifier(batch, "batchId")
        with self.project(project) as (binding, base):
            response = self.header(binding, project, batch)
            if binding is None:
                return dict(response, revision=None, cursor=None, items=[])
            current = self.snapshot(base, project, batch)
            items = self.view(base, project, batch, current, compact)
            response.update(revision=current["revision"], cursor=current["revision"], folder=str(current["folder"]), items=items)
            if since is not None:
                previous = self.snapshot(base, project, batch, revision_hash(since))
                before, after = previous["itemRevisions"], current["itemRevisions"]
                added = [item for item in items if str(item["id"]) not in before]
                modified = [item for item in items if str(item["id"]) in before and before[str(item["id"])] != item["revision"]]
                deleted = [{"id": int(key), "revision": value, "tombstone": True, "needsWork": False}
                           for key, value in before.items() if key not in after]
                response.update(since=since, added=added, modified=modified, deleted=deleted,
                                items=[item for item in items if str(item["id"]) not in before or before[str(item["id"])] != item["revision"]])
            return response

    def batches(self, project):
        with self.project(project) as (binding, base):
            response = self.header(binding, project)
            items = []
            location = safe_path(base / "batches") if base else None
            if location and location.exists():
                for path in sorted(location.iterdir()):
                    safe_path(path)
                    if not re.fullmatch(r"[a-f0-9]{64}", path.name):
                        continue
                    head = path / "HEAD"
                    if not head.exists():
                        continue
                    pointer = read_json(head)
                    batch = pointer.get("batchId")
                    snapshot = self.snapshot(base, project, batch)
                    items.append({"batchId": batch, "name": snapshot["batch"].get("name"), "revision": snapshot["revision"],
                                  "cursor": snapshot["revision"], "count": len(snapshot["batch"]["annotations"])})
            return dict(response, batches=items)

    def result(self, project, batch, number, revision, status, summary, branch=None, commit=None, checks=None, requirements=None):
        revision_hash(revision)
        if not _native["safe_integer"](number) or status not in STATUSES or not isinstance(summary, str) or not summary.strip():
            raise StoreError("结果须含原编号、允许的状态与非空 summary", "INVALID_RESULT")
        if requirements is not None and (not isinstance(requirements, str) or "\x00" in requirements):
            raise StoreError("requirements 只接收路径文本", "INVALID_RESULT")
        with self.project(project) as (binding, base):
            if binding is None:
                raise StoreError("请先绑定项目", "PROJECT_NOT_BOUND")
            current = self.snapshot(base, project, batch)
            if current["itemRevisions"].get(str(number)) != revision:
                raise StoreError("条目已删除或 revision 版本已变化，请重新读取", "STALE_ITEM_REVISION")
            if status == "待验收":
                if not isinstance(branch, str) or not branch.startswith("codex/") or not isinstance(commit, str) or not re.fullmatch(r"[0-9a-fA-F]{7,64}", commit):
                    raise StoreError("待验收须有 codex/* 分支与本仓存在的 commit", "INVALID_ACCEPTANCE_EVIDENCE")
                if not isinstance(checks, list) or not checks or any(
                    not isinstance(check, dict) or type(check.get("exitCode")) is not int or check["exitCode"] != 0
                    or not isinstance(check.get("cmd", check.get("command")), str) or not check.get("cmd", check.get("command")).strip()
                    for check in checks
                ):
                    raise StoreError("待验收须有非空命令 checks 且 exitCode 全为 0", "INVALID_ACCEPTANCE_EVIDENCE")
                git(binding["projectRoot"], "check-ref-format", "--branch", branch)
                git(binding["projectRoot"], "cat-file", "-e", commit + "^{commit}")
                commit = git(binding["projectRoot"], "rev-parse", "--verify", commit + "^{commit}")
                git(binding["projectRoot"], "show-ref", "--verify", "refs/heads/" + branch)
                git(binding["projectRoot"], "merge-base", "--is-ancestor", commit, "refs/heads/" + branch)
            if isinstance(checks, list):
                checks = [dict(check, command=check.get("cmd", check.get("command"))) if isinstance(check, dict) else check for check in checks]
            record = {"id": number, "revision": revision, "status": status, "summary": summary, "branch": branch, "commit": commit,
                      "checks": checks, "requirements": requirements, "updatedAt": datetime.now(timezone.utc).isoformat()}
            result = self.results(base, batch)
            result["items"].setdefault(str(number), {})[revision] = record
            save_json(self.batch_dir(base, batch) / "results.json", result)
            return dict(self.header(binding, project, batch), revision=current["revision"], itemRevision=revision, id=number, result=record)
