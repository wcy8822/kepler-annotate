# 实验性评审任务契约

本页描述 V1.5 阶段 A 的实际代码边界。原始 `annotations.json` 继续使用 `schemaVersion: 1`；当前浏览器和 ZIP 生成器继续输出原 v1 任务。v2 是新增的项目同步格式，尚未开放评审任务开发执行。

## B1 原始来源摘要（仅纯函数，未启用）

`review-source.js` 与 `review_source.py` 新增 `sourceRecord / sourceJSON / sourceHash` 与 `source_record / source_json / source_hash`。两端输入为**单条原始批注和实际图片字节计算所得的哈希表**，不读取用户数据或调用模型；返回 UTF-8 紧凑 JSON 与 SHA-256。独立合成黄金向量位于 `tests/fixtures/review-source-v1.json`，覆盖图片、非 ASCII 文件名及无图片情况。其字段顺序固定为 `schemaVersion, id, text, category, observed, expected, reproduction, shot, refs, images`；images 按路径 UTF-8 字节升序排序，每项按 `path, sha256` 顺序存储。未填 text 映射空字符串，未填分类/文本细项映射 null，未填 refs 映射空列表；其他非来源运行字段不进入摘要。

来源不变量：编号为正安全整数；类别仅五类或 null；原话和细项不做 trim 或语义改写；截图必须位于 shots/，参考图位于 refs/；路径拒绝穿越、控制字符和非法扩展；哈希表键与唯一原始引用完全一致，值为 64 位小写 SHA-256。该算法**并非原有 item revision**，不得替换 `project_store.item_revisions`，不得改变历史 v1 hash。没有图片的草稿允许计算，不能因此假定有截图。

B1 首先提供独立来源纯函数；B2 已将 `appliesToSourceHash` 强制绑定当前原始批注和实际图片字节，但**尚未校验 `basisSourceHash` 所指向的 H0 历史、H0→H1 转换或用户批准事件**。它没有把 URL、元素、视口、绘图、构建版本等上下文纳入 sourceHash；此类内容必须另外定义和校验 contextHash。仅相等的摘要既不是用户确认事件，也不是 H0→H1 授权转换；可信批准事件、类别采纳、附加证据及历史撤回仍须后续实现。阶段 A 的 `SOURCE_VALIDATION_PENDING`、当前 v2 禁止执行以及 `send` 禁用保持不变。

## B2 当前来源 H1 校验（仍不可执行）

Native `project-sync` 与历史快照读取现调用 B1 Python 来源规范化函数，对含 `approvedReview` 的每条批注使用原始 `annotations[]` 字段及**解码或磁盘重新读取的实际图片字节 SHA-256**计算 H1，并强制匹配 `approvedSnapshot.entries[id].appliesToSourceHash`。即使任务本身的原话、类别与被篡改的批注同步变化，H1 不一致仍拒绝完整同步或读取。旧 v1 代码路径不调用此函数，不改变历史 v1 的 snapshot 或 item revision hash。

仅绑定**当前来源内容**，并不证明 H0 的真实性、允许的类别采纳/新增证据、上下文与用户确认事件；`basisSourceHash` 仍未验证。 `sourceBindingValidation: false` 和 `reviewExecution: false` 不变，所有含评审条目继续 `SOURCE_VALIDATION_PENDING`，不能登记“待验收”“无需修改”，旧 v2 send 继续拒绝。验证采用虚构原话、合成图片以及失败后 HEAD 不变的回归；真实浏览器审批链路后续独立验证。

## 版本与能力

`info.capabilities` 声明 `taskContracts: [1, 2]`、`reviewTaskValidation: "structure_and_evidence"`、`sourceBindingValidation: false`、`reviewExecution: false`。这表示主机能保留并校验格式和图片关联，不表示能够验证批准来源，更不表示已内置模型。

| 情况 | 行为 |
| --- | --- |
| 纯 v1 | 保持原 task 内容、快照算法、条目 hash 和读写行为；不补 `approvedReview: null` 等默认字段 |
| v1 带 `approvedSnapshot` 或任务带 `approvedReview`，即使值为 null | 拒绝 `TASK_CONTRACT_DOWNGRADE` |
| v2 项目同步 | 校验后保存不可变快照；返回同步收据，不触发 Agent |
| v2 CLI read/result | 须加 `--accept-task-contract 2`；参数只确认消费方理解格式 |
| 增量读取涉及 v2 历史 | 当前快照与 `--since` 的历史快照均需识别；不可因当前已删除评审条目而略过 |
| Native project-read | 使用整数 `acceptTaskContract: 2`，与 CLI 同一限制 |
| v2 send | 拒绝 `TASK_CONTRACT_UNSUPPORTED_FOR_SEND`，不写交接目录、不排队 |

## 保存格式

在原始批次顶层增加可选 `approvedSnapshot`；只有包含评审语义的任务集合使用 `aiTasks.schemaVersion: 2`。同一批次可以混有普通条目，不能为普通条目增加空评审字段。

```text
batch (schemaVersion: 1)
  annotations[]                   原编号、原话、类别、shot、refs
  approvedSnapshot
    schemaVersion: 1
    entries[原条目编号的十进制字符串]
      approvalId
      basisSourceHash
      appliesToSourceHash
      contextHash
      sourceItemRevision
      state
      spec                        与该任务 approvedReview 严格一致
aiTasks (schemaVersion: 2)
  project.id / batch.id
  tasks[]                         保留原有字段和稳定 key
    approvedReview                仅对含评审决定的条目存在
```

`entries` 必须非空且与含 `approvedReview` 的任务集合完全对应。条目 ID 唯一、小于原批次 nextId；项目、批次和编码后的任务 key 必须对应。主机继续逐项比较原话、类别、原始截图和参考图引用，并要求 assets 恰好等于全部原始图片引用集合。

