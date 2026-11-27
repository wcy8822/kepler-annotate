# 实验性评审任务契约

## D1b-3b 独立单次合成执行器（2026-11-24）

新增仅供隔离测试使用的本地命令 `python3 native-host.py --synthetic-review-worker-once`。必须使用现有显式布尔测试配置 `enableSyntheticReviewFixture: true`；默认安装拒绝，不新增浏览器可调用操作或能力声明。执行器复用 Native 请求状态文件与专用锁，在独立短进程中清理过期记录、按创建时间与请求 ID 选择一个仍 queued 的请求，并原子完成固定合成结果；已取消、已完成、已过期请求均不领取。两个执行器并发时各自最多完成一个不同请求，空队列返回 processed:false。浏览器 status 不负责执行任务；实际模型的长任务、租约、故障重试、真实数据授权及编辑器 Native 接线尚未实现。

新增 Python 跨进程回归，覆盖并发、默认拒绝、Native 消息不可调用、取消及过期。仅使用虚构数据，无真实模型、网络、截图外发、常驻进程或用户批准；v1 原数据、历史 hash、精确 item revision、SOURCE_VALIDATION_PENDING、executable:false 与 v2 send 禁用不变。独立选择/取消/过期/并发烟测通过；完整仓库测试与公共扫描以本次精确提交的 CI 为准，真实设备待验收。Draft，不合并或发布。

## D1b-3a 生产安装默认关闭合成 Native 建议接口（2026-11-23）

D1b-2 已实现合成请求的显式完成，但四个测试端点此前在普通安装主机中也能调用。本轮将 `review-preview-request/status/cancel/fixture-complete` 统一置于主机显式布尔开关 `enableSyntheticReviewFixture: true` 之后。未设置、`false` 或字符串 `"true"` 均拒绝 `REVIEW_PROVIDER_NOT_CONFIGURED`，即使历史合成任务存在也不读取或修改其状态。正式安装器不暴露该开关；`info.capabilities.reviewPreviewLifecycle` 默认报告 `disabled`，隔离测试主机才报告 `synthetic_fixture_only`。新增 Native 和便携安装回归。

首轮精确提交 `ebcf09e` 的 CI 揭示旧版 Native 安装器联调测试仍将已安装主机的 capability 预期写成 `synthetic_fixture_only`；运行行为实际正确报告 `disabled`。本轮仅修正该隔离测试的安装预期，保留已安装主机默认关闭；以最终修复 SHA 的 CI 结果为准。

此改动隔离测试能力，不是独立模型 worker、真实建议、云端请求或编辑器 Native 接线。原始 v1 批注/编号/五类分类/截图/历史哈希、精确条目版本及本地建议不变。`SOURCE_VALIDATION_PENDING`、`executable:false` 与 v2 直送禁用仍生效。真实 Chrome/Native 设备验收仍待完成；PR 保持 Draft，不合并/发布。

## D1b-2 合成 Native 状态查询与执行状态拆分（2026-11-22）

修复 D1b-1 中 `review-preview-status` 读取即将 queued 变 completed 的语义问题：轮询现在严格只读，只有显式合成测试操作 `review-preview-fixture-complete` 能在原有锁内将同来源、同 requestId 的 queued 请求变为 completed；必须提供 `synthetic:true`、`provider:synthetic-fixture` 和原始 `sourceHash`。取消与完成竞争时仅先取得锁的操作生效，已取消不可补发合成结果，重复完成幂等且 `completed:false`。新增跨 Host 重启、重复轮询、取消与完成竞态、伪造来源拒绝等隔离回归。读取状态不再伪装模型完成，仍无后台 worker、真实 Provider、网络请求或收费模型。原始数据、v1 哈希、评审批准与 `SOURCE_VALIDATION_PENDING` / `executable:false`、v2 send 门禁不变。真实用户设备 Chrome / Native 验收仍待执行；PR 继续 Draft。

## D1b-1 Native 合成建议 request/status/cancel 协议（2026-11-21）

