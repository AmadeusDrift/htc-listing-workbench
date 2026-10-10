# 固定回归场景与现有测试证据

对应 [STABILITY_PLAN.md](STABILITY_PLAN.md) 的 35 项场景。静态核对基线：`a855e4e`，分支 `test/stability-baseline`，日期 2026-10-10。下表核对了测试名称、夹具及相关断言；覆盖判定不等于运行通过。

本次运行结果由主任务提供：Node `24.21.0`、npm `11.19.0`；`npm run typecheck` 退出码 0；`node --test --test-concurrency=4 --test-timeout=180000 --test-reporter=tap tests/*.test.ts` 退出码 0，1576 tests、1575 pass、0 fail、0 cancelled、1 skipped，耗时 105816 ms。原始输出：`artifacts/stability-baseline-2026-10-10/full-suite.tap`。跳过项是 `tests/backup-retention.test.ts` 的 `备份文件被替换成符号链接后保留目标文件`，原因是系统不允许创建文件符号链接，仍需具备该权限的环境补验。详见 [本次维护记录](../maintenance/2026-10-10-稳定化基线.md)。本矩阵编写过程没有另行执行测试；构建、E2E、历史回放及真实服务验收不由本次结果代替。

证据类型：**S** 为合成输入、模拟响应或替身服务；**H** 为仓库内脱敏历史 Schema 夹具；**L** 为真实本地机制（SQLite、文件、子进程或回环 FTP）。没有一行被认定为真实外部服务验收。测试名中的 `live`、`real`、`legacy` 本身不改变分类：例如 `automatic-listing.test.ts` 注入图片、执行和回读替身；`image-workflow-service.test.ts` 使用本地服务、demo Amazon 和模拟 AI/生图；`legacy` 记录通常由当前合成记录删改字段生成。

`直接（离线）` 表示现有断言直接覆盖该条的核心局部契约；`部分` 表示只覆盖子场景或分层边界；`缺口` 表示未找到该故障与恢复组合的专门断言。下表单测运行情况以上述全量结果为准；列出的 E2E 脚本仅完成静态检查，本次未运行。文件路径均相对仓库根目录，反引号内为原测试名。**全量单测无失败不表示 35 项完整验收通过。**

