# HTC 稳定化修复路线图

日期：2026-10-10。基于合并后的源码与现有审查记录；用户已授权按计划推进，当前执行状态见下节。

## 执行状态

- 计划已通过 `docs/stability-repair-roadmap` 合并至集成分支，被测源码为 `a855e4e`。
- 测试基线：类型检查通过；全量 1576 项，1575 通过、0 失败、0 取消、1 项因 Windows 文件符号链接权限跳过。详细限制见维护记录与回归矩阵。
- 分类分流的前置依赖独立为 `fix/pricing-decision-evidence`：先在定价原因产生的位置保存固定原因码和输入可信程度，防止缺资料/默认包装造成的 ROI 失败被误作规则淘汰。随后 `fix/listing-outcome-classification` 消费该证据并实现队列与界面分流。
- 该前置分支不改变既有费率、ROI 目标或销售价格算法，不自动删除或筛除商品；独立验证后合并。
- `fix/pricing-decision-evidence` 已完成并合并。最终类型检查通过；全量 1589 项，1588 通过、0 失败、0 取消、1 项文件符号链接权限跳过，与基线限制一致。
- `fix/listing-outcome-classification` 已完成规格与质量复审：按店铺和销售配方分流，保留资料/系统/未知结果；新增来源结构化原因、暂停屏障、原因搜索和安全恢复。最终全量 1619 项，1618 通过、0 失败、0 取消、1 项同权限跳过；UI E2E 12 项、隔离流水线 3 项通过。此为源码及隔离验收，现有 release 包与真实店铺验收尚未更新。
- 12 个已核实的空拼写目录已在独立整理分支归档，Git 扫描警告消失；保留本地恢复清单。
- `fix/image-context-metadata` 已通过规格与质量复审：图片兼容比较仅忽略字段标题/说明，旧上下文和付费请求原样保留，真实事实/权限/Schema 变化仍阻断。定向 99/99；最终全量 1629 项，1628 通过、0 失败、0 取消、1 项同文件符号链接权限跳过，140.6 秒；类型检查通过。G1 离线反例已补齐。
- `fix/field-request-boundary` 已通过规格与质量复审：字段请求、额度和发送标记同事务，两个调用入口按真实发送状态恢复；已保存结果和采用可复用，未知请求跨重启、备份恢复及保留期清理继续禁止重发。G2 离线局部组合已补齐；最终全量 1687 项，1686 通过、0 失败、0 取消、1 项同权限跳过，124.0 秒；类型检查与隔离流水线 3 项通过。维护记录保留各轮审查反例及修复证据。
- `fix/pause-readback-boundary` 已通过规格与质量复审：Amazon 在采用回读成功或错误响应前校验店铺 generation 与草稿范围，保留合法旧观察、未知锁及并发审计。G3 离线组合已补齐，新增 35 项，相关回归 293/293；最终全量 1722 项，1721 通过、0 失败、0 取消、1 项同权限跳过，150.9 秒；类型检查和隔离流水线 3 项通过。父体及晚 ACCEPTED 使用明确阶段检查点，未扩大为全七图或所有 await 验收。下一项为 `fix/evidence-contract`。

- `fix/evidence-contract` 已通过规格与质量复审：统一支持/冲突/未解析判断，保留有限合法别名、转换及部分字段修复；当前授权严格校验，旧字段/图片记录按冻结版本读取，旧图复核不重生成。新增 49 项正式回归，最终全量 1771 项，1770 通过、0 失败、0 取消、1 项同文件符号链接权限跳过，88.9 秒；类型检查和隔离流水线 3 项通过。首次全量发现的“通用 → Unisex”兼容回归已补修并独立复核；后续从 `fix/category-negation-evidence` 开始。
- `fix/category-negation-evidence` 已通过规格与质量复审：原始规格的否定/未解析状态不被规范化肯定值覆盖；有限分句保留排除约束，并避免宽类/子类串扰。新证据 v2 与冻结 v0/v1 分离，新图片任务首次保存写当前版本，旧记录原样读取；旧字幕与当前否定矛盾时，在图片授权及复核调用前阻断，已被成功方案替代的失败计划不误挡当前图。新增 46 项正式测试；最终全量 1817 项，1816 通过、0 失败、0 取消、1 项同文件符号链接权限跳过，160.5 秒；类型检查与隔离流水线 3 项通过。下一项为 `fix/prose-evidence-boundary`。

