# 实验性评审任务契约

本页描述 V1.5 阶段 A 的实际代码边界。原始 `annotations.json` 继续使用 `schemaVersion: 1`；当前浏览器和 ZIP 生成器继续输出原 v1 任务。v2 是新增的项目同步格式，尚未开放评审任务开发执行。

## B1 原始来源摘要（仅纯函数，未启用）

`review-source.js` 与 `review_source.py` 新增 `sourceRecord / sourceJSON / sourceHash` 与 `source_record / source_json / source_hash`。两端输入为**单条原始批注和实际图片字节计算所得的哈希表**，不读取用户数据或调用模型；返回 UTF-8 紧凑 JSON 与 SHA-256。独立合成黄金向量位于 `tests/fixtures/review-source-v1.json`，覆盖图片、非 ASCII 文件名及无图片情况。其字段顺序固定为 `schemaVersion, id, text, category, observed, expected, reproduction, shot, refs, images`；images 按路径 UTF-8 字节升序排序，每项按 `path, sha256` 顺序存储。未填 text 映射空字符串，未填分类/文本细项映射 null，未填 refs 映射空列表；其他非来源运行字段不进入摘要。

来源不变量：编号为正安全整数；类别仅五类或 null；原话和细项不做 trim 或语义改写；截图必须位于 shots/，参考图位于 refs/；路径拒绝穿越、控制字符和非法扩展；哈希表键与唯一原始引用完全一致，值为 64 位小写 SHA-256。该算法**并非原有 item revision**，不得替换 `project_store.item_revisions`，不得改变历史 v1 hash。没有图片的草稿允许计算，不能因此假定有截图。

B1 首先提供独立来源纯函数；B2 已将 `appliesToSourceHash` 强制绑定当前原始批注和实际图片字节，但**尚未校验 `basisSourceHash` 所指向的 H0 历史、H0→H1 转换或用户批准事件**。它没有把 URL、元素、视口、绘图、构建版本等上下文纳入 sourceHash；此类内容必须另外定义和校验 contextHash。仅相等的摘要既不是用户确认事件，也不是 H0→H1 授权转换；可信批准事件、类别采纳、附加证据及历史撤回仍须后续实现。阶段 A 的 `SOURCE_VALIDATION_PENDING`、当前 v2 禁止执行以及 `send` 禁用保持不变。

## B2 当前来源 H1 校验（仍不可执行）

Native `project-sync` 与历史快照读取现调用 B1 Python 来源规范化函数，对含 `approvedReview` 的每条批注使用原始 `annotations[]` 字段及**解码或磁盘重新读取的实际图片字节 SHA-256**计算 H1，并强制匹配 `approvedSnapshot.entries[id].appliesToSourceHash`。即使任务本身的原话、类别与被篡改的批注同步变化，H1 不一致仍拒绝完整同步或读取。旧 v1 代码路径不调用此函数，不改变历史 v1 的 snapshot 或 item revision hash。

仅绑定**当前来源内容**，并不证明 H0 的真实性、允许的类别采纳/新增证据、上下文与用户确认事件；`basisSourceHash` 仍未验证。 `sourceBindingValidation: false` 和 `reviewExecution: false` 不变，所有含评审条目继续 `SOURCE_VALIDATION_PENDING`，不能登记“待验收”“无需修改”，旧 v2 send 继续拒绝。验证采用虚构原话、合成图片以及失败后 HEAD 不变的回归；真实浏览器审批链路后续独立验证。

## B3a H0→H1 合法字段转换（仅纯函数）

新增 `review-transition.js` 与 `review_transition.py`，复用 B1 来源规范化和 SHA-256，不改变 v1 历史 hash、原始任务或 Native 读写。输入是 H0/H1 两份原始批注、各自**由调用方基于实际图片字节**计算的 hash map，以及严格的声明式 `sourceTransform` 对象：`{"schemaVersion":1,"adoptedCategory":null,"addedEvidence":[]}`。类别确有改变时，adoptedCategory 必须精确等于 H1 的五类之一；未改变时须为 null。addedEvidence 按新增截图（仅 H0 没有截图时）和新参考图的附加顺序列出 `{path,sha256}`。不允许删除/替换已有图片或更改原图片字节、重新排序旧参考图，也不允许修改原编号、原话、实际、预期、复现字段。拒绝未知键、非整数 schemaVersion 和未声明追加。返回 H0/H1 独立来源 hash，供未来绑定可信历史使用。

固定跨语言合成向量见 `tests/fixtures/review-transition-v1.json`，包含无操作、类别采纳、Unicode 参考图追加和首次添加截图。**本轮尚未连接 Native 的 approvedSnapshot 验证；basisSnapshot、sourceTransform、decision 仍是未信任审计资料。** 新函数不验证 H0 历史来源、用户确认手势、上下文或撤回事件，因此无执行授权意义；`SOURCE_VALIDATION_PENDING`、v2 send 拒绝和用户验收流程均不变。

## B3b 历史 H0 绑定（来源可信性，不是批准事件）

当 v2 entry 明确包含 `sourceTransform` 时，项目存储在同一项目锁下将 `sourceItemRevision` 与当前项目、当前批次的不可变历史中某一条目精确匹配。仅接受该历史条目尚未附加 `approvedReview` 的 H0，不允许把批次游标、编造的 H0 或已评审的旧结果当作新确认依据。加载历史数据时重新验证快照校验和、item revision、原图片实际字节；由历史 H0 和当前 H1 运行 B3a `validate_transition`，强制两端 hash 分别匹配 entry 的 `basisSourceHash` / `appliesToSourceHash`。该检查在项目同步写入快照之前及后续快照读取时运行；H0 不存在、损坏或被撤走时保守拒绝，而不静默回退。