新增三个严格限定为合成测试的 Native Messaging 操作：`review-preview-request`、`review-preview-status` 和 `review-preview-cancel`。仅允许显式 `provider: synthetic-fixture`、`synthetic: true`、规范小写 UUID 和当前 H1 `sourceHash`；拒绝原文、URL、截图、凭据等额外输入字段。首次请求产生 queued 状态，第一次 status 在合成模式下产生标记为合成的只读结果；取消 queued 后不会再生成结果，完成后取消不会冒充成功。相同 ID/来源幂等，不同来源复用 ID 拒绝。状态跨 `sendNativeMessage` 短进程保存于本机 dataRoot，经专用锁、私有文件和原子更新保护，最多 128 条、1 小时过期；仅持久化 requestId、sourceHash、state、时间，不保存原始文字或建议正文。

这是**Native 协议和生命周期的隔离测试桩**，而不是模型服务、后台队列、生产 worker 或用户可用的新建议按钮。状态查询在模拟模式里触发完成仅为验证 request/status/cancel 的竞争与恢复路径，不得套用为真实模型完成机制；真实 Provider 仍需独立进程/任务执行、明确端点和费用控制、具体请求授权、可靠重启恢复及 UI 接线。当前唯一实际编辑器建议仍为本地模板，不发送外网/付费模型/截图，不建立人工批准，不修改 v1 数据，v2 仍 `SOURCE_VALIDATION_PENDING` / `executable:false`，send 禁用。真实 Chrome/Native 实机待验收，PR 保持 Draft，不合并、不发布。

本页描述 V1.5 阶段 A 的实际代码边界。原始 `annotations.json` 继续使用 `schemaVersion: 1`；当前浏览器和 ZIP 生成器继续输出原 v1 任务。v2 是新增的项目同步格式，尚未开放评审任务开发执行。

## D1b-0 只读建议请求取消（2026-11-20）

原编辑器 `review-local-preview` 携带一次性随机 UUID `requestId`。扩展后台使用 Chrome 的 tab/document 发送方信息绑定 AbortController，`review-local-preview-cancel` 只取消相同发送方和请求 ID 的活动预览，不信任请求正文传入的身份字段；同一文档新请求撤销旧请求。取消或关闭原编辑器时 UI 世代号使迟到结果无效，Provider 的 signal 接受真实中断。取消不建立任何 `approvedSnapshot`、Native 任务或人工决定事件，不撤销已保存的用户决定。

当前仅本地模板，没有真正 Native 任务，也不等同可信用户批准。五类分类、v1 原话/原编号、原图片、历史 hash、精确 item revision、`SOURCE_VALIDATION_PENDING` / `executable:false` 和 v2 send 门禁不变。

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

### B3c-3b 独立 HEAD 检查点（2026-11-09）

当一个批次首次成功同步 v2 评审快照时，项目存储在原有项目锁中建立本地 `review-head-checkpoint.json`，记录项目、批次与本次 HEAD 快照 SHA-256。之后该批次即使删除全部评审条目、当前回到纯 v1，也持续更新检查点。同步、读取当前快照、结果回写及批次列表会核验检查点与 HEAD 一致；**旧主机只改 HEAD 指向字节完全一致的历史决定**，会返回 `REVIEW_HEAD_ROLLBACK`，不得靠重新同步旧决定自动恢复。历史快照的显式 cursor 读取仍采用既有内容校验，不重写 v1 黄金 hash 或 item revision。

为保证旧结果不会在双文件写入中被意外恢复，先原子写检查点再写 HEAD；两个文件无法作为单一事务提交，若中途崩溃或磁盘损坏导致不一致，**故意失败关闭**，需要人工根据不可变历史核查并恢复检查点所指 HEAD，不进行自动修复。检查点只防护创建之后旧主机单独改写 HEAD；首次升级前的回拨、用户或恶意进程同时篡改/删除两文件、跨设备复制及真正可信的用户操作顺序并未解决。检查点是本地一致性防护，**不是加密签名或用户采纳证明**。

所有评审仍保持 `SOURCE_VALIDATION_PENDING`、`executable:false`，禁止完成性结果和 v2 send；实际 Chrome/Native Messaging 及人工恢复需单独验收。

### B3d-0 编辑器用户动作入口保护（2026-11-12）

原编辑器根部的按钮分派拒绝 `event.isTrusted === false` 的合成 click，避免页面脚本通过开放的 Shadow DOM 直接调用保存、删除及类别采纳动作；编辑器 `submit` 仅阻止默认提交，不再调用 `saveDraft`，因此 `form.requestSubmit()` 或合成 submit 不能绕过显式保存按钮。合成 Chromium 用例覆盖这些路径。

