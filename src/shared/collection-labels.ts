import type { CollectionWarningCode } from './collection-contracts.ts';
export const warningLabels: Record<CollectionWarningCode, string> = {
  MISSING_TITLE: '标题未读取，入箱后补充', MISSING_SKUS: '未读取到可确认的 SKU', SKU_STRUCTURE_UNRECOGNIZED: '规格结构尚未识别，需要核对',
  MISSING_PRICE: '部分采购价未读取', MISSING_IMAGES: '未读取到图片链接', REMOTE_IMAGES_ONLY: '图片仅保存来源链接，尚未下载',
  PRICE_PRECISION_UNSUPPORTED: '高精度采购价保留在来源记录，需核对后填写', INCOMPLETE_SKU_IMAGES: '部分 SKU 没有确认的图片对应关系',
};
export const errorLabels: Record<string, string> = {
  INVALID_MESSAGE: '通信内容无效，请重新读取商品。', UNSUPPORTED_VERSION: '插件和工作台版本不一致，请使用同一测试包。',
  UNAUTHORIZED: '本地连接未授权，请重新准备并安装连接组件。', TOO_LARGE: '商品资料过大，暂时无法接收。',
  TOO_MANY_SKUS: '商品超过 200 个 SKU，本次未接收，请分开整理。', INVALID_SOURCE: '请在 1688 商品详情页点击插件。',
  INVALID_SNAPSHOT: '商品字段不完整或存在歧义，请核对后重新读取。', CAPTURE_CONFLICT: '这次采集的内容已变化，请重新读取。',
  APP_UNAVAILABLE: '未连接工作台。请启动 HTC，并在设置中准备和安装采集连接。', APP_BUSY: '工作台正在处理数据，请稍后再发送。',
  TIMEOUT: '未收到确认，请检查工作台后重试发送。重复发送不会重复建商品。', INTERNAL_ERROR: '本次接收未完成，请稍后重试。',
  CHALLENGE_PAGE: '页面需要登录或验证。完成页面提示后再读取。', PAGE_UNAVAILABLE: '无法读取当前页面，请刷新商品详情页后再次点击插件。',
  NOTHING_TO_SEND: '先读取当前商品并核对预览。',
};