- `fix/prose-evidence-boundary` 已通过规格与质量复审：相关来源存在时，有限年龄/动力/刷毛硬度文案须有一致支持和实际引用；同值引用可定向修复，旧记录按冻结版本读取。原始文案检查先于图片默认重量过滤，旧错误图片在新增调用前阻断，合法七图继续复用。新增 48 项正式测试，相关回归 299/299；最终全量 1865 项，1864 通过、0 失败、0 取消、1 项同文件符号链接权限跳过，182.3 秒；类型检查及隔离流水线 3 项通过。source_absent 普通文案仍保留既有规则。下一项为 `fix/field-normalization`。

- `fix/field-normalization` 已通过规格与质量复审：仅新 AI 响应接入有限全半角、外侧空白、布尔和唯一实际 Schema 枚举转换，合法非织物 N/A 按真实选项处理；主进程记录原值、规则和引用。旧结果、事实、上下文及哈希不改写，当前证据版本保持 v3。独立审查发现的两类原生布尔精确枚举回归已补齐；新增 46 项正式测试，最终全量 1911 项，1910 通过、0 失败、0 取消、1 项同文件符号链接权限跳过，186.9 秒；类型检查及隔离流水线 3 项通过。下一项为 `fix/source-attribute-normalization`。

- `fix/source-attribute-normalization` 已通过规格与质量复审：仅首次妙手事实入库执行有限属性名/值、全半角与明确单位拼写规范化，保留清洗后的 snapshot 原值及 `source-attribute-normalization/v1` 追溯；旧回执、重复导入、人工修改和上下文哈希不改写。质量审查发现的转换后凭据重建已在手动/同步共用入库边界阻断。新增 36 项正式测试；最终全量 1947 项，1946 通过、0 失败、0 取消、1 项同文件符号链接权限跳过，144.7 秒；类型检查及隔离流水线 3 项通过。下一项为 `fix/variant-safety-evidence`。

- `fix/variant-safety-evidence` 已通过规格与质量复审：Haul 安全声明读取所选原始规格和每个销售配方组件；旧 false/NA 声明与当前风险冲突时保留原值和历史，持久化阻断旧草稿复用、预览和提交，并归入待补资料。新增 18 项正式测试，相关回归 244/244；最终全量 1965 项，1964 通过、0 失败、0 取消、1 项同文件符号链接权限跳过，184.4 秒；类型检查与隔离流水线 3 项通过。普通未说明资料的默认权限由下一 `fix/fallback-fact-boundary` 处理。

- `fix/fallback-fact-boundary` 已通过规格与质量复审：Haul 默认尺寸/重量只用于私有估价；品牌、产地与合规声明须有当前依据。旧草稿保留，逐物理分量核验并保留匹配事实 ID；成功报价也核验实际输入快照，新付费请求在发送前阻断过期依据，缓存和 UNKNOWN 本地恢复仍可读取。新增 36 项正式测试，相关回归 435/435；最终全量 2001 项，2000 通过、0 失败、0 取消、1 项同文件符号链接权限跳过，131.0 秒；类型检查与隔离流水线 3 项通过。按用户要求，本项提交并合并后暂停；下次从 `fix/1688-thumbnail-sources` 继续，后续视觉校验、拒绝原因展示与制品验收尚未实施。

- 2026-10-11 用户已要求继续执行，并登记 UI 优化。`fix/1688-thumbnail-sources` 已完成原生缩略图精确送达、持久来源记录与当前单 SKU 选图保护；独立 SPEC/QUALITY 审查通过，新增 17 项正式测试，全量 2018 项，2017 通过、0 失败、0 取消、1 项同 Windows 符号链接权限跳过，200.4 秒；隔离流水线 3 项通过。完整结果与测试类型修正见维护记录。下一项为 `fix/source-image-consistency`，当前来源关联成功仍不代表视觉一致性通过；未更新安装包或进行真实业务验收。

