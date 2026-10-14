# OpenRouter 自动提供商路由定向修复

用户确认：保留所选模型，由 OpenRouter 在符合请求参数的提供商之间路由，事后展示实际模型/提供商。未返回信息不猜测。不调用真实付费接口，不操作真实任务。

## 实现
- chat、Decisions、images、Batch 移除 only=openai 和禁用回退；allow_fallbacks=true、require_parameters=true，不发送 models 备用模型列表。现有请求身份、Batch 远端身份和 UNKNOWN 锁不变。
- OpenRouter 401 仍为凭据错误；明确地区 403 使用 MODEL_REGION_RESTRICTED，其余 403 使用 ROUTING_FORBIDDEN。仅固定文案跨 IPC，不展示服务商任意错误文本。
- OpenRouter 403 不再作为换 Key 的认证重试证据；DeepSeek 原有证据规则保留。
- 仅历史 AUTH_FAILED 且原始收据确认为该模型地区拒绝，可在用户晚于原请求完成时间显式继续后，按当前自动路由策略补一次尝试。验证调用/模型/渠道/状态、文件大小和 SHA256；保持原三次上限与历史，不重置额度。新地区拒绝不会再次按此兼容规则重试。任何较早 UNKNOWN 仍阻止继续。
- 新地区/路由拒绝在来源、字段、图片规划中是明确失败，不标记为 UNKNOWN；字段与图片规划重新进入时保留具体失败并阻止重复 POST。

## 隔离证据
- 修改前 chat/images/Decisions 路由和地区分类新断言失败；历史地区接续测试 count=1 而预期2，复现阻塞。
- 83 项定向测试全部通过：OpenRouter chat/images/Decisions/Batch/service、来源观察、字段边界；包含 Batch 创建未知、乱序、旧未知请求、换Key和预算保护。
- 补充2项旧地区接续/无匹配证据拒绝测试通过。
- 新增字段/图片规划地区拒绝无重发、原 UNKNOWN 保护和 Batch 原身份回收共11项通过。Batch 接续的提供商策略识别同步更新，不能因策略变更退回普通调用。chat 请求增加官方 X-OpenRouter-Metadata: enabled 头，其他协议不发送。
- npm run build（包含 typecheck）通过；现有前端 chunk 大小警告仍存在。
- 原始业务数据、运行任务、用户密钥未读取/修改；所有服务响应使用假服务。在线模型/提供商可用性、实际费用与质量未验证。

实际模型/提供商记录与 UI 由并行独立分支交付，根进程合并后联合验证；本文不宣称在线成功或整包已交付。