**这不是用户批准身份或来源的密码学证明**：浏览器自动化、扩展内部代码及用户设备上具有相应权限的程序仍可能发起被浏览器标记为 trusted 的操作，数据存储接口也不是隔离的签名服务。该改动只收紧 UI 动作入口，既不创建可信批准事件，也不开放 `SOURCE_VALIDATION_PENDING` / `executable:false` 或 v2 send。完整 B3d 仍须在受控的扩展上下文中形成可追溯的批准/拒绝/撤回事件，绑定 H0/H1、图片、上下文和精确版本。

### B3d-1e 浏览器本地决定的 Native 版本见证（2026-11-16）

为已有的独立浏览器决定记录新增可空的 `nativeBatchRevision` / `nativeItemRevision`，只在上一次成功的当前批次 Native 同步回执附有浏览器批次 SHA-256，且记录决定时**只读** Native `project-read` 返回同一项目、批次、目录、HEAD 与完整合法的 item revision 集合时填充。旧事件保持原样，不追认；未安装、离线、回执旧格式、HEAD 不同或批次已编辑时为 null，不能把旧批次 cursor 当作条目 revision。此记录保持在 `kp-annotate-review-decisions-v1` 本地键，不添加到 v1 数据/ZIP、Native v2 `approvedSnapshot` 或开发任务。

本地同步回执不能单独认证用户操作；即使现场校验了 Native item revision，也**只说明关联了该时刻的项目条目版本**，不能证明用户批准、来源合法转换或事件不可篡改。`sourceBindingValidation:false`、`reviewExecution:false`、`SOURCE_VALIDATION_PENDING`、`executable:false` 与 v2 send 禁用保持不变。

### B3d-1f Native 版本见证的读取时状态（2026-11-17）

浏览器本地 `review-decision-status` 在最新事件具有历史 `nativeBatchRevision` / `nativeItemRevision` 且原来源仍一致时，重新用只读 `project-read` 对照当前 Native 批次和条目版本；仅完全一致返回 `nativeWitness: "current"`，否则返回 `"unverified"`。从未记录版本的事件或空历史返回 `"unlinked"`。写入本机决定时返回当次是否关联的相同只读状态，字段只用于界面提示，不回写任何审计事件、不写入 v1/ZIP、v2 `approvedSnapshot`，不表示用户授权。版本过期仍由独立 `stale` 字段优先报告。

这是**可撤销的当前读时状态**而非永久认证：Native 离线和 HEAD 改动都会令当前状态无法验证；不信任历史中自称的批准，保留 `SOURCE_VALIDATION_PENDING` / `executable:false` 与 v2 send 禁用。

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

## B3d-1c 本机事件绑定 H1 与实际图片（2026-11-15）

原编辑器本地决定事件在后台读取当前已保存截图/参考图（IndexedDB 的 data URL），**解码实际图片字节**后逐项计算 SHA-256，并通过已有 `review-source.js` 生成与 Python `review_source.py` 同口径的 `sourceHash`。新增本地事件字段 `sourceHash` 和 `evidenceHashes`，保留原有 `sourceSnapshotHash`、前序 ID、建议原文、v1 批注。读取时重新哈希，即使路径、原话 JSON 未变化，图片字节不同也会判为过期；缺失或格式错误的图片保守拒绝新决定。旧本机记录没有新增字段时保留历史但标记过期，需显式重新确认，不自动补签。

这只是**本机来源完整性**检查，不是人机身份认证、签名或 Native `approvedSnapshot` 授权。尚未绑定 Native 精确 item revision、H0→H1 合法转换和用户批准事件来源。所有含评审任务继续 `SOURCE_VALIDATION_PENDING`、`executable:false`，v2 send 保持禁用。图片字节与本机事件记录不自动外发；合成 Chromium 验证篡改/恢复，真实设备和 Native Messaging 待验收。

## B3d-1d 本机决定的 H1 乐观并发校验（2026-11-15）

原编辑器读取本地决定状态时同时取得后台对当前原始批注与实际截图/参考图字节计算的规范化 `sourceHash`。保存人工决定时必须回传 `expectedSourceHash`，后台在串行操作中重新计算；来源在查看与决定之间变化则返回 `KP_REVIEW_SOURCE_CONFLICT` 且**不写入任何事件**。即使图片路径及原始批注 JSON 未变，仅图片实际字节被替换，也不能凭旧查看结果绑定新来源。没有此回执的写入拒绝，老历史保留且按既有过期规则读取。

