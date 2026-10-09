import type { JsonObject, ListingIssue } from '../../shared/amazon-contracts.ts';
import { isObject } from './context.ts';
import { compileAttributesSchema } from './schema.ts';

/** Only absent business attributes may be deferred to Amazon's validation preview. */
export function isMissingOnlyPreview(schema: JsonObject, attributes: JsonObject, metaSchema: JsonObject = {}, localIssues: readonly ListingIssue[] = []): boolean {
  const missingCodes = new Set(['LOCAL_required', 'LOCAL_if', 'LOCAL_anyOf', 'LOCAL_oneOf']);
  if (localIssues.some(issue => issue.severity === 'ERROR' && !missingCodes.has(issue.code))) return false;
  if (!isObject(schema.properties)) return false;
  try {
    const validate = compileAttributesSchema(schema, metaSchema);
    if (validate(attributes)) return false;
    const errors = validate.errors ?? [];
    let missing = false;
    for (const error of errors) {
      // Nested value/selector/wrapper errors describe malformed supplied data.
      if (error.instancePath !== '') return false;
      if (error.keyword === 'required') {
        const field = error.params.missingProperty;
        if (typeof field !== 'string' || !Object.hasOwn(schema.properties, field) || Object.hasOwn(attributes, field)) return false;
        missing = true;
      } else if (error.keyword === 'oneOf') {
        // Multiple matching alternatives cannot be repaired by filling a missing field.
        if (error.params.passingSchemas !== null) return false;
      } else if (error.keyword !== 'anyOf' && error.keyword !== 'if') return false;
    }
    // allErrors exposes the leaves behind combinator summaries, so every leaf
    // must be a missing root business property; malformed values fail above.
    return missing;
  } catch {
    return false;
  }
}