| # | 固定场景 | 现有精确证据 | 类型与覆盖边界 |
|---|---|---|---|
| 1 | 单品字段→七图→托管→提交→回读 | `tests/image-workflow-service.test.ts`：`complete chain adopts seven SKU images without invalidating source/draft revisions and reuses them`；`tests/automatic-listing.test.ts`：`one authorized start connects a missing-image draft through submission and real downstream readiness`；`scripts/e2e-automatic-pipeline.mjs` 的检查 `One native start completes real local FTP upload, URL fill, demo validation/submission/readback and sales-unit procurement binding` | **部分，S+L**。七图、调度和本地 FTP/demo 提交分别有断言；pipeline 使用预先准备的 demo 草稿，未证明真实字段模型、七图、外网托管、正式 Amazon 同链路。 |
| 2 | 多色父子顺序及各自来源图片 | `tests/automatic-listing.test.ts`：`child sales SKUs keep images while waiting for their parent and resume automatically without another generation`；`tests/automatic-image-sources.test.ts`：`new source URLs are downloaded and SKU-bound before drafts, then reused without another download` | **部分，S+L**。父就绪前提交为 0、恢复不增加生图；各变体独立绑定来源图。父子发布顺序与真实多色图片在同一服务组合中尚未闭环。 |
| 3 | 来源链接、来源规格、执行范围三种数量 | `tests/automatic-product-groups.test.ts`：`12 source products retain all 192 variants while only 103 sales SKUs execute` | **直接（离线），S**。断言 12 组、192 来源规格、103 执行项、89 排除项及不改输入；不能据此确认真实导入批次。 |
| 4 | 售价/ROI 边界与业务跳过 | `tests/listing-rules.test.ts`：`all delivery thresholds, fees, divisor, costs and ROI influence pricing; infeasible packages fail clearly`；`tests/automatic-listing.test.ts`：`an infeasible saved price quote blocks before image generation and shows its real constraint`；`tests/automatic-product-groups.test.ts`：`pricing skips and source confirmation remain distinct from workflow failures and submissions are not counted as complete` | **部分，S**。定价不可行时生图/提交均为 0，展示归类区分业务跳过；尚缺每个阈值恰好等于、上下最小精度的穷举及真实报价回放。 |
| 5 | 来源缺失、错误绑定、兄弟 SKU 隔离 | `tests/automatic-image-sources.test.ts`：`unmapped SKU is blocked without borrowing another color, while the mapped SKU can continue`；`source diagnostics distinguish absent links, invalid IDs, download failure and unconfirmed binding` | **直接（离线），S+L**。缺失、无效映射、下载失败和未确认绑定分别断言；下载响应仍为夹具。 |
| 6 | 真实颜色歧义保持暂缓 | `tests/listing-source-color.test.ts`：`uncertain observation is retained and does not trigger another paid attempt or positive evidence` | **部分，S+L**。模拟 UNCERTAIN 后重复调用/重建服务仍拒绝且观察仅一次，不产生正向证据；没有真实歧义照片与真实模型结果回放。 |
| 7 | Schema 固定值原样 | `tests/listing-ai-category-attributes.test.ts`：`model input distinguishes fixed values, closed single-choice options and open text suggestions without changing stored context` | **部分，S**。固定布尔 `false` 保持原值，拒绝 `true`，存储上下文不变；未覆盖所有固定值类型及模型→采用→序列化全链路。 |
| 8 | 严格枚举合法单值与非法候选拒绝 | `tests/listing-ai-category-attributes.test.ts`：`model input distinguishes fixed values, closed single-choice options and open text suggestions without changing stored context`；`tests/listing-ai-rejection-reasons.test.ts`：`partial field repair distinguishes a foreign SKU reference from a schema enum violation` | **部分，S**。区分 single_choice，非法枚举拒绝且原因独立；未以完整服务链证明多候选/多值均不能进入单选字段。 |
| 9 | 开放建议优先真实建议，有依据时用准确值 | `tests/amazon-field-catalog.test.ts`：`anyOf free text plus enum is suggestions while closed enums stay strict`；`tests/listing-ai-category-attributes.test.ts`：`model input distinguishes fixed values, closed single-choice options and open text suggestions without changing stored context` | **部分，S+H**。脱敏杯垫 Schema 的开放建议与严格枚举分开；允许有手动类别依据的 `Manual`。未验证“有合适建议时优先选择”及其相反反例。 |
| 10 | 推断权限、理由、证据一致 | `tests/listing-ai-category-attributes.test.ts`：`limited inferred attributes retain a reason and real citations; native and text booleans normalize identically` | **直接（离线），S**。允许字段保留 infer 理由和引用；缺理由、缺引用、未知引用、非允许字段及夸大声明均拒绝。仍非各类目全部字段的穷举。 |
| 11 | 事实别名语义一致，不能借无关证据 | `tests/listing-ai-context.test.ts`：`source shape aliases and specific SKU pink/orange colors retain their correct meanings`；`confirmed 护理说明 is usable as care evidence`；`tests/listing-ai-validation.test.ts`：`listing candidates allow an evidenced translation but reject cross-field evidence and fabricated translations` | **直接（离线），S**。别名映射及颜色、材质、护理证据正反例有断言；尚需按故障样本补齐未列出的别名。 |
| 12 | 部分候选无效时隔离并保留脱敏原因 | `tests/listing-ai-rejection-reasons.test.ts`：`partial field repair retains specific fixed rejection reasons and keeps other valid fields`；`tests/listing-ai-completion.test.ts`：`automatic repair keeps valid copy when another field has unsupported evidence` | **直接（离线），S+L**。保留合法字段、拒绝非法颜色等字段；固定原因不含测试密钥、原始未知引用或原数值，剩余错误继续可见。 |
| 13 | 单位/成分/危险品资料不足不编造 | `tests/amazon-business-rules.test.ts`：`keychain size uses the selected original size and never invents units from a bare number`；`tests/listing-ai-validation.test.ts`：`fabric composition requires material evidence and cannot invent percentages or mark cloth not applicable`；`tests/listing-ai-completion.test.ts`：`network and unfillable compliance errors never trigger a model call` | **部分，S+H**。裸数字不补单位、成分比例不编造、不可补合规字段不调用模型；危险品各字段及业务默认值组合未全部覆盖。 |
| 14 | 品牌审批与程序错误分类不同，不改品牌规避 | `tests/amazon-transport.test.ts`：`HTTP 200 preview is insufficient unless status is VALID with no ERROR issues`；`tests/amazon-business-rules.test.ts`：`Haul unbranded source labels use Generic without relabeling genuine brands or editing source facts` | **部分，S+H**。QUALIFICATION_REQUIRED 映射 qualification 且阻断提交；真实品牌保留。没有品牌审批错误与程序错误对照、自动修复前后品牌不变的专门场景。 |
| 15 | 仅字段元数据升级不使旧图成为颜色变更 | `tests/image-workflow-service.test.ts`：`field title and description changes reuse completed images and preserve original context hashes`；`a lost paid response reconciles a durable candidate after restart and resumes without a second generation for that slot`；`tests/automatic-listing-recheck-evidence.test.ts` 的两条 metadata recheck proof | **直接（离线），S+L**。真实 `ListingAiService.currentContext` 接入图片服务，仅改变字段标题/说明，已完成图复用、已有候选 UNKNOWN 恢复且不重发生图；无候选 UNKNOWN 仍阻断。推断权限、约束、Schema 等语义规则变化不属于可忽略元数据。见修复增量与 G1。 |
| 16 | 真颜色、来源字节或身份改变拒绝旧结果 | `tests/source-color-ai.test.ts`：`source-color rejects stale revision, spec, variant and image hash before network`；`source-color freshness reads actual bytes without any network and rejects replaced files`；`tests/image-workflow-service.test.ts`：`changed source and cancellation prevent late adoption` | **部分，S+L**。来源身份/hash 和实际文件字节变化均拒绝；图片晚采用的 source 修改用例实际改的是标题，不能代替七图旧快照对颜色/字节/身份的三组反例。 |
| 17 | 外层字段修复在未发送前预校验超时后恢复 | `tests/listing-completion-owners.test.ts`：`automatic: real preview transport failure sends no fields and restart resumes the same operation`；`automatic: quota failure has no send marker and resumes its reserved local ID` | **直接（离线局部组合），S+L**。真实 Amazon/ListingAi/AiService 与 SQLite 经预览 transport 失败后字段 POST=0，重建后沿用 operation/call 身份；逻辑修复次数不重复增加。自动任务检查点与 grant 为合成装载，未覆盖完整 pump/原生确认。见 G2。 |
| 18 | 图片内字段准备在未发送前失败后恢复 | `tests/listing-completion-owners.test.ts` 的 `images: real preview transport failure sends no fields and restart resumes the same operation`、`images: quota failure has no send marker and resumes its reserved local ID` | **直接（离线局部组合），S+L**。真实 ImageWorkflow/ListingAi/AiService/Amazon 组合在 STARTED 后发生预发送失败，重建后同操作继续；下游七图阶段用停止哨兵隔离，不是完整七图验收。 |
| 19 | 字段已发送未知不自动重发 | `tests/listing-completion-owners.test.ts` 双入口 `field fetch entered then lost response stays UNKNOWN across restart`；`tests/listing-completion-boundary.test.ts` 的真实子进程 crash、transport timeout 与双连接并发测试 | **直接（离线），S+L**。beforeSend 的 call/usage/journal 事务实际落库；fetch 进入后超时或进程退出，重建仍不新增 POST；CAS 防止旧协调器覆盖发送事实。外部网络为注入响应。 |
| 20 | 成功已持久化但上层未确认时复用 | `tests/listing-completion-boundary.test.ts`：`resume after persisted candidate-result/review-result/adoption uses exact durable evidence without another adoption or request`；`tests/listing-completion-owners.test.ts` 双入口的 `persisted result/adoption is recovered ...` | **直接（离线局部组合），S+L**。真实结果、成功 call、usage、context 和 adoption 关联恢复；候选/复核/采用落库后注入上层中断，重建不重复请求或采用。此组持久结果中断为异常注入，真正 process.exit 另覆盖已发无结果边界。 |
| 21 | 生图丢响应，本地候选有/无 | `tests/image-workflow-service.test.ts`：`a lost paid response reconciles a durable candidate after restart and resumes without a second generation for that slot`；`a paid 502 response remains unknown across restart and is locally reconciled without another POST` | **部分，S+L**。有候选复用且单槽不增尝试；无候选仍 UNKNOWN、POST 为 1。候选仓库在该 fixture 中是跨服务重建保留的 Map，未证明完整进程崩溃后的磁盘候选恢复。 |
| 22 | 明确未发送与已发未知分开 | `tests/image-workflow-service.test.ts`：`a proven unsent generation failure preserves its ready attempt and resumes with the same request identity`；`a paid 502 response remains unknown across restart and is locally reconciled without another POST` | **部分，S+L**。生图 notSent 保留 READY/requestId，502 保留 UNKNOWN；此证据不能套用于字段操作（17、18）。 |
| 23 | 各 await 暂停，晚返回不得越权采用/提交 | `tests/automatic-listing.test.ts` 的图片/字段暂停；`tests/execution.test.ts` 的 submit preflight；`tests/pause-readback-boundary.test.ts` 的真实任务 scheduled/inflight 暂停取消、parent READY、real Execution late ACCEPTED 系列 | **部分，S+L**。补充实际回读/备货/标签组合和父体/提交晚返回检查点，均有继续对照与重建保护；仍没有所有 await 点的参数化矩阵，阶段 checkpoint 不是完整七图。见 G3。 |
| 24 | 多商品、多并发、部分失败隔离 | `tests/execution-concurrency.test.ts`：`1 workers reach and obey the SKU limit while seven distinct SKUs keep every step in order`（同模板还有 `3`、`5`）；`one failed SKU does not stop its peers or finalize the batch before they settle`；`tests/automatic-preparation.test.ts`：`item preparation errors and partial completion errors retain saved changes and continue with other SKUs` | **部分，S+L**。并发上限、顺序和失败隔离直接断言；自动准备与执行层分别验证，未包含真实付费多商品服务组合。 |
| 25 | 连点、同任务并发、跨任务同 SKU 防重 | `tests/image-workflow-service.test.ts`：`same draft call is deduplicated while active, then restart marks unfinished work interrupted without sending`；`tests/execution-concurrency.test.ts`：`concurrent tasks retain duplicate draft and same-listing SKU queue protection` | **部分，S+L**。同草稿共享 Promise、重复草稿/同店 SKU/跨未结束任务拒绝；未在完整 UI→自动任务→所有服务组合中验证双击。 |
| 26 | 正式 PUT 未知跨重启仍不重发 | `tests/execution.test.ts`：`unknown submission is read back and remains human attention across retry and restart`；`tests/followup.test.ts`：`unknown write is retained for attention and never automatically read or replayed` | **部分，S+L**。执行替身写入 UNKNOWN 后 writes=1；独立回读队列对 UNKNOWN 不自动读/重发。执行层提交被替换，不能称真实正式 PUT 断网实验；两个入口的回读规则需分别保留。 |
| 27 | ACCEPTED、ASIN、DISCOVERABLE、BUYABLE 分别统计 | `tests/followup.test.ts`：`ASIN from matching readback is explicit creation evidence, while an empty issue list alone is not`；`tests/product-insights.test.ts`：`a cached BUYABLE flag without a matching trustworthy observation stays unconfirmed`；`tests/automatic-product-groups.test.ts`：`pricing skips and source confirmation remain distinct from workflow failures and submissions are not counted as complete` | **部分，S**。提交待回读与完成、ASIN 建档证据与缓存 BUYABLE 的局部规则有断言；缺四项同一批次独立计数及转换交叉表，READY 不能直接记为 BUYABLE。 |
| 28 | 原独立销售 SKU 转父子，身份图片历史不变 | `tests/amazon-family-rebind.test.ts`：`same-ID NONE to CHILD changes only proven family fields and keeps legacy naming, recipe, copy, images and history`；`tests/automatic-listing.test.ts`：`legacy standalone family conversion keeps SKU/images across normal execution`（同模板还有 `after-bind`、`recheck`） | **直接（离线），S+L**。同 ID/SKU、命名、recipe、非关系属性及旧 exchange/event 保留；模拟中断恢复。不是从真实历史工作区导出的回放。 |
| 29 | 原任务项白名单外新增付费/提交为 0 | `tests/automatic-listing.test.ts`：`a saved legacy task with twenty blocked source rows resumes the seventeen mapped SKUs only`；`changed scope after native confirmation blocks before paid or remote work` | **部分，S+L**。20 行仅 17 个映射项继续；确认后目标变化调用为 0。未向任务外加入新 SKU/重导入商品，并逐请求断言白名单外所有付费和提交为 0。 |
| 30 | 复核开关与连接 generation 兼容矩阵 | `tests/image-workflow-service.test.ts`：`reenabling copy review checks an existing completed set without generating new images`；`risk switch persists independently and disabled mode preserves main OCR without risk calls`；`key-only rotation during planning blocks before the first paid image request`；`tests/listing-ai-adoption.test.ts`：`schema refresh or target credential rotation blocks adoption without a paid call or draft mutation` | **部分，S+L**。开关、凭据 generation 变化分别覆盖；尚无两种开关×各连接 generation×运行阶段×重启的完整组合。 |
| 31 | 页面图片与实际 SKU/父子关系一致 | `tests/automatic-product-groups.test.ts`：`combined recipes include each source component once and retain distinct sales SKUs and actual parent families`；`scripts/e2e-automatic-listing-ui.mjs`：检查 `12 source cards preserve source/sales counts, actual parent families and excluded variants; search and manual folding survive polling, pricing/source/workflow outcomes and submission/completion remain distinct` | **部分，S**。数据分组与页面父子、数量展示有断言；未逐 DOM 图片 src/hash 对照持久化 SKU/父子绑定，不是图片对应关系验收。 |
| 32 | 保存、崩溃、历史加载、隔离恢复一致 | `tests/fault-recovery.test.ts`：`actual process exits at all restore boundaries recover one complete workspace and retain newer safety history`；`tests/image-workflow-service.test.ts`：`blocked workflow is backed up durably, while a forged completion cannot enter a backup` | **部分，S+L**。确实对子进程退出、恢复日志、本地 SQLite/文件及未知写锁断言；夹具均合成，未包含本计划全部历史业务状态的脱敏回放。 |
| 33 | 日志归因与环境权限错误可区分 | `tests/ai-provider-errors.test.ts`：`Aidge NoPermission explains service permission without blaming saved credentials or exposing server details`；`signature failures and generic authorization responses retain their distinct authentication error`；`tests/ai-output-diagnostics.test.ts`：`a paid-boundary service output failure retains only its unapproved reply and fixed rejection metadata` | **部分，S+L**。服务权限与鉴权分类、固定拒绝阶段及脱敏元数据有断言；尚缺贯通自动任务/字段/图片/外部请求的关联归因，以及 OS 权限失败与业务失败的统一报告。 |
| 34 | 发布制品哈希与有界真实观察 | 没有对应的专门测试名；`scripts/package.mjs` 将文件 SHA-256 写入 `版本与摘要.json`，属构建逻辑，不是验收结果 | **缺口**。未验证本次隔离制品与源码提交绑定、交付文件摘要复核及获批后的有界真实样本；本次不启动真实观察。 |
| 35 | 暂停任务与独立回读调度组合和重启 | `tests/pause-readback-boundary.test.ts`：`real task … permits accepted-only readback … including restart`、两任务隔离、maintenance pause、UNKNOWN/SUBMITTING 和已排队标签暂停系列 | **直接（离线组合），S+L**。同 SQLite 组合真实 Automatic、Followup、Amazon、Execution、Procurement、Labels、ImageWorkflow，公共 due/refreshWaiting 验证已排期/在途回读及重建；外部 HTTP/托管和付费 provider 为替身，未启用真实周期调度器、打印 UI 或实际店铺。见 G3。 |