- `fix/source-image-consistency` 已完成源码及隔离验收：按准确 SKU 来源比较有限颜色/形状/图案，歧义保留人工确认，旧付费图可复用，UNKNOWN 不重发；独立 SPEC/QUALITY 及夹具差异复审通过。新增 49 项正式测试；最终全量 2067 项，2066 通过、0 失败、0 取消、1 项同 Windows 符号链接权限跳过，220.8 秒；类型检查通过，隔离 UI 9 项、执行 7 项、自动流水线 3 项通过。下一项为 `fix/actionable-rejection-reasons`。真实视觉准确率及现有业务覆盖率未验收，安装包尚未更新。

- `fix/actionable-rejection-reasons` 已通过 SPEC/QUALITY 及历史夹具复审：空提示词、无依据测量、来源不足、模型未给候选与本地字段拒绝分开展示，UNKNOWN 由真实 journal 优先投影；保留正常队列及继续任务指引。新增 13 项正式测试，最终全量 2080 项，2079 通过、0 失败、0 取消、1 项同 Windows 权限跳过，258.7 秒；类型检查、隔离流水线 3 项、原因 UI 10 项、队列 UI 13 项通过。下一项 `chore/release-verification`；广泛工作台 UI 优化仍仅登记。

**目标：** 每个问题在独立分支完成复现、修复和验收，最终形成可追溯的源码、发布包与真实结果。

**方式：** 保留既有身份账本、图片历史、持久化和未知请求保护，局部修改；先证据后改代码。此文件是跨模块路线图，各分支在复现后补充具体实施步骤，不在根因未核实时预写补丁。

**技术栈：** Windows、Node.js 24、Electron、React、TypeScript、SQLite、Node test runner。

执行时使用 executing-plans 技能逐项推进。STABILITY_PLAN.md 的 35 项回归要求继续有效。

## 分支约定

集成分支：`feat/workbench-foundation`。每项从其最新已验证提交建立分支，串行推进，避免依赖尚未验收的修复。每次完成更新必须 commit；相关检查通过后 `--no-ff` 合并保留边界。Git 提交、部署和真实业务运行是不同阶段。

本轮文档分支：`docs/stability-repair-roadmap`。以下名称为计划，执行时才创建。

## 顺序、范围与验收

| 顺序 | 分支 | 单一目标 | 验收条件 |
|---|---|---|---|
| 0 | test/stability-baseline | 建立当前版本可复现基线和 35 项覆盖矩阵 | 每项有测试位置、运行结果、缺口；环境错误独立记录；源码版本与结果对应 |
| 1 | fix/image-context-metadata | 字段元数据更新不误伤旧图片 | 仅元数据变化可继续使用；颜色、来源字节或身份真实变化仍阻断；不覆盖历史付费记录 |
| 2 | fix/field-request-boundary | 字段操作状态对齐真实请求边界 | 未发送失败可安全恢复；已发送未知不自动重发；已持久化结果可复用；重启一致 |
| 3 | fix/pause-readback-boundary | 明确暂停、晚返回与独立回读的权限 | 暂停后晚返回不越权采用、付费或提交；必要回读按明确协议运行；重启保持一致 |
| 4 | fix/evidence-contract | 统一字段事实证据与推断权限 | 合法别名及转换通过；无关证据、非法枚举、缺失危险品资料仍拒收；部分候选失败不污染其他字段 |
| 5 | fix/fallback-fact-boundary | 根据默认值审计结果隔离估算与真实声明 | 定价估算来源可辨；缺失真实依据的合规声明不能被自动当作已核实事实提交 |
| 6 | fix/source-image-consistency | 根据覆盖率调查修复规格与图片错配 | 错绑可发现；真实歧义保持待确认；兄弟 SKU 隔离，既有身份与图片历史不变 |
| 7 | fix/actionable-rejection-reasons | 将已有拒绝原因转成可操作的界面信息 | 能区分空提示词、无依据尺寸、来源拒绝和未知结果；不暴露原始敏感内容 |
| 8 | chore/release-verification | 建立源码与发布制品的对应关系 | 完整回归、相关 E2E、包校验完成；源码 commit 与制品哈希可追溯 |

顺序 1–4 的具体代码改动须由复现证据确定。若顺序 1 的失败反例证明必须先修证据契约，则调整依赖并先更新此计划，不在同一分支混修两个根因。

