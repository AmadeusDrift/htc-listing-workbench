# HTC OpenRouter 接入、模型与费用讨论

核对日期：2026-10-13。状态：**新方案待确认，未切换配置、未改代码、未调用付费API。** 用户提出官方API申请困难，要求重新讨论通过OpenRouter承接原OpenAI部分。本文件补充既有交接；不把“可以考虑”记成全部方案已批准。

**后续C-060已定版：** 本文保留研究过程，不再作为待定选型。用户明确取消官方直连/旧生图中转运行接入，保留DeepSeek独立Key和阿里，采用OpenRouter并新增Batch/逐文案用途模型思考。下文“保留官方可选/旧中转过渡”的建议已被覆盖；实施以[最新完整方案](2026-10-13-2.5.0完整实施方案.md)和[接口API-R2](2026-10-13-2.5.0接口与数据契约.md)为准。

## 1. 结论与边界

公开目录已列出Luna、6.1 Sol、GPT Image 2.5 Sunburst/Flare及Luna Decisions，原模型角色不必因换入口推翻。建议改为OpenRouter账户余额+HTC专用普通调用Key，统一认证和消耗来源；不选择仍需用户上游密钥的BYOK作为本轮前提。

统一Key不等于统一协议：文本、图片、Decisions需要三个适配器。OpenRouter是网关/计费入口，模型作者仍是OpenAI；实际执行provider单独记录。账号、付款、网络、路由和模型权限需获准小额验证，目录存在不等于用户环境已连通。阿里OCR/图片风险仍独立，旧DeepSeek/中转过渡策略保持。

## 2. 模型与当前公开单价

美元计价，以下为查询时Standard列示价格，每1,000,000 tokens；不是每次、每张或每个商品售价，不含充值手续费/税费。实际所选endpoint、服务档位、缓存和计量影响账单。

| HTC用途 | OpenRouter模型ID | 输入 / 输出 | 建议 |
|---|---|---|---|
| 文案、常规文字/视觉复核 | `openai/gpt-6-luna` | 文本输入$0.10；输出$0.50 | 沿用主力角色，不选Pro或自动换模型 |
| 疑难、冲突和异常复核 | `openai/gpt-6.1-sol` | 文本输入$2.00；输出$10.00 | 仅由既定业务条件自动升级，不全量替代Luna |
| 类目真实候选、字段选项判断 | `openai/gpt-6-luna-decisions` | 输入$0.10；输出$0.00 | 使用独立Decisions接口，不用chat代替 |
| 商品七图、需要保持来源主体的编辑 | `openai/gpt-image-2.5-sunburst` | 文本输入$5；图像输入$8；图像输出$30 | 推荐先作质量对照基线；不是已实测最优 |
| 同系列速度候选 | `openai/gpt-image-2.5-flare` | 文本输入$5；图像输入$8；图像输出$30 | 可选对照；公开单位费率相同，不能称一定更便宜 |

文本缓存另计：Luna页面列缓存读$0.01/M、写$0.125/M；Sol读$0.10/M、写$2.50/M。实际请求包含缓存/推理计量时不能仅数可见文案字符。不要先按优惠Flex/Batch/Fast等不同服务档位预算，再发送Standard请求。

