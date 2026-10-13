import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAttributes } from '../src/main/amazon/schema.ts';
test('real enum validation preserves second row JSON pointer separately from top-level ownership', () => {
 const issues = validateAttributes({type:'object',properties:{rows:{type:'array',items:{type:'object',properties:{value:{type:'string',enum:['allowed']}}}}}}, {rows:[{value:'allowed'},{value:'invalid'}]});
 const issue = issues.find(value => value.code === 'LOCAL_enum');
 assert.deepEqual(issue?.attributeNames,['rows']); assert.deepEqual(issue?.attributePaths,['/rows/1/value']);
});
test('required and escaped property paths remain exact JSON pointers', () => {
 const issues = validateAttributes({type:'object',properties:{'a/b':{type:'array',items:{type:'object',required:['x~y'],properties:{'x~y':{type:'string'}}}}}}, {'a/b':[{}]});
 assert.deepEqual(issues.find(value => value.code === 'LOCAL_required')?.attributePaths,['/a~1b/0/x~0y']);
});