这是本地来源版本竞态防护，不代表用户身份认证或正式批准，也**不**连接 Native 的 H0→H1 可信批准事件。所有含 v2 评审的任务仍然 `SOURCE_VALIDATION_PENDING` / `executable:false`，v2 send 保持禁用。

## B3d-1b 编辑器本机决定草稿（非权威审计）

已保存的 v1 批注可以在原编辑器单独填写建议草稿，并进行 adopt / reject / reconfirm / withdraw 显式操作。扩展后台在自己的串行队列内核查原批次快照、项目/批次/编号、上一决定 ID 和当前原批注 JSON 的 SHA-256，存入单独 Chrome local storage；不会写回 v1 原话、批次、AI 任务或 Native v2 approvedSnapshot。来源变化会令本地历史显示“过期”，而非自动通过。建议历史保存的是用户输入的草稿正文与操作，不是模型推断结果。

这只是用户界面操作记录与内容版本提示，**不是签名、可信人机身份认证、H0→H1 合法转换证明，亦不代表 B3d 可信批准事件链完成**。扩展上下文与用户设备上的代码仍可能影响这些记录；当前仅供本机审阅，不输出可执行规格。所有含评审条目继续 SOURCE_VALIDATION_PENDING、executable:false，v2 send 禁用。

## B3d-1a 版本化决定审计与前序检查（不是可信批准）

可选 `decision.kind = "review-decision-v1"` 的字段严格限定为 `kind, schemaVersion, action, approvalId, decisionId, sourceItemRevision, basisSourceHash, appliesToSourceHash, contextHash, specHash, previousDecisionId`。整数 schemaVersion 必须是 1，`adopt/reconfirm` 对应 approved，`reject/withdraw` 对应 withdrawn。首次 adopt/reject 无前序决定，reconfirm/withdraw 必须引用前序决定 UUID。`specHash` 是键排序、无多余空格、保留 Unicode 的完整规格 JSON UTF-8 SHA-256。

结构检查要求声明准确绑定 H0 item revision、H0/H1 来源 hash、`sourceTransform`、`annotation-context-v1` 和规格。在原有项目锁内，后续新版本化决定必须指向当前 HEAD 的前一决定，当前相同决定可幂等同步，已有版本化审计不允许静默降回旧版 opaque 审计。没有 kind 的旧审计仍是无权限声明。

**边界：** 此格式是由调用方提交的审计声明，不是用户真实点击的可验证证据，也不提供签名。浏览器可信事件来源及撤回操作链尚未实现。所有含评审任务继续 `SOURCE_VALIDATION_PENDING` / `executable:false`，v2 send 不开放；不自动调用模型或外发用户数据。


## C2 / D0 只读本地建议预览（2026-11-18）

`review-local-preview` 只对当前已保存批注进行来源只读检查：核对批次快照、由实际截图/参考图 SHA-256 构成的规范化 H1 `sourceHash` 和编辑器读取时的 `expectedSourceHash`。然后由 `review-suggestion.js` 的 `local-template` provider 返回 `{schemaVersion:1,origin:"local-template",readOnly:true,proposal,needsConfirmation,sourceHash}`。这不是 `approvedSnapshot`、`approvedReview` 或 `review-decision-v1`，不会写入任何决定历史或 Native 任务。原始图片只参与本地 H1 校验，不进入草稿正文；不调用模型、Native 或远端网络。

用户明确点击后，仅在草稿框为空且原批注无未保存修改时，将模板放入可编辑草稿。缺失预期只能保留待确认，不能臆造具体产品要求或验收结论；人工文字和过期异步响应不得被模板覆盖。未来真正模型 provider、授权数据范围、端点、费用、请求取消和截图传输必须单独设计与批准。所有含评审任务仍为 `SOURCE_VALIDATION_PENDING` / `executable:false`，v2 send 禁用。

## D1a 只读建议 Provider 运行契约（2026-11-19）

