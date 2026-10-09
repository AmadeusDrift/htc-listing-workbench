import type { AmazonTarget } from './amazon-contracts.ts';

/** Supported marketplace metadata shared by validation and the connection form. */
export const AMAZON_MARKETPLACES: Record<string, [AmazonTarget['region'], string]> = {
  ATVPDKIKX0DER: ['na', '美国'], A2EUQ1WTGCTBG2: ['na', '加拿大'], A1AM78C64UM0Y8: ['na', '墨西哥'], A2Q3Y263D00KWC: ['na', '巴西'],
  A1F83G8C2ARO7P: ['eu', '英国'], A1PA6795UKMFR9: ['eu', '德国'], A13V1IB3VIYZZH: ['eu', '法国'], APJ6JRA9NG5V4: ['eu', '意大利'], A1RKKUPIHCS9HS: ['eu', '西班牙'],
  A1805IZSGTT6HS: ['eu', '荷兰'], A2NODRKZP88ZB9: ['eu', '瑞典'], A1C3SOZRARQ6R3: ['eu', '波兰'], AMEN7PMS3EDWL: ['eu', '比利时'], A28R8C7NBKEWEA: ['eu', '爱尔兰'],
  A33AVAJ2PDY3EV: ['eu', '土耳其'], A21TJRUUN4KGV: ['eu', '印度'], A2VIGQ35RCS4UG: ['eu', '阿联酋'], A17E79C6D8DWNP: ['eu', '沙特阿拉伯'], ARBP9OOSHTCHU: ['eu', '埃及'], AE08WJ6YKNBMC: ['eu', '南非'],
  A1VC38T7YXB528: ['fe', '日本'], A39IBJ37TRP1C6: ['fe', '澳大利亚'], A19VAU5U5O7RUS: ['fe', '新加坡'],
};