## 第一步：测试基线

- [x] 确认 Git 状态干净，从集成分支创建 `test/stability-baseline`，记录 HEAD、Node/npm 版本及已有安装包信息。
- [x] 运行 `npm run typecheck`，输出保存至忽略的 artifacts 目录；退出码必须为 0。
- [x] 运行 `node --test --test-concurrency=4 --test-timeout=180000 tests/*.test.ts`，完整记录通过、失败、取消、跳过及用时。
- [x] 对每个失败文件单独运行；不得通过降低断言或直接增加超时掩盖问题。目录联接权限问题按已知环境问题核对。
- [x] 新建 `docs/version-control/REGRESSION_MATRIX.md`，逐项映射原计划的 35 个编号到具体测试、是否合成/历史/真实验证、结果和缺口。没有证据就标记未验证。
- [x] 重点复核 `tests/automatic-listing-recheck-evidence.test.ts`、`tests/listing-ai-context.test.ts`、`tests/listing-ai-completion.test.ts`、`tests/followup.test.ts`、`tests/fault-recovery.test.ts`，定位前三个核心问题已有的反例覆盖。
- [x] 将纯基线结果脱敏记录后 commit；若有程序失败，登记独立修复项，基线记录本身不能声称系统验收通过。

## 各修复的代码与测试入口

| 分支主题 | 首查代码 | 相关现有测试 |
|---|---|---|
| 图片上下文 | src/main/image-workflow/service.ts 的 currentContextMatches/runSeven；src/main/image-workflow/recheck-evidence.ts | tests/automatic-listing-recheck-evidence.test.ts；tests/image-workflow-service.test.ts |
| 请求边界 | src/main/listing-ai/service.ts 的 complete；src/main/ai/service.ts 的 beforeSend；src/main/automatic-listing/service.ts 的 finishRepair | tests/listing-ai-completion.test.ts；tests/listing-ai-history.test.ts；tests/ai-request-control.test.ts |
| 暂停与回读 | src/main/automatic-listing/service.ts；src/main/followup/service.ts | tests/automatic-listing.test.ts；tests/followup.test.ts；tests/fault-recovery.test.ts |
| 证据契约 | src/main/listing-ai/semantic-evidence.ts；src/shared/listing-ai-contracts.ts | tests/listing-ai-validation.test.ts；tests/listing-ai-category-attributes.test.ts；tests/listing-ai-rejection-reasons.test.ts |
| 默认值 | src/main/amazon 下的业务规则与准备逻辑，先追踪实际字段赋值来源 | tests/amazon-business-rules.test.ts；tests/image-facts.test.ts |
| 来源图匹配 | src/main/image-workflow/sources.ts；自动上架来源准备调用链 | tests/automatic-image-sources.test.ts；tests/source-color-ai.test.ts |
| 拒绝原因 | src/main/ai/errors.ts；src/main/ai/output-diagnostics.ts；src/renderer/AutomaticTaskPanel.tsx | tests/ai-output-diagnostics.test.ts；tests/image-plan-repair.test.ts |
| 制品 | scripts/package.mjs；scripts/verify-package.mjs；启动 HTC.cmd | 包摘要校验及相关 scripts/e2e-*.mjs |

## 每个修复的固定检查点

1. 读取对应调用链和历史记录，写出触发条件、预期和实际结果。
2. 增加一个能在修复前准确失败的最小反例，并确认失败原因属于目标问题。
3. 实施最小改动；增加反例保护，证明原有安全边界未放松。
4. 跑相关测试、类型检查和完整回归；涉及页面时补相关 E2E。验证失败不得宣称修复完成。
5. 更新脱敏维护记录和覆盖矩阵，明确未验证内容；检查 diff 后按文件暂存并 commit。
6. 验证通过后合并回集成分支。若集成分支有新改动，合并前重新验证组合结果。

## 用户补充的三项联合验收要求

以下要求于 2026-10-10 补充，属于同一轮稳定化目标，但仍拆成独立分支和 commit。基线之后优先建立筛选归因，再实施字段与图片修复；请求边界、元数据兼容等核心修复按依赖穿插，不因新增需求取消。

### A. 字段未补全：确定性规则修复