扩展后台使用 `review-provider.js` 校验 provider 输入/输出。输入仅限已保存批注的四个文本字段 `text/observed/expected/reproduction`，逐项不超过 4000 字符；`sourceHash` 必须为经过本地实际图片校验的 H1 SHA-256，但不作为 provider 能够修改的字段。响应必须**恰好**含 `schemaVersion:1, origin, readOnly:true, proposal, needsConfirmation`，其中来源须等于适配器 ID，建议正文 1–3000 字，未知字段与工具调用字段一律拒绝。后台附加只读 `sourceHash` 并在返回前重新校验实际图片和批次快照。现有 UI 继续只使用 `local-template`；通过测试注入的 provider 不是已获授权的真实模型。

可替换的本机异步调用包装支持取消和超时，超时/取消均失败关闭且不写入批注、建议历史或任务；不承诺无法取消的第三方底层计算已停止，只保证拒绝迟到结果。该模块没有网络请求、凭据、常驻 Agent 或 Native review 实现。新增单元测试覆盖输入最小化、伪造能力、超时、取消、迟到回复及错误；合成浏览器旧流程由现有 Playwright 测试覆盖。完整模型发送权限和截图预览同意仍是独立的后续阶段，`SOURCE_VALIDATION_PENDING` / `executable:false`、v2 send 禁用不变。


## D1b-3c 合成 Native 客户端边界（2026-11-25）

`createNativeFixtureAdapter(send, {enabled:true})` 仅为显式隔离测试构造，不是模型配置或用户批准，不在生产入口注册。它要求 `info.capabilities.reviewPreviewLifecycle === "synthetic_fixture_only"`，发送的请求仅含 op/requestId/provider/synthetic/sourceHash，状态响应须绑定同一 requestId，完成候选须匹配 H1 且通过既有只读输出验证、needsConfirmation 必须为 true。异常、取消和超时不产生建议决定，尽力发送 cancel；请求仍在提交时，取消清理延后至提交响应返回。不可据此承诺主机已经停止。编辑器仍仅接受 local-template，不得把合成结果包装成真实模型建议。不改变 v1、执行门禁、真实数据传输权限或用户批准。


## C2 / D1 编辑器预览与人工编辑冲突（2026-11-26）

原编辑器等待只读建议时，用户可信输入或参考图/分类操作取消当前请求并推进 UI 世代号，清空或撤回输入不会复活旧请求。填入候选之前再次核对原批注无未保存改动、当前批次快照与预期 H1、响应 sourceHash 及建议框为空；任何变化均保留人工草稿并拒绝旧结果。此规则只保护预览交互，不改变 v1、人工决定历史或执行授权，生产仍只使用本地模板，不调用 Native 模型或发送截图。


## D1c-1 本地模型配置与发送前预检（2026-11-27）

新增 Native `review-model-info` / `review-model-prepare`：仅从本机配置 `reviewModel` 读取严格限定的 `kind: openai-compatible-local`、`endpoint`、`model`、`timeoutMs`、`maxOutputTokens`；仅允许 IPv4 回环字面量 `http://127.0.0.1:PORT/v1/chat/completions`（PORT 1–65535），不接受域名、远端、查询参数或凭据。超时 1000–60000 毫秒，输出上限 1–2048 tokens。未配置返回 disabled；有效配置返回 configured_unverified，**不代表模型已运行或可达**。现有 info、项目同步和合成能力不变。

预检仅接受四个文本字段及调用方给出的 H1 格式摘要，生成可供后续明确确认的 OpenAI-compatible JSON 请求正文（不包含 tools），以 SHA-256 绑定目的地、超时、正文和 sourceHash。拒绝未知字段、超长与非法编码；不读取图片、URL、DOM 或凭据，不发 HTTP、不写状态、不启动模型。摘要仅为发送前内容绑定，不证明 H1 真实来源或用户批准；networkEnabled 始终 false。未来实际发送须由独立可信用户确认与来源复核控制，并禁止代理/重定向，不能将本回执当作批准。原编辑器尚未接线，仍使用 local-template；v1、精确 revision、SOURCE_VALIDATION_PENDING、executable:false 和 v2 send 禁用均不变。

验证：隔离预检函数五组烟测通过；新增 Native Host 回归覆盖默认关闭、配置与内容变化、未知字段、无落盘/无 Codex 调用。完整仓库 CI 及真实设备、模型可达性和授权发送尚待验证。未合并、发布或安装。
