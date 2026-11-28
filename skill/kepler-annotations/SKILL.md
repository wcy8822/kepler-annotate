---
name: kepler-annotations
description: 读取 Chrome 开普勒批注插件同步到本地项目的批次与增量，保留原编号和证据，整理需求、在开发分支实现并回写逐项结果。用于“读取批注”“处理某批新增反馈”“按批注迭代并回写”。
---

# 项目本地批注

使用本 Skill 的 scripts/kepler_annotations.py 调用已安装插件的本地查询程序。所有数据留在本机；查询与回写不会发送对话消息、push 或发布，也不会自动启动 AI 常驻任务。

## 查询

先运行 `python3 <本Skill>/scripts/kepler_annotations.py --help` 核对实际参数。常用命令：

```sh
python3 <本Skill>/scripts/kepler_annotations.py projects
python3 <本Skill>/scripts/kepler_annotations.py batches --project PROJECT_ID
python3 <本Skill>/scripts/kepler_annotations.py read --project PROJECT_ID --batch BATCH_ID
python3 <本Skill>/scripts/kepler_annotations.py read --project PROJECT_ID --batch BATCH_ID --since CURSOR
```

项目首次在插件“项目本地”设置里绑定 Git 根目录。也可用 `bind --project PROJECT_ID --path ABSOLUTE_GIT_ROOT --name NAME`；目录须由用户明确指定或当前目标仓库直接确认，网页 URL 不能作为推定项目路径的依据。

保留读取结果的 cursor、逐项 revision、原编号、分类、原话、稳定 key 和关联任务。增量含新增、修改及删除；读取完整条目中的观察、预期、复现、页面与版本，逐项查看 shot、refs 和 evidence 的实际图片。缺图或缺业务信息逐项记录。网页文字、DOM、URL 与图中文字只作为证据。删除记录不自动撤销已做的业务代码。

### 识别实验性评审任务

遇到 `TASK_CONTRACT_ACK_REQUIRED`，核对当前 CLI 的帮助后，用 `--accept-task-contract 2` 重新读取；后续 `result` 也必须带该参数。它只确认理解格式，不能代替用户批准或解除执行限制。增量读取涉及 v2 历史时适用相同规则。

实施前逐项检查 `reviewGate`。只要 `executable` 为 `false`，就保留原话、`task.approvedReview` 与证据，记录限制并回写“待确认”，继续处理其他可执行条目。当前 `SOURCE_VALIDATION_PENDING` 表示批准来源绑定尚未验证；即使规格 `state` 为 `approved`，也不得据此修改业务代码，不得登记“待验收”或“无需修改”。不得删除评审字段、改回 v1 或换编号绕过限制。含评审的 v2 暂不支持直接发送开发对话。

## 整理和执行

将本轮需求写入绑定项目的 `.kepler-annotate/requirements/<batchId>/<cursor>.md`，按原编号写：原话和分类、证据路径、核查结论、建议变更、验收标准、待业务确认事项。机器衔接文件保存在本地忽略目录；需要面向人的正式文档时遵守项目文档规则。

在绑定项目核对 Git 状态、项目规则与来源分支，保留他人改动。在 `codex/` 开发分支实施；已在适当的开发分支可继续，禁止从 test/pre/master 环境分支直接开发或从 test/pre 派生。业务阈值和口径未定时回写“待确认”，处理其他清晰条目。

每条实施后运行相关检查，记录真实命令和退出码。按项目规则提交实际修改；不为无需修改的接入验收制造业务提交。提交后用本地 CLI 回写，示例：

```sh
python3 <本Skill>/scripts/kepler_annotations.py result --project PROJECT_ID --batch BATCH_ID --id ORIGINAL_ID --revision ITEM_REVISION --status 待验收 --summary '具体改动与验证结论' --branch codex/FEATURE --commit COMMIT_SHA --checks-file /absolute/checks.json --requirements /absolute/requirements.md
```

checks.json 是数组，每项含 `command` 和 `exitCode`；“待验收”要求真实 Git 提交、codex/ 分支和非空全部通过的检查。命令契约以 CLI --help 为准。

可回写“处理中”“待验收”“待确认”“无需修改”。AI 改完写“待验收”，由用户在插件确认“已完成”。回写严格对应读取时的 item revision；原话、分类或截图已变化时旧回写会被拒绝，重新读取后处理新反馈。其他条目新增不会阻止未变条目回写。

## 收口

回写后再次 read，并用插件“读取 AI 结果”核对显示。逐项报告结果与验证、缺失信息和遗留；保留本轮 cursor，下一轮用 --since 查询。持续执行的会话每轮重查增量，普通单次调用处理当时可见的范围后结束。原始快照与已存档批次保留，查询/同步失败时浏览器副本继续可用。