## 修复增量：定价原因与证据

`fix/pricing-decision-evidence` 为场景 4、13、33 增加结构化归因的离线证据，未完成队列筛选或真实报价验收。类型仍为 S/H/L，运行结果见 `docs/maintenance/2026-10-10-定价原因与证据.md`。

- `tests/amazon-business-rules.test.ts` 的 `pricing decisions distinguish confirmed ROI rejection from default and unverified package attempts`、`blocked quantity facts and sales-recipe count mismatches cannot prove business rejection`、`present malformed or ambiguous item counts stay unconfirmed instead of inheriting one piece`：可靠规则失败与默认、未确认、冲突、错误件数分开，重复计算不提升默认依据可信程度。
- 同文件 `bundle or mixed-sale package measurements need explicit matching scope`、`overlapping quantity failures preserve generated history consistency and cause precedence`、`quantity diagnostics tolerate unit-count-only schemas without requiring number-of-items`：整套包装范围、多个数量问题同时存在、仅支持 unit_count 的类目兼容性。
- `tests/listing-ai-history.test.ts` 的 `versioned pricing decisions preserve confirmed evidence and reject false reliable outcomes`、`pricing history checks claimed package scope against the persisted sales recipe`、`a v2 unreviewed adoption and business-rule snapshot survive encrypted backup restore`：新证据严格校验、旧记录兼容与隔离加密备份恢复。
- `tests/deferred-image-fields.test.ts` 的 `pricing blocking display prefers structured causes over legacy notice wording`：显示原因由固定代码决定；旧文字不升级为可信筛选依据。实际任务和队列分流仍待下一分支验收。

