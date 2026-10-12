/** Supplier instructions and explicit random fulfillment are different meanings.
 * Unknown model codes and an ordinary choice/mixture alone are not exclusions. */
export function supplierInstructionOption(value:string):boolean {
  const command=/(?:不支持|不能|不可|不接受)(?:指定|选择|选色|选款|选)|(?:请|需要|需)(?:备注|咨询|联系)|勿拍|仅供说明/gu;
  if(!command.test(value))return false;command.lastIndex=0;
  return !value.replace(command,'').replace(/底座|包装|颜色分类|颜色|色号|款式|发货|随机|默认|客服|[\s:：,，;；。!！()（）-]/gu,'').trim();
}
export function explicitRandomFulfillment(value:string):boolean {
  const positive=value.replace(/(?:不是|并非|不|非)\s*随机(?:发货|发送|配送|颜色|款式|图案|型号)?/gu,'').replace(/\b(?:not|non)[ -]random(?:ly)?\b/giu,'');
  return /随机\s*(?:发货|发送|配送|颜色|款式|图案|型号)|(?:颜色|款式|图案|型号)\s*随机|\brandom(?:ly)?\s+(?:shipped|sent|delivered|colou?rs?|styles?|designs?)\b/iu.test(positive);
}
