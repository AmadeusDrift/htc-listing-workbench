// Fully synthetic IDs/content. No real receipt, SKU, account or image bytes.
export const judgeNull = { kind:'category-decision', phase:'judge', keywords:[], productType:null, reason:'Synthetic no selection', ambiguous:false };
export const allowedAsset = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa9a2';
export const wrongAsset = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa9e2';
export const wrongAssetOutput = { kind:'source-image-consistency', version:'source-image-consistency/v2', assets:[{assetId:wrongAsset,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Blue'],appearance:['Round'],claims:[],observations:[]}] };
export const mixedKit = { spec:'支架＋贴片＋50只过滤网', colors:['黄色','米色'], quotedCny:8.2 };
export const slowBody = { delayMs:31_000, outerTimeoutMs:60_000, body:{id:'synthetic_slow',usage:{cost:0.01},choices:[]} };