## 修复增量：结果分类与待上架队列

`fix/listing-outcome-classification` 增加场景 4、23、24、25、27、31、32、33 的离线证据，类型仍为 S/L；完整命令和最终结果见 `docs/maintenance/2026-10-10-上架结果分类与待上架队列.md`。这些反例不代替下文 G2/G3 的真实服务组合边界。

- `tests/automatic-listing.test.ts`：`confirmed pricing rejection is terminal and excluded only in the same target queue`、`per-recipe queue leaves a mixed recipe and healthy single when only one source single is screened`，覆盖可信拒绝、当前店铺范围、混合/单独销售配方隔离、失效重新评估及持久化；原始商品和历史保留。
- 同文件的 `pricing text without typed evidence remains unclassified and retained`、`pricing classification retains … without a paid retry` 系列、`legacy unresolved single sale remains check-only when pure sales recipe planning is enabled`、`an unlinked child submit intent takes precedence over a confirmed pricing rejection`：默认/缺失/陈旧资料不升级为可靠拒绝；新旧未知请求及未关联子任务意图不允许重复创建或付费重试。已提交与完成另有独立断言，不能计成 UNKNOWN。
- `source failure … retains its classification across restart` 与 `tests/automatic-image-sources.test.ts` 的来源准备测试：来源生产者的固定原因贯通消费者与重启；下载/映射链路故障为系统待修复，缺链接/未确认绑定为待补资料，旧无原因码结果保守保留。
- `readback pause/cancel during outcome proof stops sibling work` 的普通/父体恢复四个组合：分类等待期间撤销任务权限后不再增加兄弟规格备货、标签或提交，也不将暂停/取消状态改回排队。该测试使用边界替身，不代表真实独立回读与标签服务的 G3 已全部验证。
- `tests/image-workflow-service.test.ts`：`read-only filtering proof requires successful exact BLOCKED evidence: …` 四种模式，核对规划/生成图明确拒绝；不以 UNCERTAIN 或服务异常淘汰，实际参考图字节、开关或关联证据变化使证明失效。`tests/automatic-documents-backup.test.ts` 补充 SCREENED 的加密备份恢复。
- `scripts/e2e-automatic-listing-ui.mjs`：目标范围、部分/全部淘汰、待修复原因、销售配方计数、原因搜索和清除恢复。`scripts/e2e-automatic-pipeline.mjs`：真实本地 FTP 加演示提交/回读，图片服务为边界替身，真实 Amazon 与 AI 请求被禁止；不属于真实上架验收。

