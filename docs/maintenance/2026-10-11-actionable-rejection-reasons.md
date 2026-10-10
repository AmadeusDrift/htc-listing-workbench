# 可操作拒绝原因（源码及隔离验收完成，2026-10-11）

分支：`fix/actionable-rejection-reasons`。基线：`8ee954fd7d214eb93179a204603cf13c6180794b`。独立 SPEC/QUALITY 与最终完整回归已通过，准备提交合并。以下分阶段证据保留原始结果，最终结论见末节。

## 变更

- 新增有限白名单 `rejection-presentation/v1`。空提示词、无依据测量、合法来源观察不足、模型未返回字段、可信本地字段格式/证据拒绝、现有来源问题与一致性门禁使用固定中文信息；旧记录或未知代码明确无法归因。
- AiCall 保存可选拒绝与调用上下文；AiResult 保存可选字段拒绝旁路信息。实际本地 ListingValidationError 和模型 missing 保持独立。模型 missing.reason 不参与可信归因；候选 false、0、非织物 NA 仍合法，混合输出保留合法候选。
- Workflow 与自动任务保存准确 call/result/workflow、owner、上下文 hash、stage、slot；持久化读取和备份验证引用。失败严格 suggest 与局部 repair 均可保留有限生产者原因。
- AutomaticTaskPanel、AutomaticProductGroups、逐 SKU 队列、ListingAiPanel、ImageSlotProgress（包括无 slots 初始失败）使用固定展示。IPC 可选安全拒绝信息严格解析。保留既有导航及实际禁用理由。
- UNKNOWN/journal 状态继续优先；展示原因不授予重试、付费、提交或重发权限。规则分类继续来自 typed outcome。AI 模型 JSON、evidence v0-v3 与历史原始 payload/hash 不改写；schema 仍为 20。

## 验证证据

本地脱敏日志：`artifacts/actionable-reasons-implementation-2026-10-11/`。

- 红测：`red-core.log`、`red-public.log`。`red-workflow.log` 首次夹具选错无 workflow 的 case，不能算有效产品红证据；修正夹具后绿色结果见 `green-workflow.log`。
- 实际 AiService 保存 → 关闭/重启 → 精确 workflow 引用 → 备份恢复：`service-chain.log` 7/7；包含错 draft/variant/hash 拒读及备份拒绝、原始 call/result 字节相同，网络全局禁止且无重发。
- 实际 image workflow 的 EMPTY_PROMPT、UNSUPPORTED_MEASUREMENT、SOURCE_OBSERVATION_INSUFFICIENT：`image-chain.log` 3/3，生成次数 0，持久读取与备份通过。
- 相关回归 `related-final.log`：443 tests，432 pass，11 fail。10 个失败源于测试把新结果构造成 literal 旧历史时仍保留新 call presentationContext；仅在这些历史构造点删除新 sidecar，原结果 bytes/hash 断言未改，生产归属验证未放松。剩余 1 个为 renderer import 缺 `.ts` 后缀。
- 修正后只重跑失败子集：`legacy-fixtures-green.log` 10/10；`final-failed-subset-green.log` 13/13（自动分组 6 + 新核心链 7）。`final-failed-subset.log` 保留沙箱 realpath/EPERM 环境失败；同命令正常权限通过。
- `typecheck-final.log`：`npm run typecheck` exit 0。
- 隔离 Electron UI：`ui.log` 7 checks；`automatic-ui.log` 12 checks。覆盖恶意模型 reason、未知 code、missing-only、mixed false/0/NA、旧无元数据、无 slots 初始拒绝、UNKNOWN 优先与禁用、现有导航和实际禁用原因。全部本地 mock，禁止 HTTP；不使用真实数据库、真实付费、Amazon 或打印。

## 边界

未进行真实付费/API/上架验收；未自行运行完整测试、构建或发布。本次验证不能代替协调者的最终全量及独立审查。广泛视觉优化不在本项范围。旧记录不能追认 typed producer 原因，不能用旧自由文本推断 RULE 或字段根因。

## SPEC 复审修复（2026-10-11）

