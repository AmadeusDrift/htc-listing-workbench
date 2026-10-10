import type { JsonObject } from '../../shared/amazon-contracts.ts';
import { attributesObject } from './context.ts';

/** Preserve absent/null, native precision, incomplete shapes and array order. */
export function pricingAttributeInputs(attributes: JsonObject): JsonObject {
  return attributesObject(Object.fromEntries(['item_package_dimensions','item_package_weight']
    .filter(field => Object.hasOwn(attributes, field)).map(field => [field, attributes[field]])));
}