### entry 字段

| 字段 | 约束与含义 |
| --- | --- |
| `approvalId` | 小写规范 UUID 文本，保留确认事件关联 |
| `basisSourceHash` / `appliesToSourceHash` / `contextHash` | 小写 64 位 SHA-256 文本；本阶段只验证类型/格式，尚未验证来源内容与允许的 H0→H1 转换 |
| `sourceItemRevision` | 原条目版本 hash 或 null；新草稿可尚无已同步版本，不能拿批次 cursor 代替 |
| `state` | 必须等于 spec.state |
| `spec` | 下表规格，与 task.approvedReview 类型敏感地完全一致 |
| `contextSnapshot` / `basisSnapshot` / `sourceTransform` / `decision` | 可选审计对象，每个序列化后最多 32 KiB；本阶段只作有限 JSON 数据保存，不能作为已验证授权 |

### spec 字段

| 字段 | 约束 |
| --- | --- |
| `schemaVersion` | 整数 1，拒绝 true、1.0 等替代 |
| `state` | `approved` / `needs_confirmation` / `needs_reconfirmation` / `withdrawn` |
| `decisionId` | 小写规范 UUID 文本 |
| `problem` | 最多 2000 字符；approved 时非空 |
| `requestedChange` | 最多 3000 字符；approved 时非空 |
| `acceptanceCriteria` | 最多 8 个非空字符串，每项最多 600 字符；approved 时至少一项 |
| `needsConfirmation` | 最多 8 个非空字符串，每项最多 600 字符；approved 时必须为空数组 |
| `evidenceRefs` | 最多 20 个唯一安全图片路径，必须已在原条目 shot/refs 中引用；可为空，不强迫伪造图片 |
| `evidenceHashes` | 键集合恰好等于 evidenceRefs，各值与实际图片字节的 SHA-256 相等 |
| `contextHash` | 与 entry.contextHash 相等；本阶段不是对上下文真实性的证明 |

`approvedSnapshot`、entry 与 spec 的顶层拒绝表外字段；可选审计对象内部暂作不可信数据保存。`spec` 只存用户采纳后需要影响开发工作的稳定内容；运行中候选、延迟、费用、模型日志、拒绝次数等不放入 task，不参与 item revision。候选和 UI 草稿的独立存储在后续阶段实现。

验证用合成 payload 见 `tests/review-contract.test.py` 和 `tests/review-store.test.py`。它们用于测试保存与保护，不是可执行的用户批准样例。

## 执行、版本与撤回

含 `approvedReview` 的当前条目派生以下只读字段：

```json
{"reviewGate":{"code":"SOURCE_VALIDATION_PENDING","executable":false}}
```

原始 `state` 保持原值。即便声称 `approved`，当前阶段也只允许审阅及登记“待确认”或“处理中”；`result` 拒绝“待验收”和“无需修改”。允许记录待确认不等于执行权限。该检查位于 ProjectStore 内部，CLI 确认参数、直接调用 store 或正确 Git 提交都不能解除它。读取时保留当前版本的待确认结果，不将它误标为历史结果。

`approvedReview` 随 task 自然参与现有 `item_revisions()`；不替换旧算法。未改变的普通条目在混合 v2 批次中仍保持原版本。`cursor` 仍是批次快照，结果回写只使用 `items[].revision`。

同步在现有项目锁内检查批次不可变历史。曾经带评审的编号仍存活或删除后被重建时，不能删掉评审语义或降回 v1；撤回应以新的 withdrawn 决定保留追溯。正常删除整个条目允许，但不是复用编号绕过历史的手段。当前 withdrawn 也保持执行限制，待来源验证与撤回规则完成后再开放后续行为。

为保证删除后重建也受保护，本阶段在同步、读取当前任务和登记结果时逐个读取历史快照任务元数据，并验证涉及评审的历史快照；旧主机将 HEAD 回退到旧 v1 后，新主机也会拒绝该降级。I/O 随该批次历史增长；大型历史的索引优化需另加一致性与恢复测试。保护依赖保留的不可变 revisions，不能将其当作对任意磁盘删除或旧主机自身行为的防护。已经保存但未成功更新 HEAD 的不可变评审快照也采取保守保护，不能靠重试降级。

磁盘读取时重新检查评审契约和实际图片 hash；仅重新计算快照 checksum 不能使格式错误的评审合法。旧 v1 快照不重写、不迁移。具体 H0/H1 来源校验、草稿竞态、批准事件真实性与浏览器编辑后的重新确认仍由下一阶段实现。

## 错误与恢复

| 错误码 | 消费方动作 |
| --- | --- |
| `TASK_CONTRACT_ACK_REQUIRED` | 阅读新契约后显式确认格式，再逐项检查 reviewGate |
| `INVALID_REVIEW_CONTRACT` | 保留原数据，修正结构或证据不一致；不能靠删字段降级 |
| `TASK_CONTRACT_DOWNGRADE` | 保留评审决定；撤回需保留 tombstone 语义，不复用旧结果 |
| `TASK_CONTRACT_UNSUPPORTED_FOR_SEND` | 暂用项目同步与显式审阅，不经旧直送通道执行 |
| `REVIEW_SOURCE_VALIDATION_PENDING` | 保存待确认结果，等待来源校验与批准流程完成 |
| `STALE_ITEM_REVISION` | 重新读取当前条目；不能把旧建议或结果覆盖新反馈 |

原有图片、路径、磁盘完整性和 Git 验收错误仍保留各自代码。格式不受支持或数据错误时整个同步失败，不能部分采纳后静默丢条目。