## 修复增量：图片字段说明兼容

`fix/image-context-metadata` 补齐场景 15 的局部服务组合，并为 16、20、30、32 增加负向保护，类型为 S/L。维护记录见 `docs/maintenance/2026-10-10-图片字段说明兼容修复.md`。

- 图片服务使用真实 `ListingAiService.currentContext` 构造上下文。仅字段标题或说明变化时，已完成七图和审核复用不新增调用；已有持久候选的 lost paid response 在重启后沿用原 workflow、首图 request 和 attempt，累计生成仍为 7 次。历史 context/hash 不改写。
- `field metadata changes cannot resend an unknown paid request with no durable candidate` 保持同一 UNKNOWN 请求且累计生成 1 次；语义负向矩阵覆盖字段集合/顺序、必填/枚举/推断权限、长度约束、事实、Schema、目标身份、文案及未来未知键，真实变化继续阻断。
- 两条 recheck 路径先验证原始持久哈希，再忽略字段 `title/description` 比较；篡改历史字段说明也不能绕过原始 hash。规则淘汰证明对来源图片实际字节的校验保持有效。
- `image metadata compatibility does not relax listing-field adoption context identity` 证明字段采用仍使用严格上下文。原 `tryReuseApproval` 的四字段能力迁移特例有独立保护，新 helper 不向其他路径扩散该例外。
- 外部提供方响应为隔离替身；不是实际付费服务、真实历史工作区或正式上架验收。

## 修复增量：字段请求边界

`fix/field-request-boundary` 为场景 17–20、22、23、25、30、32 增加离线证据，类型为 S/L。规格与质量复审通过；最终全量 1687 项、1686 通过、0 失败、0 取消、1 同文件符号链接权限跳过，123954.231 ms；类型检查与隔离流水线 3 项通过。完整命令、各轮反例及复审结果见 `docs/maintenance/2026-10-10-字段请求边界.md`。

- 两个真实字段入口都覆盖预览 transport 失败、quota 回滚、已发丢响应、已存结果和已采纳恢复。来源颜色观察另外计数：颜色观察 POST=1 后字段预览失败时字段 POST=0；重建复用观察，不能称整个 complete 未产生调用。
- `tests/listing-completion-boundary.test.ts` 验证 call/usage/journal 同事务失败回滚、固定请求身份、两轮候选加两轮复核预算、独立 AiService 连接并发、真实子进程退出与超时；默认值和操作确认版本同事务，可选字段真实激活不改变操作身份；内部采用 freshness 等待期间暂停仍不得写草稿。
- `tests/listing-completion-backup.test.ts` 使用实际加密备份与服务关闭/重建，覆盖旧快照早于草稿、原草稿无 operationId、同销售 SKU 新 draftId、前进/后退恢复的发送事实并集、严格历史篡改拒绝、schema 17 迁移及正常保留期清理后导出。缺失结果只保留防重发记录，不提升为成功证据。
- 队列按完整销售身份隔离未知结果，并在异步证据读取期间核对 journal；其他模式/销售配方不误标 UNKNOWN。自动修复恢复仍先检查已存在子任务的提交意图。
- 自动 owner 使用真实 AutomaticListingService 的局部入口，但由夹具装载 repair 检查点并授予合成权限；后续执行/备货/标签为替身。单独 pipeline E2E 使用真实本地 FTP 和演示 Amazon，不能填补真实付费/正式上架验收。

## 修复增量：暂停与回读采用边界

`fix/pause-readback-boundary` 为场景 23、24、26、30、32、35 增加离线组合证据，类型为 S/L。规格和质量复审通过；新增 35 项、相关回归 293/293、独立质量探针 11/11；最终全量 1722 项、1721 通过、0 失败、0 取消、1 同文件符号链接权限跳过，150912.8292 ms；类型检查和隔离流水线 3 项通过。完整命令、请求计数与替身范围见 `docs/maintenance/2026-10-10-暂停与回读边界.md`。

