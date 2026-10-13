import { parseSync } from 'rolldown/utils';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';

// AST inventory, not a claim that SQL ownership or computed imports are proven safe.
const root = resolve('src');
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.tsx?$/.test(path)) files.push(path);
  }
}
walk(root);
const graph = new Map(files.map(file => [file, new Set()]));
const writes = [], unresolved = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const parsed = parseSync(file, source);
  if (parsed.errors.length) throw Error(`Cannot parse ${file}: ${JSON.stringify(parsed.errors)}`);
  const edge = node => {
    if (!node || typeof node.value !== 'string') { unresolved.push(relative(root, file)); return; }
    if (!node.value.startsWith('.')) return;
    const base = resolve(dirname(file), node.value);
    const target = [base, base + '.ts', base + '.tsx', resolve(base, 'index.ts')].find(path => graph.has(path));
    if (target) graph.get(file).add(target);
  };
  const visit = node => {
    if (node.type === 'ImportDeclaration') {
      if (node.importKind !== 'type' && (!node.specifiers.length || node.specifiers.some(e => e.importKind !== 'type'))) edge(node.source);
    }
    if (['ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source && node.exportKind !== 'type'
      && (!node.specifiers?.length || node.specifiers.some(e => e.exportKind !== 'type'))) edge(node.source);
    if (node.type === 'ImportExpression') edge(node.source);
    if (node.type === 'Literal' && typeof node.value === 'string' || node.type === 'TemplateLiteral') {
      const sql = source.slice(node.start, node.end);
      for (const match of sql.matchAll(/\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+([a-z_][a-z_0-9]*)/gi)) {
        writes.push({ file: relative(root, file).replaceAll('\\', '/'), line: source.slice(0, node.start).split('\n').length, table: match[1] });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) { for (const child of value) if (child?.type) visit(child); }
      else if (value?.type) visit(value);
    }
  };
  visit(parsed.program);
}
let next = 0;
const index = new Map(), low = new Map(), stack = [], active = new Set(), cycles = [];
function connect(file) {
  index.set(file, next); low.set(file, next++); stack.push(file); active.add(file);
  for (const target of graph.get(file)) {
    if (!index.has(target)) { connect(target); low.set(file, Math.min(low.get(file), low.get(target))); }
    else if (active.has(target)) low.set(file, Math.min(low.get(file), index.get(target)));
  }
  if (low.get(file) !== index.get(file)) return;
  const component = []; let member;
  do { member = stack.pop(); active.delete(member); component.push(relative(root, member).replaceAll('\\', '/')); } while (member !== file);
  if (component.length > 1 || graph.get(file).has(file)) cycles.push(component.sort());
}
for (const file of files) if (!index.has(file)) connect(file);
console.log(JSON.stringify({ files: files.length, cycles, unresolvedDynamicImports: unresolved, sqlWriteCandidates: writes }, null, 2));
if (process.argv.includes('--strict') && (cycles.length || unresolved.length)) process.exitCode = 1;
