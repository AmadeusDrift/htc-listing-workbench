# HTC 稳定化修复路线图

日期：2026-10-10。基于合并后的源码与现有审查记录；本轮只制定计划，没有开始业务修复。

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

- [ ] 确认 Git 状态干净，从集成分支创建 `test/stability-baseline`，记录 HEAD、Node/npm 版本及已有安装包信息。
- [ ] 运行 `npm run typecheck`，输出保存至忽略的 artifacts 目录；退出码必须为 0。
- [ ] 运行 `node --test --test-concurrency=4 --test-timeout=180000 tests/*.test.ts`，完整记录通过、失败、取消、跳过及用时。
- [ ] 对每个失败文件单独运行；不得通过降低断言或直接增加超时掩盖问题。目录联接权限问题按已知环境问题核对。
- [ ] 新建 `docs/version-control/REGRESSION_MATRIX.md`，逐项映射原计划的 35 个编号到具体测试、是否合成/历史/真实验证、结果和缺口。没有证据就标记未验证。
- [ ] 重点复核 `tests/automatic-listing-recheck-evidence.test.ts`、`tests/listing-ai-context.test.ts`、`tests/listing-ai-completion.test.ts`、`tests/followup.test.ts`、`tests/fault-recovery.test.ts`，定位前三个核心问题已有的反例覆盖。
- [ ] 将纯基线结果脱敏记录后 commit；若有程序失败，登记独立修复项，基线记录本身不能声称系统验收通过。

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

## 先调查，再决定修改

- 默认值审计：先只读检查已有草稿的尺寸、重量、品牌、合规声明和依据，输出脱敏统计；不将真实草稿写进仓库。
- 规格图片：先统计规格自带图覆盖率、缺失及重复绑定情况。优先验证已有绑定与图像是否矛盾，再决定是否增加兄弟规格推断或人工界面。
- 图片规划修复已在 `3e2c652` 合入，复用现有回归，不重新做一遍同样补丁；完整真实上下文效果仍未验证。
- 自动重试暂不排入实施：须先完成请求边界、错误分类及调用上限设计；未知付费结果始终不得自动重发。
- 已知异常名称目录扫描警告单独调查，不与业务修复混合，也不凭名字直接删除。

## 发布与真实验收

- [ ] 类型、全量单测、受影响 E2E、隔离构建及包校验满足原稳定化计划；取消与跳过均有处理结论。
- [ ] 更新制品时记录对应源码 commit 和摘要；核对启动脚本实际启动的是新制品。
- [ ] 真实运行前明确店铺、3–5 个 SKU 白名单、调用预算及停止条件，并取得该次运行授权。
- [ ] 分开统计调用、规划完成、七图完成、正式提交、ASIN、可发现、可购买和标签完成。
- [ ] 遇到未知请求、范围外调用、重复提交风险或连续相同错误，停止扩大样本并定位；不得直接恢复整批。

## 本轮计划验证

仅文档更新：核对原稳定化计划、Git 状态与相关源码/测试入口；检查 diff 和文件链接。未修改业务代码、运行生产任务或启动全量回归。