- 真实 GET 在途更换 generation 的 RED 证明旧响应曾被 Amazon 保存并能被真实 Procurement 采用。修复后成功/404/其他错误均先复核请求范围；初始 draft-target 身份也必须匹配。现有合法观察、accepted/未知锁、另一实例的新审计与新观察被保留；删除的草稿不会被旧请求重建。
- 普通 accepted 经公共 create/startAuthorized，覆盖排期或在途 pause/cancel、维护暂停在 OAuth beforeSend/GET/多 SKU、UNKNOWN/SUBMITTING 人工与自动回读、重建不恢复权限。两任务仅停一个，另一任务仍通过真实备货与标签 PDF 文件路径；已排队标签停止后不发送。
- 父体使用同商品真实命名 ledger、prepareDrafts 和 familyParentPlan，阶段检查点配合模拟既有 parent grant；暂停/取消下一准备入口 0 次，继续对照到达入口 1 次后由安全哨兵停止。晚 ACCEPTED 组合使用关联真实 Execution 的所有权检查点，公共启动和真实 transport 返回，继续对照完成回读/备货/标签。生产 Automatic 等待 Execution 返回后仍可安排已 accepted 的独立 Followup，测试中零 GET 仅限指定检查点，不代表全部晚返回路径。
- 付费边界 fail-closed，所有用例付费 provider 调用为 0；没有执行实际七图、字段采用、真实店铺或打印。已有图片/字段阶段的暂停证据仍由原测试提供，不将本组扩大为所有 await 验收。

## 修复增量：字段证据契约

`fix/evidence-contract` 为场景 10–13、20、23、30、32 增加离线证据，类型为 S/L。测试轨迹、独立审查与最终验证结果记录在 `docs/maintenance/2026-10-10-字段证据契约.md`；以下证据不扩大为所有类目、任意化学翻译或真实模型验收。

新增正式回归 49 项。规格与质量复审通过；最终全量 1771 项，1770 通过、0 失败、0 取消，唯一跳过仍是 Windows 文件符号链接权限用例；88.937 秒。父任务类型检查及隔离流水线 3 项通过。

- `tests/listing-evidence-contract.test.ts`：同义年龄/人群及明确手动操作、canonical audience 冲突、有限成分翻译和无序集合；存在但无法解析的来源不能通配或借 infer/审核 PASS 放行。结合 `tests/listing-nail-fields.test.ts` 保留旧 intended-user 来源“通用 → Unisex”的有限许可，不合并 General/Unisex，不推出年龄或绕过来源冲突。严格枚举、真实引用和部分字段隔离继续有效。
- 同文件的 blocker 和 selected SKU 系列：冲突事实以非正向引用的独立依据保留；按销售配方及多 SKU 范围处理，当前 Child/Hard 覆盖共通 Adult/Soft，兄弟 SKU 不能解除未知。age 卡未激活时仍保留真正用于覆盖冲突的 sourceSpec；无冲突上下文保持原表示/hash。柠檬酸冲突阻止相应英文文案，无关材质文案仍可使用。
- 首次 complete 与 DONE 都检查当前证据：首次正常两次候选/审核调用仍可采用合法颜色，不能把不受支持的年龄标记为已解决；明确成人来源的正例通过。再次读取 DONE 零新增调用，journal JSON 不改。幂等采用在新增 schema await 后仍核对取消与审核开关。
- 可保存但格式错误的已有字段返回字段级 remaining，不使 operation 卡在 ACTIVE；missing-only 保留 1 次调用，合法颜色部分采用保留原 3 次调用。原值和 schema/missing 原因保留，DONE 复读零调用且 journal 不改；图片审核入口仍严格拒绝相同坏格式。
- 明确操作方式保留既有 Manual 许可及动力来源冲突检查；既有四项形状翻译在中英文文案里按整词阻断，Round 不误命中 Surround。新增 v1 词典仅查自身条目，来源中的原型属性名称不会造成类型异常或被当成翻译值。
- `tests/image-ai-service.test.ts` 的旧 PASS、exact-hash 缓存、COMPLETED/interrupted 继续和嵌套图历史用例：历史结果、单图/七图规划、workflow 和加密备份保持原 bytes/hash，当前错误不能借旧审核或缓存放行，也不能转成付费重生成。合成记录模拟旧语义与旧格式，不是实际历史业务库回放。
- 旧七图重新复核及旧无上下文流程继续：新建当前上下文时写当前契约版本，保留原 run 和旧 AI 结果原始 JSON，七图不重生成。纯审核复用保持原 marker；再次复核零调用。升级仿真从首轮保留原冲突事实和 IP 来源，仅模拟旧 context builder 曾遗漏 blocker。
- 同文件的真实来源颜色组合使用本地 AiService、ListingAiService、ImageWorkflowService、生成服务、SQLite 和替身 transport，覆盖 source_image 颜色采用，以及材质加 source_image 共同引用的普通年龄推断。已有七图与审核复用不新增调用；替换原图字节后拒绝。简化 records 检查不宣称具备完整像素新鲜度输入。
- 共通来源存在但无法解析时，自由标题中的有限类别声明仍有旧缺口：`适用年龄=三岁以上` 与只引用材质的 `Adult Cleaner` 在冻结 v0 和当前版本均通过。独立后续 `fix/prose-evidence-boundary` 处理，不能把本轮 typed 字段及明确 blocker 覆盖扩大为全部自由文案。

## 修复增量：分类否定证据

`fix/category-negation-evidence` 为场景 10–13、20、23、30、32 增加离线证据，类型为 S/L。新增 46 项正式测试，规格与质量复审通过；最终全量 1817 项，1816 通过、0 失败、0 取消、1 项同 Windows 文件符号链接权限跳过，160529.6401 ms。类型检查与隔离流水线 3 项通过。完整反例、各轮修正和命令见 `docs/maintenance/2026-10-10-分类否定证据.md`。

