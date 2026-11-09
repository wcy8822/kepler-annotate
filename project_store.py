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
validate_review_contract = _native["validate_review_contract"]
_review_basis = runpy.run_path(str(Path(__file__).with_name("review_basis.py")))
validate_basis_entry = _review_basis["validate_basis_entry"]
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


def acknowledge_task_contract(snapshot, accepted):
    if snapshot["aiTasks"].get("schemaVersion") == 2 and (type(accepted) is not int or accepted != 2):
        raise StoreError("读取或登记 v2 任务须显式确认 --accept-task-contract 2；确认不会解除评审执行限制",
                         "TASK_CONTRACT_ACK_REQUIRED")


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

    def verify_review_head_checkpoint(self, base, project, batch):
        """Detect old hosts changing HEAD without updating the independent review pointer.

        The checkpoint starts on the first v2 sync. Missing pre-existing
        checkpoints cannot retroactively establish a trusted event history.
        """
        location = self.batch_dir(base, batch)
        anchor = safe_path(location / "review-head-checkpoint.json")
        if not anchor.exists() and not anchor.is_symlink():
            return False
        checkpoint = read_json(anchor)
        head = safe_path(location / "HEAD")
        if not head.exists() and not head.is_symlink():
            raise StoreError("评审 HEAD 已丢失，与独立检查点不一致", "REVIEW_HEAD_ROLLBACK")
        current = read_json(head)
        expected_keys = {"schemaVersion", "projectId", "batchId", "revision"}
        if (not isinstance(checkpoint, dict) or set(checkpoint) != expected_keys
                or type(checkpoint.get("schemaVersion")) is not int or checkpoint["schemaVersion"] != 1
                or checkpoint.get("projectId") != project or checkpoint.get("batchId") != batch
                or not isinstance(checkpoint.get("revision"), str)
                or not re.fullmatch(r"[a-f0-9]{64}", checkpoint["revision"])
                or not isinstance(current, dict) or current.get("projectId") != project
                or current.get("batchId") != batch or current.get("revision") != checkpoint["revision"]):
            raise StoreError("评审 HEAD 与独立检查点不一致，禁止恢复历史决定；需人工核查原快照",
                             "REVIEW_HEAD_ROLLBACK")
        return True

    def snapshot(self, base, project, batch, revision=None, *, validate_basis=True):
        location = self.batch_dir(base, batch)
        if revision is None:
            self.verify_review_head_checkpoint(base, project, batch)
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
        # A valid content checksum does not establish that a review contract is valid.
        # Pure v1 is deliberately left unchanged by this validator.
        validate_review_contract(annotations, tasks, images)
        if tasks.get("schemaVersion") == 2 and (annotations.get("projectId") != project or annotations.get("batchId") != batch):
            raise StoreError("评审快照内部项目或批次身份不匹配", "CORRUPT_SNAPSHOT")
        items = item_revisions(annotations, tasks, images)
        if (meta.get("images") != images or meta.get("itemRevisions") != items
                or snapshot_hash(project, annotations, tasks, markdown, images) != revision):
            raise StoreError("快照内容校验失败；原文件保留供检查", "CORRUPT_SNAPSHOT")
        if validate_basis:
            self.verify_review_basis(base, project, batch, annotations, tasks, images)
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
            if "approvedReview" in tasks[annotation["id"]]:
                item["reviewGate"] = {"code": "SOURCE_VALIDATION_PENDING", "executable": False}
                item["needsWork"] = True
            if not compact:
                task = json.loads(json.dumps(tasks[annotation["id"]], ensure_ascii=False))
                evidence = task["evidence"]
                shot = evidence.get("screenshot")
                evidence["screenshot"] = str(snapshot["folder"] / shot) if shot else None
                evidence["references"] = [str(snapshot["folder"] / ref) for ref in evidence.get("references", [])]
                item.update(rawComment=annotation.get("text", ""), category=annotation.get("category"), annotation=annotation, task=task, evidence=evidence)
            items.append(item)
        return items


    def verify_review_basis(self, base, project, batch, annotations, tasks, images):
        """Bind opt-in review transforms to checksum-verified unreviewed history.

        Legacy v2 without sourceTransform stays readable and non-executable.
        A matching H0/H1 is evidence of provenance, not a user approval event.
        """
        if tasks.get("schemaVersion") != 2:
            return
        entries = annotations.get("approvedSnapshot", {}).get("entries", {})
        selected = [(key, value) for key, value in entries.items() if "sourceTransform" in value]
        if not selected:
            return
        revisions = safe_path(self.batch_dir(base, batch) / "revisions")
        if not revisions.is_dir():
            raise StoreError("未找到可信批次历史，无法验证评审来源", "REVIEW_BASIS_NOT_FOUND")
        current = {str(item["id"]): item for item in annotations["annotations"]}
        for key, entry in selected:
            source_revision = entry.get("sourceItemRevision")
            if not isinstance(source_revision, str) or not re.fullmatch(r"[a-f0-9]{64}", source_revision):
                raise StoreError("H0 必须引用已保存的精确 item revision", "REVIEW_BASIS_NOT_FOUND")
            matched = False
            for path in sorted(revisions.iterdir()):
                safe_path(path)
                if not re.fullmatch(r"[a-f0-9]{64}", path.name):
                    continue
                metadata = read_json(path / "snapshot.json")
                revisions_map = metadata.get("itemRevisions") if isinstance(metadata, dict) else None
                if not isinstance(revisions_map, dict) or revisions_map.get(key) != source_revision:
                    continue
                historical = self.snapshot(base, project, batch, path.name, validate_basis=False)
                old_task = next((task for task in historical["aiTasks"].get("tasks", [])
                                 if str(task.get("id")) == key), None)
                if old_task is None or "approvedReview" in old_task:
                    continue  # Reconfirmation from an already reviewed H0 requires a later protocol.
                old_item = next((item for item in historical["batch"]["annotations"]
                                 if str(item["id"]) == key), None)
                if old_item is None or historical["itemRevisions"].get(key) != source_revision:
                    continue
                old_hashes = {name: hashlib.sha256(read_bytes(historical["folder"] / _native["safe_image_path"](name))).hexdigest()
                              for name in _native["annotation_paths"](old_item)}
                current_hashes = {name: images[name] for name in _native["annotation_paths"](current[key])}
                try:
                    validate_basis_entry(entry, source_revision, old_item, old_hashes, current[key], current_hashes)
                except ValueError as error:
                    raise StoreError("历史来源与声明的转换不一致：" + str(error), "INVALID_REVIEW_BASIS") from error
                matched = True
                break
            if not matched:
                raise StoreError("找不到匹配的未评审 H0 item revision；快照 cursor 或伪造 H0 不可代替",
                                 "REVIEW_BASIS_NOT_FOUND")


    def prevent_review_decision_reuse(self, base, project, batch, annotations, tasks, current_revisions):
        """Bind each review UUID to one item revision and one immutable decision record.

        A v2 format acknowledgement, matching hash, or repeated ID is never user
        approval. Earlier snapshots may be read; changing or transplanting their
        decision IDs is rejected before HEAD or results are updated.
        """
        if tasks.get("schemaVersion") != 2:
            return
        entries = annotations.get("approvedSnapshot", {}).get("entries", {})
        if not entries:
            return
        claimed = {}
        claimed_by_item = {}
        for key, entry in entries.items():
            identity = (key, current_revisions[key], digest(entry))
            claimed_by_item[key] = identity
            for kind, value in (("approvalId", entry["approvalId"]),
                                ("decisionId", entry["spec"]["decisionId"])):
                slot = (kind, value)
                if slot in claimed and claimed[slot] != identity:
                    raise StoreError("一个评审决定 ID 不能绑定不同条目或内容", "REVIEW_DECISION_REPLAY")
                claimed[slot] = identity

        # The current HEAD (not an arbitrary old revision) defines the active
        # decision for each item. Replaying an earlier, byte-identical decision
        # after withdrawal/reconfirmation must not restore old work results.
        head_path = safe_path(self.batch_dir(base, batch) / "HEAD")
        active_review = {}
        if head_path.exists() or head_path.is_symlink():
            active = self.snapshot(base, project, batch, validate_basis=False)
            for key, entry in active["batch"].get("approvedSnapshot", {}).get("entries", {}).items():
                active_review[key] = (key, active["itemRevisions"][key], digest(entry))
        revisions = safe_path(self.batch_dir(base, batch) / "revisions")
        if not revisions.exists():
            return
        for folder in sorted(revisions.iterdir()):
            safe_path(folder)
            if not re.fullmatch(r"[a-f0-9]{64}", folder.name):
                continue
            old_tasks = read_json(folder / "ai-tasks.json")
            if not isinstance(old_tasks, dict) or old_tasks.get("schemaVersion") != 2:
                continue
            # Recheck disk evidence and the historical item revision; never trust
            # a self-declared approval record without its immutable snapshot.
            previous = self.snapshot(base, project, batch, folder.name, validate_basis=False)
            for key, entry in previous["batch"]["approvedSnapshot"]["entries"].items():
                identity = (key, previous["itemRevisions"][key], digest(entry))
                for kind, value in (("approvalId", entry["approvalId"]),
                                    ("decisionId", entry["spec"]["decisionId"])):
                    slot = (kind, value)
                    if slot in claimed and claimed[slot] != identity:
                        raise StoreError("评审决定 ID 已用于其他版本；须保留原历史并生成新决定",
                                         "REVIEW_DECISION_REPLAY")
                if claimed_by_item.get(key) == identity and active_review.get(key) != identity:
                    raise StoreError("旧评审决定已被撤回或替换，不能重新同步历史版本；须创建新的确认决定",
                                     "REVIEW_DECISION_REWIND")

    def prevent_review_downgrade(self, base, project, batch, tasks):
        unreviewed = {str(task["id"]) for task in tasks["tasks"] if "approvedReview" not in task}
        if not unreviewed:
            return
        revisions = safe_path(self.batch_dir(base, batch) / "revisions")
        if not revisions.exists():
            return
        # Include non-adjacent history: deleting an item and restoring its old ID
        # must not revive a v1 result that predates its review decisions.
        for folder in sorted(revisions.iterdir()):
            safe_path(folder)
            if not re.fullmatch(r"[a-f0-9]{64}", folder.name):
                continue
            previous_tasks = read_json(folder / "ai-tasks.json")
            if not isinstance(previous_tasks, dict) or not isinstance(previous_tasks.get("tasks"), list):
                raise StoreError("历史任务快照格式无效", "CORRUPT_SNAPSHOT")
            reviewed = {str(task.get("id")) for task in previous_tasks["tasks"]
                        if isinstance(task, dict) and "approvedReview" in task}
            if previous_tasks.get("schemaVersion") == 2 or reviewed:
                self.snapshot(base, project, batch, folder.name)
                if reviewed & unreviewed:
                    raise StoreError("已存在评审历史的条目不能删除 approvedReview；撤回须保留 withdrawn 决定",
                                     "TASK_CONTRACT_DOWNGRADE")

    def sync(self, request):
        batch, tasks, markdown, decoded = validate_payload(request)
        project = identifier(batch.get("projectId"), "batch.projectId")
        batch_id = batch["batchId"]
        with self.project(project) as (binding, base):
            response = self.header(binding, project, batch_id)
            if binding is None:
                return dict(response, revision=None, items=[])
            checkpointed = self.verify_review_head_checkpoint(base, project, batch_id)
            self.prevent_review_downgrade(base, project, batch_id, tasks)
            location = directory(self.batch_dir(base, batch_id))
            revisions = directory(location / "revisions")
            images = {path: hashlib.sha256(raw).hexdigest() for path, raw in decoded.items()}
            self.verify_review_basis(base, project, batch_id, batch, tasks, images)
            self.prevent_review_decision_reuse(base, project, batch_id, batch, tasks,
                                               item_revisions(batch, tasks, images))
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
            # Write the independent checkpoint first. A crash before the HEAD
            # update fails closed on the next read rather than reviving old work.
            if tasks.get("schemaVersion") == 2 or checkpointed:
                save_json(location / "review-head-checkpoint.json", {"schemaVersion": 1,
                    "projectId": project, "batchId": batch_id, "revision": revision})
            save_json(location / "HEAD", {"projectId": project, "batchId": batch_id, "revision": revision})
            return dict(response, revision=revision, cursor=revision, folder=str(folder), items=self.view(base, project, batch_id, snapshot, compact=True))

    def read(self, project, batch, since=None, compact=False, accept_task_contract=None):
        identifier(batch, "batchId")
        with self.project(project) as (binding, base):
            response = self.header(binding, project, batch)
            if binding is None:
                return dict(response, revision=None, cursor=None, items=[])
            current = self.snapshot(base, project, batch)
            acknowledge_task_contract(current, accept_task_contract)
            self.prevent_review_downgrade(base, project, batch, current["aiTasks"])
            self.prevent_review_decision_reuse(base, project, batch, current["batch"], current["aiTasks"],
                                               current["itemRevisions"])
            previous = None
            if since is not None:
                previous = self.snapshot(base, project, batch, revision_hash(since))
                acknowledge_task_contract(previous, accept_task_contract)
            items = self.view(base, project, batch, current, compact)
            response.update(revision=current["revision"], cursor=current["revision"], folder=str(current["folder"]), items=items)
            if since is not None:
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

    def result(self, project, batch, number, revision, status, summary, branch=None, commit=None, checks=None, requirements=None,
               accept_task_contract=None):
        revision_hash(revision)
        if not _native["safe_integer"](number) or status not in STATUSES or not isinstance(summary, str) or not summary.strip():
            raise StoreError("结果须含原编号、允许的状态与非空 summary", "INVALID_RESULT")
        if requirements is not None and (not isinstance(requirements, str) or "\x00" in requirements):
            raise StoreError("requirements 只接收路径文本", "INVALID_RESULT")
        with self.project(project) as (binding, base):
            if binding is None:
                raise StoreError("请先绑定项目", "PROJECT_NOT_BOUND")
            current = self.snapshot(base, project, batch)
            acknowledge_task_contract(current, accept_task_contract)
            self.prevent_review_downgrade(base, project, batch, current["aiTasks"])
            self.prevent_review_decision_reuse(base, project, batch, current["batch"], current["aiTasks"],
                                               current["itemRevisions"])
            if current["itemRevisions"].get(str(number)) != revision:
                raise StoreError("条目已删除或 revision 版本已变化，请重新读取", "STALE_ITEM_REVISION")
            task = next(task for task in current["aiTasks"]["tasks"] if task["id"] == number)
            if "approvedReview" in task and status in ("待验收", "无需修改"):
                raise StoreError("评审来源绑定尚未验证，只能保留处理中或待确认；不能登记完成性结果",
                                 "REVIEW_SOURCE_VALIDATION_PENDING")
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
