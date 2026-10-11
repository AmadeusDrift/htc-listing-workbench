# 2026-10-12 C2：平台预览字段反馈

- Haul 本地 Schema 缺项、枚举、条件/组合及字段值约束保留诊断，但可进入 VALIDATION_PREVIEW；以平台具体反馈定向补填。完整Schema不裁剪，普通standard沿用原检查。
- 保留 LOCAL_type、Schema不可解析、marketplace_id/language_tag/media_location结构、店铺/SKU/来源/事实冲突、文案政策、图片URL和未知提交保护。预览VALID仍须绑定当前修订/Schema/凭据和时效，不能跳过预览正式发布。
- 执行上传前与validate、AI原生候选、图片阶段及旧remaining使用一致判定；平台或demo返回的同名错误不忽略。HTTP/限流等错误不转为AI商品补写。
- 资格判断读取全部Schema错误，避免展示前100条时漏掉后面的结构错误；demo仍对实际无效Schema返回INVALID，不冒充平台接受。
- 验证：107项定向回归、类型与独立审查通过；完整2184项：2183通过、1跳过、0失败（artifacts/c2-full.log）。模拟平台VALID可提交，demo INVALID不提交，未知提交既有回归通过。
- 未验证真实Amazon反馈或成功率；真实批次、工作区数据与监控保持原状。