- `tests/category-negation-evidence.test.ts` 的 32 项测试覆盖 typed 候选、review、infer、current copy、DONE 和确定性映射。否定不推出相反属性；无法解析的相关否定仍保留词项约束。裸逗号/斜线列表不重置否定，有限肯定引导词可开始新分句；无香、无味、无蜡、false、非常柔软、non-slip 与 Non-smokers 保留合法既有语义。
- 原始 sourceSpec/所选规格的否定或未解析来源不回退成 normalized Children。隐藏 age 卡仍保留原文角色，真实 blocker、兄弟 SKU 隔离及销售配方锚定继续有效；干净上下文的 ID、顺序、值和哈希不变。
- 候选中的无关否定不能让已有来源排除或 age/power blocker 消失；按分句保留实际 unresolved 词项。来源排除 Electric/Soft 可以约束其既定子类，候选不凭该扩展发明子类；只排除 Corded Electric/Extra Soft 不误挡宽类，另一明确否定分句也不会重新激活不存在的子类肯定。真实肯定加否定仍受约束。
- `tests/image-ai-service.test.ts` 新增 13 项、`tests/image-workflow-records.test.ts` 新增 1 项，与分类文件的版本测试共同验证无标记 v0、字面量 v1/v2 的嵌套图片计划、审核、workflow 和加密备份原 bytes/hash。当前校验不因旧 marker/PASS/cache 放松；fresh recheck 首次保存、早期取消/配置失败、旧空 context 继续及旧单图的新 context 均写当前版本，纯 approval reuse 保留旧 marker。
- 合成旧 builder 丢失所选否定、旧字幕仍写 Child 的真实本地服务组合中，approved-assets 与公共 recheck 均在新增调用之前拒绝，保留七图和 21 条旧 JSON。批准图只检查实际当前方案，已被后来成功方案替代的失败字幕不误挡合法图。独立 SPEC 图片反例 3/3、相关回归 224/224；最终 QUALITY 原两组探针 27/27、正式 delta 10/10。外部 transport 为替身，未执行真实付费调用。
- 本轮只补有限否定/排除义务，未把共通来源一般未解析、肯定不匹配或错误引用的自由文案缺口标为完成。后续文案分支聚焦已有相关来源；任意 NLP、来源缺失的普通文案、字段规范化、默认合规事实及真实店铺验收仍有明确边界。

## 修复增量：有限文案证据

`fix/prose-evidence-boundary` 为场景 10–13、20、23、30、32 增加离线证据，类型为 S/L。新增 48 项正式测试，相关回归 299/299；规格及质量复审通过。最终全量 1865 项，1864 通过、0 失败、0 取消、1 项同 Windows 文件符号链接权限跳过，182268.0192 ms；类型检查及隔离流水线 3 项通过。SPEC 最后独立探针 5/5、正式文案 29/29；QUALITY 最后原反例 7/7、正式增量与默认尺寸控制 10/10。命令、失败复现和范围见 `docs/maintenance/2026-10-10-文案证据边界.md`。

- `tests/prose-evidence-boundary.test.ts` 覆盖四个文案字段以及图片 expectedText：存在但未解析、矛盾、仅排除、肯定不匹配或引用不支持的有限年龄、动力和刷毛硬度声明被拒绝。明确合法来源与对应引用、无关材质文案通过；所选 SKU/销售投影优先级和兄弟隔离保持。source_absent 普通正负文案保持既有政策，没有新增 prose infer 或候选间派生事实授权。
- 有限非属性短语只在文案提取中遮蔽并保留位置。整句与拆分审核继承实际语境和引用责任；重复词、非刷毛形容词与刷毛声明混杂时，不能把前面的否定转给后面的肯定。同负向分句的多词作用域保守要求明确分句；typed 规则和冻结 v0/v1/v2 不改。
- 有限 source/citation 问题在 complete 提前返回前进入既有字段裁剪，保持 partial、2+2、未知请求和取消保护。缺结果、坏 hash、候选不匹配、一般材质/颜色/尺寸错误不能取得同值修复许可。四文案字段选最后一个与当前值匹配的采用承担引用责任，坏最新记录不能回退旧好记录；typed 历史遍历保持。
- 同值 v2 错引用经真实 complete 变为 v3 正确引用，两次模拟请求后新增采用，旧结果及采用 bytes 不变。真实加密备份恢复后重建 WorkspaceStore、Amazon、Hosting、Ai、Listing 服务及独立 SQLite，当前快照通过；DONE 只报告当前问题，零调用/preview，journal 不改。图片清理默认重量句之前独立检查原始文案的有限类别，不能借整句过滤隐藏草稿错误。
- `tests/image-ai-service.test.ts` 覆盖 v0/v1/v2 旧 builder 的 caption/adoption 错误：直接批准资源、复核、COMPLETED 和 INTERRUPTED 继续均在新增请求前拒绝，旧七图与结果/run JSON 保留。合法旧字幕已有真实引用时，同值字段引用修复后复核仍复用原七图，不重生成。原 source_image/color 及已替代失败方案的正控继续有效。
- stored 按旧版本原样读取，当前 v3 marker 仅由主进程产生；新 context、首次保存、早期取消/配置失败、旧空流程及单图路径写当前版本，纯审核复用保留原 marker。records 完整 stored 依据与 current 有限原引用分别核对，不重新绑定 ID，也不将简化投影称作像素新鲜度检查。
- 所有外部提供方均为模拟；这不是任意自然语言、全部 source_absent 声明或真实历史业务库验收。字段格式、默认事实、规格风险和 1688 图像匹配仍在后续独立分支处理。

## 修复增量：新响应字段规范化

`fix/field-normalization` 为场景 7、8、10–13、20、30、32 增加离线证据，类型为 S/L。新增 46 项正式测试；最终专项 62/62，规格与质量复审通过。父任务最终全量 1911 项，1910 通过、0 失败、0 取消、1 项同 Windows 文件符号链接权限跳过，186938.7258 ms；类型检查和隔离流水线 3 项通过。SPEC 首轮正式 55/55、独立 6/6，增量 7/7；QUALITY 原探针在修复后独立 8/8。完整 RED、复审及日志路径见 `docs/maintenance/2026-10-10-字段规范化.md`。