分支：`fix/field-normalization`。与 `fix/evidence-contract` 分开：本分支负责提取和规范化，后者负责证据及推断权限契约。

只读调查补充：现有本机诊断最新仍为 10 月 9 日，尚未定位到报告所述两个 SKU 的精确请求。旧记录中的 `bullet_point` 是模型明确报告依据不足，并非空字符串候选；“保质期”对应 `is_expiration_dated_product` 布尔字段，不是期限天数。当前代码已支持相关类别属性，不能把历史失败直接当作当前复现。

已发现可独立复现的提取缺口：`categoryAttributeValues` 直接匹配关键词，会把“不适合儿童”“非电动”作为肯定属性。先在 `fix/category-negation-evidence` 修复否定语境并保持矛盾依据阻断，再在 `fix/field-normalization` 处理有依据的格式转换及原值/规则记录；两者分别提交。

否定词修复须保留“明确提到了该属性但是否定或无法解析”的状态，不能只删除肯定关键词后把来源变成缺失并重新允许 infer；原始 `sourceSpec` 的否定也不能被规范化规格中的肯定词覆盖。若引入新的证据版本，除冻结旧 parser 外，还须同步核对 AI 结果和图片工作流 stored 入口的支持版本集合及原样返回的 marker；用无标记、v1、新版记录验证读取、备份及 hash 保留，不能只改当前版本常量。

随后以独立 `fix/prose-evidence-boundary` 补齐有限类别声明在自由文案中的证据检查。已用冻结 v0 与当前规则对照确认既有缺口：共通来源 `适用年龄=三岁以上` 无法解析时，标题 `Adult Cleaner` 仅引用材质仍被接受；这不是本轮证据契约引入的回归。先限于明确年龄、动力等既有类别词，按来源存在、否定、冲突及合法推断权限核验；无关文案须继续通过，不扩成任意自然语言推理或通用配件校验。当前证据契约已覆盖明确 blocker 的有限翻译和所选 SKU 矛盾，但不能据此声称所有自由文案声明均已校验。

文案分支的调查范围进一步限定为“已有相关来源”：未解析、矛盾、只有排除而无肯定支持，以及引用了无关资料的有限年龄/动力/刷毛硬度声明。`source_absent` 普通文案维持既有义务，不新增 prose infer 权限，也不将另一候选伪装成来源事实。`instruction manual`、`baby blue`、`baby shower`、`adult supervision` 等已复现的非属性短语仅在文案提取中处理，typed 属性规则不变。新操作沿用现有字段修复范围，只处理准确定位的问题字段；DONE 只报告当前问题，不再次付费。若同值文案只有引用错误，须证明新有效采用可以接替旧引用责任，且不改写历史记录或扩大其他字段的覆盖权限。

字段规范化的只读调查进一步区分了两个入口。`fix/field-normalization` 仅在新 AI 响应接入时进行有限空白、全半角、布尔及唯一 Schema 枚举转换，保存原值、规则和原引用；不能在历史结果共用 validator 中改写旧值，也不为格式转换升级证据版本。数值/单位转换须证明当前原始来源证据与映射全链路一致，不能只修映射后仍被来源校验拒绝。

随后独立 `fix/source-attribute-normalization` 处理妙手首次创建事实时的有限属性名/值转换。保留回执 snapshot 原属性及转换追溯；该 snapshot 已经清洗，不宣称是原始 HTTP。旧回执、事实、上下文和 hash 不改写，重复导入继续返回原记录；事实 state/source 和冲突状态不升级，原生 1688 的规格属性不提升为产品共通事实。验证范围包括严格回执/备份读取、false/0、来源冲突和兄弟 SKU 隔离。

当前后续顺序为：`fix/category-negation-evidence` → `fix/prose-evidence-boundary` → `fix/field-normalization` → `fix/source-attribute-normalization` → `fix/variant-safety-evidence` → `fix/fallback-fact-boundary` → `fix/1688-thumbnail-sources` → `fix/source-image-consistency` → `fix/actionable-rejection-reasons` → `chore/release-verification`。各分支均从前项已验证的集成提交开始。

