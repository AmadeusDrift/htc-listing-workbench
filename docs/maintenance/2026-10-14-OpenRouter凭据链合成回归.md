# OpenRouter 凭据链合成回归（2026-10-14）

基线：75f2fbe；独立分支：test/openrouter-key-pipeline。本项仅增加测试与记录，不改变渠道、凭据格式规则或运行程序，不读取真实密钥与数据库，不发起真实网络请求。

## 调查范围与结论

针对当日来源理解步骤的 OpenRouter 401 现象，检查 UI 保存、IPC、vault、用途选择及 Bearer 链路。未发现足以解释实际 401 的已证实代码缺陷；合成测试通过不代表实际服务身份有效。

- UI 按 vendor 重挂载；密钥输入初始为空、保存后清空，没有把已保存值或遮罩填回输入框。
- saveConnection 按供应商分组写入；vault 文件和包络绑定 provider ID 与 generation。source_understanding 按用途 gateway 选择 provider，并在请求前读取对应版本凭据。
- 共享凭据轮换增加 generation、取消旧请求；没有发现请求侧长期保存旧 Key 的缓存。旧版本凭据读取被拒绝。
- 空值与空白保存被拒绝；修改模型/启停保留密钥。显式复用不允许跨供应商。没有自动 DeepSeek→OpenRouter 凭据迁移。
- 生图连接保存非空 Key 会通过共享端口更新同一 OpenRouter 连接；该设计入口不经过 ai-ipc 的 ai.connection.saved 审计。此次是否使用该入口，需要非敏感运行审计证据。
- 当前只进行字符串格式校验，不验证账户身份。未增加未确认的 Key 前缀或遮罩过滤规则。

## 可重复验证

新增 tests/openrouter-key-pipeline.test.ts 三项回归，使用随机临时目录、合成字符串与测试 AES 存储。服务 fetch 禁止外部传输，HTTP 适配器仅注入本地 Response：

1. 共享保存与服务重启后，OpenRouter/复核读取本供应商 Key，DeepSeek/复核保持另一组 Key；公开连接元数据不含 Key。
2. source_understanding 选择 OpenRouter；轮换前后 Bearer 分别匹配预期合成 Key；旧 generation 拒绝；重启后仍读新 Key，另一供应商不受影响。
3. 空值、空白与跨供应商复用被拒绝，原有 Key 和 metadata 保持。

验证命令（在独立工作树、require_escalated 上下文）：

```text
node --test tests/openrouter-key-pipeline.test.ts tests/openrouter-service.test.ts tests/openrouter-chat.test.ts tests/credential-lifecycle.test.ts tests/ai-settings-ipc.test.ts tests/credential-status-ui.test.ts
```

结果：27 项通过、0 失败、0 跳过；真实请求 0。

此前在默认沙箱下运行既有四个文件得到 21 项中 18 通过、3 失败。三个失败位于 openrouter-service.test.ts，表现为 PROVIDER_ERROR、OUTPUT_INVALID/RESPONSE_READ_FAILED（合成响应 status 200）、SOURCE_CHANGED（合成来源图）。同一未改动文件在基线工作树 require_escalated 单独重跑 4/4 通过；在新工作树关联运行仍全部通过。证据支持执行上下文导致差异，不将原先沙箱失败归为生产认证失败；未进一步断言具体底层系统调用。

## 尚未验证

未对真实账户身份、Key 内容或供应商服务端状态作判定。另一路离线 Electron 检查的解密失败可能涉及数据视图/安全上下文，不能据此断言用户运行进程中的密钥损坏。本回归没有读取这些真实文件。未运行完整回归或真实业务验收，未发布或覆盖安装包。