未附 `sourceTransform` 的旧 v2 仍可被安全地存储和审阅，但**没有历史来源证明**。用户提交的 `basisSnapshot` 仅是未信任审计资料，不替代经验证的本地历史。首次批准前须有可引用的基线 item revision；已评审 H0 的重新确认不在本轮开放范围。新增错误 `REVIEW_BASIS_NOT_FOUND` 与 `INVALID_REVIEW_BASIS` 都不能绕过，需重新读取、定位有效的未评审历史并获得真实用户确认。

**能力与执行门禁均未升级**：匹配历史 H0 仅说明提交的变更在结构上可追溯，不代表真实用户点击采纳，也未校验 contextHash、撤回/重放或浏览器事件来源。仍然 `sourceBindingValidation:false`、`reviewExecution:false`，所有含评审条目继续 `SOURCE_VALIDATION_PENDING` / `executable:false`，v2 send 禁用。

## B3c-1 决定 ID 与精确版本绑定（非用户授权）

对包含 `approvedReview` 的 v2 历史，存储层检查每个 `approvalId`、`spec.decisionId` 与 **同项目同批次的条目 ID、精确 item revision、完整 entry 内容摘要**唯一对应。在 `sync` 更新 HEAD 之前检查，并在 `read/result` 时重复校验；同一决定的幂等同步及不改变该条目版本的其他批注变化允许。若想改变规格、来源、上下文或撤回 / 重新确认，必须使用新的决定标识；复用旧标识返回 `REVIEW_DECISION_REPLAY`。历史 v1 哈希与旧快照不会迁移。

这里只阻止同一 ID 指向不同决定或条目版本；不能根据任意 UUID 或结构自证用户点击，也不能仅靠无序的不可变历史判断哪一个审批是最新生效状态。老主机将 HEAD 回拨至字节一致的旧决定、跨设备磁盘历史被删除、事件来源真实性等仍需后续 B3c/B3d 解决。**所有含评审条目仍 `SOURCE_VALIDATION_PENDING`、不可执行完成**；v2 直送继续禁用。

## B3c-2 可选的上下文快照一致性校验（2026-11-07）

对明确使用 `contextSnapshot.kind = "annotation-context-v1"` 的 v2 审计记录，Native 在同步和历史快照读取时，从同一条原始批注重新投影 `schemaVersion,kind,id,url,pageKey,title,mode,elements,rect,shapes,viewport,build`，并以 `json.dumps(ensure_ascii=False,allow_nan=False,sort_keys=True,separators=(",",":"))` 的 UTF-8 字节计算 SHA-256，匹配 `entry.contextHash` 与 `spec.contextHash`。任一页面元数据、元素线索或几何字段变化而未重新绑定时，拒绝整个 v2 快照；经校验的值来自当前批注，不信任单独提交的 contextSnapshot 文本。旧的无 kind 审计对象按既有协议保留但仍**完全不具备批准效力**，不能因为存在任意 contextHash 而开放执行。

这只是**本地数据一致性**：没有验证网页本身真实性、用户点击、浏览器权限或截图传输授权；完整 URL 及元素线索可能含敏感信息，严格只留在本机，不进入公开仓库或默认外发。v1 数据和黄金 hash 不改，所有含评审条目仍 `SOURCE_VALIDATION_PENDING` / `executable:false`，v2 send 禁用。未来编辑器必须按同一规范计算并在用户明确采纳后建立可信事件链，才能讨论执行权限。

### B3c-3a 历史决定重放防护（2026-11-08）

针对当前批次 HEAD 仍可正常读取、但某个评审决定已被更晚决定替换、撤回或删除的情况，`project_store.py` 在原有项目锁内比较候选决定的 `(原编号, item revision, 完整 entry 摘要)`、当前 HEAD 和校验过的不可变历史。如果候选是**历史上曾生效但当前不再生效的原决定**，即使字节完全一致且原 UUID 没有变更复用，也返回 `REVIEW_DECISION_REWIND`，拒绝更新 HEAD；当前决定的幂等同步和使用新 UUID 的新决定继续允许。同步时原先的图片、来源、版本、决定 ID 校验均保留。

此保护不能识别旧主机**直接篡改 HEAD 指针**回退到字节一致的旧决定；要关闭此边界需额外独立、单调且可恢复的可信事件序列。新检查不是用户采纳真实性证明，不提高 `sourceBindingValidation`，不解除 `SOURCE_VALIDATION_PENDING` 或完成性结果限制，不开放 v2 send。回归仅用虚构批注和合成图片，真实用户手势/Chrome/Native 全链路待验收。

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
| `REVIEW_DECISION_REWIND` | 已被撤回或替换的旧决定不可再次同步；生成新的用户决定，不复用历史批准 ID |
| `TASK_CONTRACT_DOWNGRADE` | 保留评审决定；撤回需保留 tombstone 语义，不复用旧结果 |
| `TASK_CONTRACT_UNSUPPORTED_FOR_SEND` | 暂用项目同步与显式审阅，不经旧直送通道执行 |
| `REVIEW_SOURCE_VALIDATION_PENDING` | 保存待确认结果，等待来源校验与批准流程完成 |
| `STALE_ITEM_REVISION` | 重新读取当前条目；不能把旧建议或结果覆盖新反馈 |

原有图片、路径、磁盘完整性和 Git 验收错误仍保留各自代码。格式不受支持或数据错误时整个同步失败，不能部分采纳后静默丢条目。