证据契约只读调查也已得到当前纯函数反例：相同成人/手动事实因字段别名不同被区别拒绝；引用存在但无法解析时，候选可以填入与来源不符的年龄、成分或保质期布尔值；来源上下文过滤冲突行后，候选可绕过原有冲突阻断。`fix/evidence-contract` 须区分支持、冲突和未解析，保留阻断依据，并验证合法翻译/转换，不能将无法解析当作通配许可。兄弟 SKU 引用、非法枚举、无直接化学成分来源和危险品候选的既有拒绝保持有效。配件通用语义校验不完备另行登记，不在别名修复时扩大许可。

依据当天审查：5 次七图规划拒绝中，4 次为顶层 prompt 为空，1 次为镜头焦距误判尺寸，已在 3e2c652 修复；另外 2 个 SKU 因 bullet_point、保质期、适用年龄等必填字段未补全而失败。报告没有证明这两个 SKU 都有足够来源资料，因此不能把未补全一律归因于 AI，也不能宣称正则能补齐缺失事实。

- [ ] 从本机原诊断中只读定位具体字段、原始候选、事实依据及拒绝原因；真实数据只保留本地，回归使用脱敏/合成反例。
- [ ] 按字段建立白名单规则：空白与全半角规范化、单位格式转换、字段别名、明确同义词和合法枚举映射；保留原值、规则标识及依据。
- [ ] 处理顺序：有依据的确定性提取/转换 → 必要的 AI 候选 → 原有 Schema 与事实校验。不能用另一 SKU 的资料或通用默认值掩盖空字段。
- [ ] 正则必须处理上下文和否定词；尺寸不得吸收镜头焦距、型号数字；数量 0 和布尔 false 不得按空值丢弃。
- [ ] 区分无候选、格式错误、证据冲突、真正缺资料和合法不适用。不能统一清除 N/A：现有 fabric_type 对有依据的非织物存在合法不适用规则，须按字段和 Schema 判断。
- [ ] 验收：可确定转换的字段填入合法值；无依据的保质期/年龄/合规事实不编造；规则处理后仍走证据校验；失败能显示字段和原因，进入系统待修复或待补资料。

代码入口：`src/main/listing-ai/validation.ts`、`src/main/listing-ai/semantic-evidence.ts`、`src/main/listing-ai/service.ts`。相关测试：`tests/listing-ai-validation.test.ts`、`tests/listing-ai-completion.test.ts`、`tests/image-plan-repair.test.ts`。

### B. 1688 缩略图反向校验规格

分支：`fix/source-image-consistency`，扩展原第 6 项，按用户要求提前到本轮主要修复。

调用链调查补充：原生 1688 回执已经保留供应商 SKU 与图片 ID，实际自动下载入口目前只接妙手回执。先以 `fix/1688-thumbnail-sources` 接通精确身份映射、持久化回执/图片 ID/原始字节的来源记录，并同步单 SKU 通用图判定；该分支只解决关联送达，不代表视觉校验通过。随后 `fix/source-image-consistency` 使用这些来源记录核验图像与规格，不能将既有 `asset.confirmed` 当作视觉通过证据。

当前 `extension/normalize.ts` 已将供应商 SKU 的 imageUrl 保存为 provider-sku-id 关联；`src/shared/collection-contracts.ts` 也记录关联依据。应先核对缩略图在采集、入库、下载、SKU 绑定全链路是否保留，不重复猜测已有的明确关系。

- [x] 以规格自带缩略图及供应商 SKU 身份作为首选关联依据，离线覆盖断链与共享图情形。
- [ ] 统计真实业务已有图覆盖率及断链位置；本次未读取真实商品数据库。
- [x] 绑定后根据缩略图识别主色、外观和款式，与该规格属性反向比较。图像分辨率不足、遮挡或无法区分时转待确认，不能自动通过。
- [x] 区分颜色/外观维度和尺寸维度；同款不同尺寸共享图可能合法，同图多规格不能直接判错。
- [x] 保留供应商原始规格文字；规范化色族只用于校验，不自动替换原始供货事实或提交字段。
- [x] 有冲突时保留原绑定、候选和理由，不静默改绑。人工确认以当前图像与规格版本为准，来源变化后重新核对。
- [x] 离线模拟观察验收（不代表真实模型准确率）：正确配对通过；错色/错款被识别；尺寸共享图不误报；低清图、随机混色与证据不足不被当作确定匹配；不串用兄弟 SKU 图片。

