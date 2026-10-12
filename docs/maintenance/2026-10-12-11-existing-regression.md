# 2026-10-12 第11项：既有修复定向回归

## 范围与结论

核对 R01/R02 字段解析和原始响应恢复、R03/R16 当前规则依据及历史键序、R22 Haul 三字段清理，与本轮颜色、Generic、来源恢复、AI有限重试和定价本地刷新共同工作。既有覆盖足以验证本项已识别风险，未重建旧修复、未添加重复测试、未扩展第13–21项。

本项是离线代码回归；不代表原19份响应、32个旧事实异常或真实上架任务已恢复成功。

## 覆盖证据

| 范围 | 现有测试与检查重点 |
|---|---|
| R01/R02 | `listing-field-normalization`、`listing-normalization-history`、`listing-local-recovery`：保留原文与转换来源；精确Schema类型；事务回滚；重启/备份后复用响应且不增加调用/账本；来源变化不采纳旧内容。 |
| R03/R16 | `legacy-fact-authority-resume`、`business-default-authority`：当前规则权限、JSON键序、真实值优先、历史DONE操作及owner中断恢复；保持操作ID、次数与独立平台错误；未知请求不冒充已解决。 |
| R22 | `amazon-listing-program`、`image-business-reuse`：只清理三个已确认不支持字段，留其他属性、原因和程序边界；重复验证不重复修订；规则填报与Haul清理不破坏可证明的图片兼容性。 |
| 本轮交互 | `generic-brand-resume`、`plain-color-resume`：缓存DONE的普通颜色本地刷新保留原平台响应、人工品牌问题、图片槽位及预算；`source-image-consistency-service/history` 保留响应、归属及三次预算，不将损坏回执当成缺失结果重发。 |
| 定价持久化 | `automatic-pricing-resume`：草稿和owner同事务、提交后中断重启、事务内回滚、ACTIVE/FIELDS_STARTED保护、外部草稿变动拒绝继承恢复证明。 |

## 本代理实际验证

所有文件系统测试使用授权宿主环境，临时工作区及模拟provider；未绕过文件安全检查。

1. 基线 `066847e`（已审查1–7/9/10）：12个文件，150项中149通过、1跳过、0失败。
   文件：`listing-field-normalization.test.ts`、`listing-normalization-history.test.ts`、`listing-local-recovery.test.ts`、`listing-local-recovery-evidence.test.ts`、`legacy-fact-authority-resume.test.ts`、`business-default-authority.test.ts`、`amazon-listing-program.test.ts`、`image-business-reuse.test.ts`、`generic-brand-resume.test.ts`、`plain-color-resume.test.ts`、`source-image-consistency-service.test.ts`、`source-image-consistency-history.test.ts`。
   本地日志：`.test-data/item11-existing-regression.log`（不入库）。
   唯一跳过为私有历史19份响应条件测试：隔离工作树无原始数据库/诊断目录；不得记成19份真实响应验证通过。最初一次命令因日志目录不存在未启动Node，建立目录后完整运行得到上述结果。
2. 合并定价后的 `e88501f`：针对受影响的7文件重新验证64/64通过，无跳过。
   文件：`automatic-pricing-resume.test.ts`、`legacy-fact-authority-resume.test.ts`、`business-default-authority.test.ts`、`amazon-listing-program.test.ts`、`image-business-reuse.test.ts`、`generic-brand-resume.test.ts`、`plain-color-resume.test.ts`。
   本地日志：`.test-data/item11-post-pricing.log`（不入库）。

## 独立审查记录

- 第7项 `c11c918`：规格及质量审查通过。另独立运行 completion、backup、boundary、owners 四文件82/82通过，覆盖实际子进程中断、三次发送与固定两轮预算、备份单调保留、未发送替代请求、真实owner和Amazon提交保护。集成保留来源恢复后续安全修复。
- 第8项初版 `3f72630`：规格符合；发现草稿持久提交与自动owner检查点分离的P1中断窗口，要求整改。
- 第8项整改 `1de81a3`：同事务写入持久 `pricingRefresh` 证明，重启先对齐owner再判断报价，跳过进行中字段操作；独立运行5项实际持久化测试全部通过，规格及质量审查通过。上述64项又在合并版本验证，未仅依赖作者测试报告。

完整测试、构建、候选EXE、安装包更新及真实任务验收由主线程按授权范围处理。本项未启动真实AI/平台请求、恢复真实任务、push或发布；保留原数据库、原始响应和已有图片。
