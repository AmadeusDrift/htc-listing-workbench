# OpenRouter 实际调用身份记录（2026-10-14）

用户确认：固定所选模型，允许 OpenRouter 自动选择可用提供商；显示本次实际模型和实际提供商。缺失数据不能猜测。

## 实现

- 回执索引追加可选 executionIdentity，不改原响应文件、不迁移或补写历史记录。新读器兼容无此字段的历史回执。
- 依据官方 Router Metadata 文档（https://openrouter.ai/docs/guides/features/router-metadata），成功响应读取唯一成功 attempts 或唯一 selected endpoint；不把候选列表、失败尝试、请求 model 或网关名当实际提供商。存在多个成功/选中项则标未返回。响应型号可为带日期版本、路由型号可为别名，二者无需字符串相等；独立保留响应实际型号与明确成功提供商，不把合法版本差异当成提供商缺失。顶层 provider 非该文档定义字段，不据此认定实际服务商。
- 实际型号读取响应 model；未返回时只接受唯一明确成功路由元数据型号。报错/缺少路由元数据的提供商保持未返回。
- chat opt-in header 由路由修复分支负责。图像和 Decisions 不增加未支持的 header 或查询；若其响应未报告，实际提供商如实显示未返回。
- 设置中的逐用途显示固定型号、提供商自动选择策略。已提交批次仍保留其已发送请求。
- 用量明细增加默认折叠的逐次记录，包含请求/响应时间、所选/实际模型、实际提供商、结果与 HTTP 状态，支持当前日期范围最新 100 条并显示总量。读取沿用现有手动按钮，不增加后台轮询或网络查询。
- 生图请求记录与文本、Decisions、Batch 通过现有统一收据报告关联。HTTP 200 仅标收到响应，不等于图片已采用或上架成功。

## 隔离验证

- 最初新增测试在未实现时确认缺少 executionIdentity 失败（沙箱硬链接限制另经隔离提升复核）。
- `node --test tests/openrouter-call-identity.test.ts tests/openrouter-service.test.ts tests/provider-receipt-recovery.test.ts tests/ai-usage-report.test.ts`：12/12 通过。
- `npm run typecheck`：通过。
- `node scripts/e2e-openrouter-call-identity.mjs`：通过；隔离 Electron 禁止 HTTP/HTTPS，验证折叠展开、真实/所选型号区分、未返回、403、手动刷新，以及模拟两分钟无自动刷新。
- 密钥回显响应在进入收据索引前被原传输保护替换为省略标记；额外测试确认未进入实际身份。
- 未调用真实接口，未改真实任务/数据库，未验证真实账号地区可用性。独立旧版本读器不认识新增可选字段，回退需匹配升级前备份。

## 审查补修

新增响应日期版本与路由别名不同的失败用例，确认此前会丢失实际提供商；移除字符串相等限制，仍要求唯一成功/选中项且其型号和提供商均是合法字符串。损坏的型号元数据仍不认定提供商。再次通过全部 12 项、类型检查及离线 UI 验证。