- `tests/listing-field-normalization.test.ts` 通过实际 mock transport 覆盖 generation/repair：有限 ASCII 宽度、外侧空白、唯一实际枚举、三个既有布尔字段和有依据的 fabric N/A；exact literal 保留。原生 false/true 与标准字符串选项兼容，非精确格式造成的枚举碰撞仍拒绝；字符串 0 保留，原生数字 0 继续按原类型合同拒绝。不补缺资料、不增加 infer 权限，不折叠兼容字符或内部空白。
- 规范化后继续执行既有 evidence、字段限制和完整采用校验。未知 key、来源冲突、兄弟 SKU 引用、错误材质和不合法枚举仍拒绝；partial 只保留合法候选及其 trace，缺失原因不被清空。四个原生布尔回归先证明冻结 v3 接受，再验证新入口恢复相同行为。
- `tests/listing-normalization-history.test.ts` 验证外层 `listing-normalization/v1` 原值/结果/规则/引用/位置的严格重放，主进程保存与读取、部分修复、五条 bullet 索引、采用限制、零请求重启及加密备份恢复。转换记录不作为事实或采用权限；可选元数据不宣称为不可篡改的原始响应账本。
- 无标记/v1/v2/v3 旧记录保持原 output/context JSON、哈希、元数据缺省和采用历史；冻结 evidence 与当前 v3 marker 未改。真实报告两个 SKU 的精确请求仍未定位，不能据此声称真实字段补全率或正式上架验收；来源属性、单位、默认合规事实与 1688 图像匹配继续由后续独立分支处理。

## 修复增量：首次来源属性规范化

`fix/source-attribute-normalization` 为场景 7、8、10–13、20、24、25、32 增加离线证据，类型为 S/L。新增 36 项正式测试；规格和质量复审通过；父任务最终全量 1947 项，1946 通过、0 失败、0 取消、1 项同 Windows 文件符号链接权限跳过，144685.6035 ms。类型检查和隔离流水线 3 项通过。完整 RED、复审与日志路径见 `docs/maintenance/2026-10-10-来源属性规范化.md`。

- `tests/source-attribute-normalization.test.ts` 覆盖实际首次入库、固定名称、有限 ASCII 宽度、外侧空白和 24 种单位拼写，逐项连接 mapper 与当前 v3 typed evidence 的正反校验。不补裸数单位、不做物理换算，不转换型号/NFKC 字符或借用兄弟 SKU；原生 0/false 仍拒绝，字符串保留。
- 新可选回执追溯严格重放原值、索引、规则与转换结果；真实 SQLite 检查已知身份冲突及现存事实所属商品。旧无标记 JSON、重复导入、事实删改/状态变化、重开及加密备份恢复保留；完整历史校验和单条读取的能力边界分别记录。不把创建审计称为不可篡改账本。
- `tests/source-attribute-credentials.test.ts` 使用公开服务、合成凭据和模拟 HTTP 复现转换后秘密重建。手动导入、同步入库、缓存预览、缓存复用及重启继续共用写入前守卫，name/value 与完整追溯均检查；拒绝时六类业务表不留下部分导入，普通规范化、既有 ASCII 清洗和旧重复记录保留。
- 审查探针额外覆盖并发首次导入、最大属性数/文本扩展边界、最终 audit 失败回滚及历史身份/事实编辑。snapshot 测量投影、冻结 v3 材质多来源选择的既有边界未改变；不宣称所有单位、真实供应方数据或字段非空率已验收。

## 优先补齐的最小反例

- **G1（15，并以 16 作负向保护）：离线反例已补齐。** 修复前 5 项定向测试中 4 项准确失败，包含仅字段说明变化使已有候选 UNKNOWN 被阻断；修复后相同测试通过。兼容范围明确为字段卡 `title/description`，推断权限和其他规则仍是严格语义边界。真实上下文构造、图片服务及本地持久机制已组合验证，外部提供方与真实业务验收仍未覆盖。
- **G2（17、18、19、20、22）：离线局部组合反例已补齐。** 两个 owner 均组合真实字段/Amazon/AI 服务与 SQLite，覆盖预览失败字段 POST=0、beforeSend 后结果未知、已存结果/采用恢复，并核对同 operation/call、逻辑次数和 2+2 预算。来源颜色单独计数，预览失败不等于整个 complete 零付费。真实子进程退出、双连接并发、加密备份前进/后退恢复、保留期清理和严格历史反例见修复增量。规格复审另外确认：恢复完整快照可复用结果；快照停在已存非 PASS 复核但未写本地 checkpoint 时，BLOCKED 新增请求为 0，NEEDS_CHANGES 仅使用剩余第二轮 2 次。自动 owner 的检查点/grant 为合成装载，未覆盖完整 pump、原生授权、真实提供方或正式上架，不将这些边界写成已验收。
- **G3（23、35）：离线组合反例已补齐。** 同一真实工作区服务组合明确：任务暂停/取消撤销后续执行权限，独立 accepted-only 回读仍可继续；维护暂停阻止新请求但允许已发 GET 完成；UNKNOWN/SUBMITTING 自动不读，人工回读不解未知锁；重建不恢复 grant。已排期/在途、多 SKU、两个任务隔离、排队标签、父体 READY 与晚 ACCEPTED 均有断言。后两组使用明确阶段检查点并有正向继续对照；全七图、原生授权、实际打印、全部 await 与真实外部业务仍未验证。generation 与草稿范围在可信回读采用前校验，防止 Followup 拒绝了旧响应而其他本地消费者已经采用。

## 证据边界与补录要求

历史 Schema 证据来自 `tests/fixtures/amazon/schema-fixture.ts` 读取的脱敏 `drink-coaster-us`、`figurine-parent-us` 等仓库夹具；Schema 回放不等于真实历史任务、调用账本或图片状态回放。本次没有读取真实工作区数据库、凭据或真实调用资料。

后续批次应继续记录完整命令、退出码、通过/失败/取消/跳过数量和日志位置；未运行的 E2E、制品检查及真实服务组合保持未验证。若有失败，先区分测试/环境/程序原因，再更新对应场景；不得因全量测试通过而删除上述缺口。