- P2-1：队列投影新增有限 `noticeCode` 与 `continuationRequired`，保留规则/来源/配方/草稿/定价/图片证据变化、已核对 UNKNOWN、读取失败及继续/取消原任务的固定说明。COMPLETED/SUBMITTED 按可信 typed kind 展示正常完成/待回读信息；不恢复任何自由错误文本。
- P2-2：图片规划调用的可选 presentationContext 现在记录实际 workflowId（仅由内部 imagePlan 工作流调用传入）。失败原因同时核对实际 workflowId 和 run/slot 冻结 context hash；不能把同 owner 的另一上下文或另一工作流调用移接。内容阶段要求 run.contentPreparation.operationId 指向的真实 completion journal 中存在准确已发送 call 与冻结 round.contextHash；没有准确持久化请求范围时保持未归因。读取、自动任务引用和备份走同样验证，不重新计算当前事实。
- presentationContext 是 v1 拒绝信息的可选伴随契约，扩展字段严格解析；未改变模型 JSON、evidence 版本或原始历史 bytes/hash。
- 正式红证据 `spec-red.log`：两项产品断言失败，分别为完成状态变历史无法归因、跨 context 失败调用未拒绝。
- 定向相关 `spec-related-green.log`：127 tests / 126 pass / 1 fail；唯一失败是原 synthetic legacy 流程夹具无法承载 contentPreparation，改为合法 seven-slot 流程和真实 completion journal 后 `spec-core-green.log` 9/9。未放宽旧记录 validator。
- 实际图片持久链 `spec-image-final.log` 3/3，增加同 owner 外来 context 和外来 workflow 的持久读取/备份拒绝断言，原调用数/生成 0 保留。
- 合同与分组回归 `spec-contracts-green.log` 通过；`spec-typecheck-final.log` exit 0。UI 新增实际 AutomaticPage 完成、待回读、过期重新评估、原任务指引检查，见 `spec-ui.log`。
- 未重复全量或 443 长组，未进行真实业务调用。
- 最终核心 `spec-core-final.log` 9/9（追加错 journal call 的读取与备份拒绝）；合同回归 22/22。最终隔离 AutomaticPage UI `spec-ui.log` 13/13、exit 0，含新增状态 delta。实现再次冻结，交同一 SPEC 复审。

## QUALITY 复审修复与最终全量失败夹具（2026-10-11）

- QUALITY P2 红测 `quality-red.log` 使用实际 AiService + CompletionJournal：FAILED/FIELD_FORMAT_INVALID 仍对应 sent/no-result journal UNKNOWN，原进度读取未提供未知投影。
- 新增只读 `ImageWorkflowProgress` / `getProgressPresentation`：按精确 operationId 检查 journal owner，调用既有 journal.unknown()，将 `resultUnknown` 仅投影到进度 IPC 与既有未知重试返回。内部 getProgress、持久 run shape、journal 状态、发送与重试许可不变。STARTED 未发送及已完成 journal 为 false；旧 STARTED 无 operationId 保留既有未知保护。
- ImageSlotProgress 在固定细因之前使用该未知投影；全 PENDING 和无 slots 也显示未知指引，不增加任何重试入口。真实读取测试验证 run/journal 原始内容不变、读取不产生请求，错误 owner 被拒绝。
- 父最终全量日志 `artifacts/actionable-reasons-final-full.tap`：2079 tests / 2072 pass / 6 fail / 1 skip。6 项均为两个历史测试文件从新结果构造 v0/v1/v2 字面历史时残留 fieldRejections/presentationContext；仅构造点移除当时不存在的新侧车，原 raw/hash 及当前拒绝断言不变。生产 reader 未放宽。
- 最终定向：`quality-legacy-green.log` 两历史文件 73/73；`quality-core-final.log` 核心与真实 journal 投影 10/10；`quality-projection-regression.log` 自动准备与工作流 records 24/24；`quality-permission-regression.log` 现有 unknown/retry/progress 9/9。
- 隔离 UI `quality-ui.log` 10/10，含真实 consumer 的字段 UNKNOWN 覆盖、无 slots、known 控制组和原重试禁用断言；零网络/真实业务/付费操作。`quality-typecheck-final.log` typecheck exit 0。
- 未重跑全量或长相关组。实现再次冻结，交 QUALITY 及窄历史夹具复审。


## 协调者最终验收

- SPEC 两项 P2（正常队列提示被抹去、同 SKU 不同工作流的失败调用范围）与 QUALITY 一项 P2（图片进度遗漏字段 journal UNKNOWN）已修复，原审查者独立窄探针复审均 PASS；保留原红日志。
- 首轮全量 2079 项：2072 通过、6 失败、0 取消、1 跳过，256436.6771 ms。六项失败来自两个 literal 旧字段记录测试文件构造旧版本时残留新 sidecar；构造前提修正后 73/73，独立审查确认原 JSON 字节、哈希、当前拒绝和篡改备份保护断言未放宽。
- 最终 `node --test --test-concurrency=4 --test-timeout=180000 --test-reporter=tap tests/*.test.ts`：2080 项，2079 通过、0 失败、0 取消、1 项同 Windows 文件符号链接权限跳过，258669.8624 ms，退出码 0。相对前置分支新增正式测试 13 项。日志 `artifacts/actionable-reasons-final-full-rerun.tap/.exit`。
- 最终 `npm run typecheck` 退出码 0，隔离自动流水线 3/3；前轮隔离执行 7/7。最终原因 UI 10/10、队列 UI 13/13 为实现者隔离运行证据，后续代码无变化。审查后冻结清单 38 文件 SHA-256 核对无变化，再补本文和路线图/矩阵。
- 已完成可信拒绝原因到界面的本地链路；历史记录无法追认的细因保持未归因。UNKNOWN 提示不等于解锁重发；只读进度投影不写持久工作流。未更新已安装包、运行真实付费服务或店铺验收；下一项发布制品核验。
