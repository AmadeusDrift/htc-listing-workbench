import type { AmazonDraft, JsonObject, JsonValue } from '../../shared/amazon-contracts.ts';
import type { ExecutionItem } from '../../shared/execution-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';

export function imageFields(draft: AmazonDraft, count: number): string[] {
  function hasImageValue(value: JsonValue, path: string[]): boolean {
    if (typeof value === 'string') return path.some(key => /image|media_location/i.test(key)) && /^(?:\w+:|\/\/)/.test(value);
    if (Array.isArray(value)) return value.some(child => hasImageValue(child, path));
    return !!value && typeof value === 'object' && Object.entries(value).some(([key, child]) => hasImageValue(child, [...path, key]));
  }
  for (const [key, value] of Object.entries(draft.attributes)) {
    if (key !== 'main_product_image_locator' && !/^other_product_image_locator_[1-9]\d*$/.test(key) && hasImageValue(value, [key])) throw new UserFacingError('草稿包含当前任务无法托管的额外图片字段，请人工核对后移除或单独处理');
  }
  const properties = draft.schema.schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties) || !Object.hasOwn(properties, 'main_product_image_locator')) throw new UserFacingError('当前 Schema 不支持主图字段，请人工核对类目');
  const gallery = Object.keys(properties).filter(k => /^other_product_image_locator_[1-9]\d*$/.test(k)).sort((a,b) => Number(a.split('_').at(-1)) - Number(b.split('_').at(-1)));
  if (count > gallery.length + 1) throw new UserFacingError('已确认图片数量超过当前 Schema 的图片字段范围，请人工调整');
  return ['main_product_image_locator', ...gallery].slice(0, count);
}
export function hostedAttributes(draft: AmazonDraft, item: ExecutionItem): JsonObject {
  const fields = imageFields(draft, item.assets.length), attributes = structuredClone(draft.attributes);
  for (const key of Object.keys(attributes)) if (key === 'main_product_image_locator' || /^other_product_image_locator_\d+$/.test(key)) delete attributes[key];
  for (const [index, asset] of item.assets.entries()) {
    const uploaded = item.uploads.find(u => u.assetId === asset.id && u.sha256 === asset.sha256);
    if (!uploaded) throw new UserFacingError('有图片尚未完成托管验证');
    attributes[fields[index]] = [{ marketplace_id: draft.marketplaceId, media_location: uploaded.publicUrl }];
  }
  return attributes;
}