相关测试：`tests/collection-parser.test.ts`、`tests/automatic-image-sources.test.ts`、`tests/source-color-ai.test.ts`。新增付费视觉调用的缓存、次数和失败恢复必须遵守请求边界保护，真实调用另行明确范围。

### C. 规则筛选与系统异常分开管理

分支：`fix/listing-outcome-classification`，基线后优先实施，为 A/B 提供一致的结果去向。

用户已明确：**规则淘汰自动移出待上架列表，系统异常保留待修复。** 移出列表采用可追溯的筛选状态，不等于物理删除商品、图片或历史记录。

| 分类 | 例子 | 处理 |
|---|---|---|
| 规则筛选 | 有可靠成本依据且 ROI 不达标；命中配置的侵权风险阈值；经确认不满足供货/外观要求 | 自动移出待上架列表，在筛选结果中保留原因、依据、规则版本与时间；规则或资料改变后可重新评估 |
| 系统待修复 | 有资料却字段映射失败；AI 输出格式错误；缩略图关联链路丢失；解析、下载或服务异常 | 保留商品及已完成成果，进入待修复列表，修复后按安全边界继续 |
| 待补资料/人工确认 | 来源没有所需事实；图片模糊；规格与图像矛盾但无法确认哪方错误 | 归入保留处理队列的独立子类，显示所需资料；不误标为商品淘汰或程序 bug |
| 结果未知 | 已发送的付费请求或提交未收到确定结果 | 保留核对状态，不提供会造成自动重发的普通重试动作 |

- [x] 分类依据来自结构化原因码和证据，不依赖界面错误文字的正则匹配。
- [x] 先按销售 SKU 分类；一个 SKU 被筛掉不连带删除同商品其他合格规格。商品层汇总覆盖部分淘汰、全部淘汰、混合异常。
- [x] ROI 因缺少成本/尺寸而无法计算属于待补资料或系统异常，不等同已证实 ROI 不达标；侵权检测服务失败不等同侵权命中。
- [x] 列表分别展示待上架、规则筛选、待修复/确认，并支持按原因筛选；记录恢复和重新评估的原因。
- [x] 旧任务缺少原因码时保留原始原因并标记待归因，不凭含糊文字批量移出商品。
- [x] 物理删除单独保留手动操作，不因这次分类改动增加自动删除；运行中任务、父子关系和审计历史保留。
- [x] 离线验收：规则筛选正确移出；系统失败可见且成果保留；分类持久化并跨重启一致；读取和状态恢复本身不新增付费请求或正式提交。真实店铺验收仍见末节要求。

代码入口：`src/shared/automatic-listing-contracts.ts`、`src/main/automatic-listing/records.ts`、`src/main/automatic-listing/service.ts`、`src/renderer/AutomaticTaskPanel.tsx`；还需追踪实际待上架列表的数据源并覆盖其展示。相关测试：`tests/automatic-listing.test.ts`、`tests/automatic-listing-migration.test.ts`、`tests/inbox-summary.test.ts`。

### 三项联合验收

同一组合样本同时包含：规则淘汰 SKU、可通过规则修复的字段、真实缺资料、正确缩略图、错误绑定和未知请求。要求每项进入正确队列、合格兄弟规格继续保留、已付费图片不丢失、修复后不重复提交。先用合成样本验证，再进入有界真实验收。

## 其他调查与暂缓事项

### UI 优化登记（2026-10-11）

用户要求继续修复，同时登记 UI 优化。状态：已登记、尚未实施；不影响先完成 1688 缩略图送达与规格反向校验的顺序。

