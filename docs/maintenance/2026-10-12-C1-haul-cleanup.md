# 2026-10-12 C1：Haul 三字段自动清理

- 统一仅清理 fulfillment_availability、externally_assigned_product_identifier、merchant_suggested_asin。完整Schema继续传入AI，并附明确项目规则；原AI结果、来源与旧采纳历史不改写。
- 新草稿、规则应用、保存、采纳及旧草稿验证接入同一清理；记录原因，修改后旧预览失效。standard 不受影响，其他项目/来源/安全错误继续独立处理。
- 采纳不把清理字段计入新adoption changes；重复采纳保持幂等。预览清理原子更新当前completion检查点，成功及允许继续的异常路径重新读取日志版本。
- 执行任务清理先写意图哈希、再保存草稿，再记录实际哈希。保存后中断可恢复，已保存图片资产保持。
- 验证：80项相关回归、类型检查与独立审查通过；完整2178项，2177通过、1跳过、0失败（artifacts/c1-full.log）。覆盖原响应保留、旧草稿与重复验证、保存后中断恢复。
- 未运行真实Amazon、FTP、AI或暂停批次。C2另行调整字段预检。
