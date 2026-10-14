# 2026-10-14 Decisions 图片 detail 参数修复

## 根因与边界

类目选择的 Decisions 请求复用了 DeepSeek 视觉内容构造器，其 `detail: original` 不在 Decisions 接口允许的 auto/low/high 中，导致 HTTP 400。已对照官方 https://openrouter.ai/docs/guides/community/multimodal-decisions （2026-10-14）及 API schema核对。

Decisions 专用路径选择 high；原始图片字节、哈希、尺寸及本地来源校验不变，其他调用保持 original。Decisions 发送边界增加枚举与内联图片格式校验，非法值在请求前停止。

## 验证

新增真实 AiService + 合成商品图片 + 假服务契约测试：修复前模拟官方400失败，修复后通过，并逐字节比对发送的原图。未读取凭据或真实库，未请求付费接口。30项相关测试全通过，typecheck与strict模块边界检查通过。Windows 默认沙箱造成 managed-image 路径身份检查失败，使用获准的本机隔离测试执行通过；未降低生产路径校验。

## 接续核对

原有类目流程仅在全部阶段完成后持久化 classification；`classifyProduct` 每次重新走 keywords，`AiService.decideCategory` 无阶段恢复。因此这条400不依赖403许可即可再次进入类目判断，但必须由集成修复继续核对成功关键词复用及未知类目请求防重发，不能把当前参数修复等同完整接续保证。本分支不清历史、不改任务、不解锁UNKNOWN。