来源：[Luna](https://openrouter.ai/openai/gpt-6-luna)、[Sol](https://openrouter.ai/openai/gpt-6.1-sol)、[Decisions](https://openrouter.ai/openai/gpt-6-luna-decisions)、[Sunburst](https://openrouter.ai/openai/gpt-image-2.5-sunburst)、[Flare](https://openrouter.ai/openai/gpt-image-2.5-flare)。Sunburst/Flare的目录定位分别偏精确编辑与速度；HTC真实图片外观一致性仍需样本比较，不能从宣传定位推断通过率。

## 3. 费用怎么算

### 3.1 文本/决策单位示例

仅做数学示例，不是实际HTC用量预测；假定无缓存，输出数已包含本次计费的推理/可见输出，图片输入另按实际usage处理：

- Luna每次10,000输入+2,000输出：`10000/1e6×0.10 + 2000/1e6×0.50 = $0.002`；1,000次为$2。
- Sol同样计量：`10000/1e6×2 + 2000/1e6×10 = $0.04`；1,000次为$40。
- Decisions每次实际计量5,000输入：`5000/1e6×0.10 = $0.0005`；1,000次为$0.50。计量需包括服务实际计算的输入，不能只数字符串state而遗漏questions/图片。

推理token会计费，即使不返回给调用方，也计入相关输出预算；不能用“文案只有几百字”估计全部费用。[推理计量](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)。

### 3.2 图片不是固定每张报价

Sunburst/Flare公开表拆分文本输入、图像输入、图像输出。保守成本计算式：`文本输入tokens×5/1e6 + 图像输入tokens×8/1e6 + 图像输出tokens×30/1e6`，缓存按对应endpoint另算。分辨率、质量、参考图及输出计量变化会改变单张成本；未知token量时不能把单价硬换成“每张几分钱”。

HTC每最终销售SKU七图，预算敏感性示例（**下列均为假设平均单张费用，不是GPT Image报价或本轮测量**）：

| 假设平均单张成本 | 七张/销售SKU | 1000个销售SKU首次七图 |
|---|---|---|
| $0.05 | $0.35 | $350 |
| $0.10 | $0.70 | $700 |
| $0.20 | $1.40 | $1400 |

以上不含重画、文字/视觉复核、阿里服务、托管、手续费/税费。预算按销售SKU而不是来源链接；一个链接展开多个销售SKU，会产生多套图片。既有每图首次+最多两次重试可能增加图像支出，但不代表都要重试。

实施后以每次返回的 `usage.cost`（若有）记已报告费用，缺失标待确认并按可用对账能力补核；不能“请求在本机报错”就认定未收费。需要保存原响应以便只恢复下载/解析，而不是再次生成。图像文档确认响应为base64并且usage可能缺失。[图片接口](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)、[官方教程](https://openrouter.ai/blog/tutorials/image-generation/)。本轮公开图片endpoints JSON经网页工具打开未取得可读字段明细，因此不宣称已验证具体尺寸/质量枚举；接入时再通过公开目录能力检查。

### 3.3 平台手续费

官方页面当前列Standard充值手续费5.5%，Business为8%，费用在购买credits时收取，不是每次推理再重复加一次。若购买$100额度，仅按5.5%平台费举例为$105.50，税费、付款方式及实际结算另看支付页；不保证所有小额充值都按此无其他项。[方案价格](https://openrouter.ai/pricing)、[计费说明](https://openrouter.ai/business)。

HTC账本分“模型已报告消耗”“待确认/估算”“充值手续费（可选分摊）”，不在usage.cost上再重复扣费。当前没有团队合规/区域路由需求时建议先评估Standard，不默认付Business。此为方案建议，未替用户购买套餐或充值。

## 4. 三种实际接口

所有调用由Electron main使用加密保存的OpenRouter Key，renderer不持有Key。使用现有受控HTTP层即可，无需为了网关另搭服务器或新增Agent平台。统一使用Bearer认证，但base路径不相同。

| 功能 | 请求地址 | 核心格式与返回 |
|---|---|---|
| 文案/常规与疑难复核 | `POST https://openrouter.ai/api/v1/chat/completions` | `model + messages + reasoning + response_format`；读取message内容与usage |
| 七图生成/参考图编辑 | `POST https://openrouter.ai/api/v1/images` | `model + prompt + input_references`及endpoint允许参数；读取`data[].b64_json`/`media_type`/usage |
| 结构化决策 | `POST https://openrouter.ai/api/alpha/decisions` | `model + state + questions对象`；读取`answers对象`与usage，而非chat choices |

来源：[文本Quickstart](https://openrouter.ai/docs/quickstart)、[图片文档](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)、[Decisions协议](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)。不把官方OpenAI的`input/questions数组`原样发送到OpenRouter的`state/questions对象`。

### 4.1 文本请求示意（仅文档，不运行）

```json
{
  "model": "openai/gpt-6-luna",
  "messages": [
    {"role": "system", "content": "只依据给定商品资料生成英文标题，返回约定JSON。"},
    {"role": "user", "content": "这里由商品模块填入当前规格资料与完整相关规则。"}
  ],
  "reasoning": {"effort": "medium"},
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "listing_title",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": {"title": {"type": "string"}},
        "required": ["title"],
        "additionalProperties": false
      }
    }
  },
  "provider": {"require_parameters": true, "allow_fallbacks": false}
}
```

实际HTC仍传完整业务规则/任务上下文，示意标题Schema不能成为字段白名单。思考档位按模型/endpoint能力提供；不把UI保存值直接透传到不支持的provider。结构化输出路由要求支持相应参数，不能默默忽略JSON约束。[结构化输出](https://openrouter.ai/docs/guides/features/structured-outputs)。

### 4.2 图片接线

使用一个图位一个请求的现有业务粒度，`n=1`，避免七图合成一大批失去独立重试/审核预算。`input_references`传当前允许的原图或明确标识的编辑候选；参考图支持数量/尺寸/quality/passthrough从选定endpoint读取，不把官方直连`size`、`xhigh/max`等参数无条件照搬。返回原始响应与费用先登记，随后解码、校验格式/hash、保存文件、审核、采用。

建议先比较Sunburst/Flare在同一批商品资料、相同目标尺寸/质量下的实际成本、耗时与外观一致性，再确定默认图像子型号。若希望先有一个实现默认候选，推荐Sunburst作为来源保真优先的对照起点；这是推断建议，不是质量保证，也不在本轮擅自切设置。

### 4.3 Decisions接线

```json
{
  "model": "openai/gpt-6-luna-decisions",
  "state": {"sourceColor": "蓝色", "allowedValues": ["Blue", "Red", "White"]},
  "questions": {
    "color": {
      "type": "choice",
      "instructions": "选择与来源颜色一致的允许值。",
      "criteria": {"Blue": "蓝色", "Red": "红色", "White": "白色"}
    }
  }
}
```

这里只是有明确依据且候选覆盖的示意；真实类目候选来自平台，不能编productType。`choice`选一个；复选框可用各选项`noul`判断后统一检查互斥/数量/依赖，不把概率最高的若干项随便拼起来。无依据、拒绝、候选不覆盖继续走业务异常/疑难复核，不强行选一个，也不自动把置信度当客观真实性。

该端点使用alpha路径，需要独立能力检测/错误/恢复，不将其他请求失败都重试成chat。图像作为Decisions输入时，文档要求base64 data URL置于state顶层数组，远程HTTP图片不会自动抓取；不能只传1688图片地址就以为看到了图。[多模态Decisions](https://openrouter.ai/docs/guides/community/multimodal-decisions)。

## 5. 路由、设置与用量

建议采用明确模型ID和标准服务档位，不使用`auto`或`latest`替用户随机选模型；初期对支持的接口固定经过验证的provider，关闭自动fallback，故障由HTC已定恢复策略处理。若后续要多provider容灾，另行确认允许名单/能力/价格范围，并记录实际provider。不要假设Decisions支持与Chat/Images完全相同的provider参数；按各端点合同实现。

模型Key、网关、上游provider、实际model、服务档位、request ID、attempt/业务operation、原响应引用和cost都入调用记录。`GET /api/v1/key`能返回当前Key的总/日/月使用量及limit_remaining；它是Key额度，不等于公司账户余额。用HTC专用Key更容易与本地ledger核对，不需要为只看本Key而要求管理Key。[当前Key接口](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key)。

设置建议：一个“OpenRouter连接”保存Key，下面选择文案/常规/疑难/Decisions/图片型号及支持参数；图片业务开关仍在图片模块。用量默认HTC自己的请求记录，平台Key用量用于对账；充值手续费另列。保存连接不发生成请求；阿里配置和旧接入兼容区保留。OpenAI直连降为以后可用的可选适配，不成为本轮前置申请条件（该变更待用户确认）。

## 6. 对原实施/交接的影响

若用户确认该路线，主要改W05/W07/W12/W13及对应验收，其他模块分工不变：

1. W05新增 `openrouter-chat.ts`、`openrouter-decisions.ts`、`openrouter-images.ts` 三类适配与共享transport/vault，不把OpenRouter藏在“OpenAI官方连接”标签下。
2. 配置中 `gateway='openrouter'`、`modelAuthor='openai'`、`provider`分离；旧provider与新Key独立，历史配置/原请求继续可解释。
3. image/Decisions格式按上述合同映射到既定通用receipt与业务结果，保留unknown、预算、先收据后采用。恢复下载失败不新发生成。
4. 增加文本schema拒绝、provider不支持参数、alpha端点不可用、额度不足、限流、base64缺失、usage缺失、请求已发送超时、同operation去重等离线合同用例。
5. 真正接入前获准小额核验账号/网络和参数，随后用真实来源图做小样比较；没有这种核验不能宣布平台迁移完成，旧接入不能提前删除。

当前旧交接包的直连实施细节已加“选型重新讨论”的提示，但没有替换成已批准OpenRouter方案，也没有消息发给另一Codex或暂停其任务。若用户已把旧指令交给执行者，应将本讨论结论确认后再转发补充，避免按旧选型继续锁死。

## 7. 建议收口的选择

- 建议OpenRouter作为原OpenAI部分的主入口，普通账户余额模式，保留既定Luna/Sol职责和独立Decisions。
- 图像建议Sunburst作为首个质量对照候选，Flare可选择；是否立即定默认或先小样对比由用户决定，不自动做付费实验。
- 阿里及旧DeepSeek/中转过渡规则不变；官方直连是否继续保留为可选适配，与当前无需申请直连密钥分开。
- 费用先采用平台已报告cost+本地归因，图片按实测建立每SKU预算，不能把假设单张成本写死。

以上待用户看过后确认。本轮只公开资料研究/文档维护，无账号访问、充值、API Key读取、模型调用、代码修改或测试。