- 优先在 `fix/actionable-rejection-reasons` 展示具体商品/规格、失败阶段、字段、原因和下一步处理入口，区分规则筛选、系统待修复、待补资料与结果未知。
- 后续独立 `feat/workbench-ui-optimization` 优化任务列表的信息层级、状态与进度、筛选和批量操作反馈；具体页面方案以实际界面检查结果为准。
- 图片区域清楚区分来源关联、视觉待确认、校验冲突、生成中和已完成；下载成功或绑定确认不能显示成视觉匹配通过。
- 已完成成果、可继续步骤及按钮不可用原因可见；结果未知不得出现会自动重发付费请求的普通重试入口。
- 验收覆盖不同状态的合成商品、长中文原因、空列表与混合 SKU；检查受影响页面及操作权限，不改变既有分类和请求边界。
- UI 改动独立分支、独立 commit；涉及 UI 的后续版本交付前须验证受影响页面和发布制品。本次只登记，不表示界面已更新，也不把尚未实施的 UI 优化设为当前修复发布的前置条件。

- 默认值审计：先只读检查已有草稿的尺寸、重量、品牌、合规声明和依据，输出脱敏统计；不将真实草稿写进仓库。
- 默认值源码及合成调查确认：默认尺寸重量、品牌/制造商/原产国和普通合规声明会写入实际属性，并进入请求序列化；图片上下文过滤默认尺寸、定价拒绝证据降级均不能代替提交事实校验。`fix/fallback-fact-boundary` 应逐字段隔离估价与可提交声明，保留已有人工数据和历史；此结论不代表执行过真实提交或平台已接受。
- 默认声明还遗漏所选 SKU 的来源规格风险词：只有当前规格写“电池供电”时仍产生电池 false/危险品 NA，而同文写在标题会阻断。该独立根因先在 `fix/variant-safety-evidence` 处理，覆盖所选原始规格、销售配方各组件、仅兄弟规格、来源冲突和普通未说明；不得与否定语境修复混为一个分支。只读合成复现也表明，风险接入后已有 business 默认值或来源 false 可能仍保留且只产生 notice，因此需要验证当前冲突在实际提交入口被结构化错误阻断；保留原值与历史，不推导反向合规事实、不据此淘汰商品。旧默认值的撤销与事实权限归属仍由后续 fallback 分支处理。
- 暂停与独立回读：现有原生授权包含回读，独立服务没有提交接口；任务暂停撤销任务执行权限，维护暂停阻止新回读，但允许已发 GET 完成。隔离调查复现过 GET 中更换 generation 后旧 BUYABLE 被保存、真实 Procurement 仍能采用的问题；`fix/pause-readback-boundary` 已在 Amazon 写可信状态前检查目标及草稿范围，覆盖成功与错误返回。真实本地服务组合固化已排期/在途暂停、取消、维护暂停、两任务隔离、UNKNOWN/SUBMITTING、父体 READY 和晚 ACCEPTED 协议。独立 accepted Followup 仍可只读继续；阶段检查点与完整流程的差异见维护记录，不误称所有 await 已覆盖。
- 规格图片：先统计规格自带图覆盖率、缺失及重复绑定情况。优先验证已有绑定与图像是否矛盾，再决定是否增加兄弟规格推断或人工界面。
- 图片规划修复已在 `3e2c652` 合入，复用现有回归，不重新做一遍同样补丁；完整真实上下文效果仍未验证。
- 自动重试暂不排入实施：须先完成请求边界、错误分类及调用上限设计；未知付费结果始终不得自动重发。
- 异常名称目录已单独调查：12 个根目录均只有空 `Microsoft/Spelling/neutral` 结构，已可恢复归档并保存 UTF-16 名称清单；没有删除未知数据。详见 `docs/maintenance/2026-10-10-空拼写目录归档.md`。

## 发布与真实验收

- [ ] 类型、全量单测、受影响 E2E、隔离构建及包校验满足原稳定化计划；取消与跳过均有处理结论。
- [ ] 更新制品时记录对应源码 commit 和摘要；核对启动脚本实际启动的是新制品。
- [ ] 真实运行前明确店铺、3–5 个 SKU 白名单、调用预算及停止条件，并取得该次运行授权。
- [ ] 分开统计调用、规划完成、七图完成、正式提交、ASIN、可发现、可购买和标签完成。
- [ ] 遇到未知请求、范围外调用、重复提交风险或连续相同错误，停止扩大样本并定位；不得直接恢复整批。

## 最初计划整理的验证范围

计划整理阶段仅更新文档：核对原稳定化计划、Git 状态与相关源码/测试入口，检查 diff 和文件链接。后续执行的基线及修复结果以本文件顶部执行状态和各维护记录为准。
