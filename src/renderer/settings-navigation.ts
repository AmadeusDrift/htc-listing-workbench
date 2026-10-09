export const settingsModules = [
  ['amazon', '店铺连接'], ['collection', '采集连接'], ['ai', 'AI 连接与用量'],
  ['images', '图片与生图'], ['hosting', '图片托管'], ['labels', '商品标签'], ['product', '商品规则'], ['sku', 'SKU 命名'], ['pricing', '定价与组套促销'],
  ['appearance', '外观与交互'], ['data', '本地数据与备份'], ['diagnostics', '诊断与关于'],
] as const;
export type SettingsModule = typeof settingsModules[number][0];
