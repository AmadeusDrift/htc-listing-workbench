import {createHash} from 'node:crypto';
import {parseSync} from 'rolldown/utils';

// A bounded target inventory, not a full SQL interpreter. Tokenize quotes before comments:
// comment markers inside quoted names/values are data, and punctuation cannot disappear.
function inspectSql(sql){
 const tokens=(sql.match(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|\$\{[^}]*\}|[\p{L}_][\p{L}\p{N}_$]*|[^\s]/gu)??[])
  .filter(token=>!token.startsWith('--')&&!token.startsWith('/*'));
 const identifier=token=>!!token&&(/^(?:["'`\[]|\$\{)/.test(token)||/^[\p{L}_][\p{L}\p{N}_$]*$/u.test(token));
 const keyword=index=>tokens[index]?.toUpperCase();
 const writes=[],unparsed=[];
 for(let i=0;i<tokens.length;i++){
  const word=keyword(i);let j=i+1,operation;
  // Foreign-key actions and journal mode values are not DML statements.
  if(['UPDATE','DELETE'].includes(word)&&keyword(i-1)==='ON'&&['CASCADE','RESTRICT','SET','NO'].includes(keyword(j)))continue;
  if(word==='DELETE'&&tokens[i-1]==='='&&keyword(i-2)==='JOURNAL_MODE'&&(keyword(i-3)==='PRAGMA'||tokens[i-3]==='.'&&keyword(i-5)==='PRAGMA'))continue;
  if(word==='REPLACE'&&(keyword(i-1)==='OR'&&['INSERT','UPDATE'].includes(keyword(i-2))||keyword(i-1)==='CONFLICT'))continue;
  if(word==='INSERT'||word==='REPLACE'){
   if(keyword(j)==='OR')j+=2;
   if(keyword(j)!=='INTO'){unparsed.push(word);continue;}j++;operation=word;
  }else if(word==='UPDATE'){
   if(keyword(i-1)==='DO'&&keyword(j)==='SET')continue; // UPSERT clause, not another target.
   if(keyword(j)==='OR')j+=2;operation=word;
  }else if(word==='DELETE'){
   if(keyword(j)!=='FROM'){unparsed.push(word);continue;}j++;operation=word;
  }else if(['CREATE','ALTER','DROP'].includes(word)){
   if(keyword(j)==='TEMP'||keyword(j)==='TEMPORARY')j++;
   if(keyword(j)!=='TABLE')continue;j++;operation=word;
   if(keyword(j)==='IF'){j++;if(keyword(j)==='NOT')j++;if(keyword(j)==='EXISTS')j++;}
  }else continue;
  if(tokens[j+1]==='.')j+=2;
  const token=tokens[j];
  if(!identifier(token)||['SET','WHERE','FROM','SELECT'].includes(keyword(j))){unparsed.push(word);continue;}
  if(operation==='UPDATE'){
   let tail=j+1;
   if(keyword(tail)==='AS'){tail++;if(!identifier(tokens[tail])){unparsed.push(word);continue;}tail++;}
   if(keyword(tail)==='INDEXED'&&keyword(tail+1)==='BY')tail+=3;
   else if(keyword(tail)==='NOT'&&keyword(tail+1)==='INDEXED')tail+=2;
   // Unsupported target grammar must be reported by scanSql at literal SQL sinks.
   if(keyword(tail)!=='SET'){unparsed.push(word);continue;}
  }
  writes.push({operation,table:token.startsWith('${')?'$dynamic':token.replace(/^["'`\[]|["'`\]]$/g,'').replace(/""/g,'"').replace(/''/g,"'").replace(/``/g,'`').toLowerCase()});
 }
 return {writes,unparsed};
}
export function sqlWrites(sql){return inspectSql(sql).writes;}
function literalSql(node,source){
 return node.type==='Literal'?node.value:node.quasis.map((q,i)=>q.value.cooked+(i<node.expressions.length?'${'+source.slice(node.expressions[i].start,node.expressions[i].end)+'}':'')).join('');
}
export function scanSql(file,source){
 const ast=parseSync(file,source);if(ast.errors.length)throw Error(`Cannot parse ${file}`);
 const writes=[],opaque=[],tableSets=[];
 function visit(node,command='<module>'){
  if(node.type==='FunctionDeclaration'&&node.id)command=node.id.name;
  if(node.type==='MethodDefinition')command=node.key.name??node.key.value??'<computed-method>';
  if(node.type==='VariableDeclarator'&&['ArrowFunctionExpression','FunctionExpression'].includes(node.init?.type))command=node.id.name??'<binding>';
  if(node.type==='Property'&&['ArrowFunctionExpression','FunctionExpression'].includes(node.value?.type))command=node.key.name??node.key.value??command;
  if(node.type==='VariableDeclarator'&&['SOURCE_TABLES','CONSISTENCY_TABLES'].includes(node.id?.name)&&node.init?.type==='ObjectExpression')tableSets.push({file,name:node.id.name,tables:node.init.properties.map(p=>p.key?.name??p.key?.value??'$computed')});
  if(node.type==='Literal'&&typeof node.value==='string'||node.type==='TemplateLiteral'){
   const sql=literalSql(node,source);
   const found=sqlWrites(sql);
   if(found.length)writes.push({file,command,line:source.slice(0,node.start).split('\n').length,sql,...{writes:found}});
  }
  if(node.type==='CallExpression'&&node.callee?.type==='MemberExpression'&&['prepare','exec'].includes(node.callee.property.name??node.callee.property.value)&&node.arguments.length){
   const arg=node.arguments[0];
   if(arg.type==='TemplateLiteral'||arg.type==='Literal'&&typeof arg.value==='string'){
    if(inspectSql(literalSql(arg,source)).unparsed.length)opaque.push({file,command,line:source.slice(0,node.start).split('\n').length,expression:'unparsed SQL write: '+source.slice(arg.start,arg.end)});
   }
   if(!['Literal','TemplateLiteral'].includes(arg.type))opaque.push({file,command,line:source.slice(0,node.start).split('\n').length,expression:source.slice(arg.start,arg.end)});
  }
  for(const v of Object.values(node)){if(Array.isArray(v)){for(const c of v)if(c?.type)visit(c,command);}else if(v?.type)visit(v,command);}
 }
 visit(ast.program);return {writes,opaque,tableSets};
}
export function ownershipViolations(inventory,registry,ownerFor){
 const errors=[];
 const signatures=new Map();
 for(const set of inventory.tableSets??[]){
  const expected=registry.tableSets?.find(s=>s.file===set.file&&s.name===set.name);
  if(!expected||JSON.stringify([...set.tables].sort())!==JSON.stringify([...expected.tables].sort()))errors.push(`${set.file} unreviewed dynamic table set ${set.name}`);
  for(const table of set.tables)try{ownerFor(table);}catch{errors.push(`${set.file} unowned dynamic table ${table}`);}
 }
 for(const entry of inventory.writes){
 const signature=entry.command+'|'+createHash('sha256').update(entry.sql.replace(/\s+/g,' ').trim()).digest('hex');
 const key=entry.file+'|'+signature;signatures.set(key,(signatures.get(key)??0)+1);
 if(registry.writers[entry.file]?.statements && !registry.writers[entry.file].statements[signature])errors.push(`${entry.file}:${entry.line} changed privileged SQL ${entry.command}`);
 for(const write of entry.writes){
  const key=[entry.command,write.operation,write.table].join('|');
  if(!registry.writers[entry.file]?.commands.includes(key))errors.push(`${entry.file}:${entry.line} unregistered ${key}`);
  if(write.table!=='$dynamic')try{ownerFor(write.table);}catch{errors.push(`${entry.file}:${entry.line} unowned ${write.table}`);}
 }
 }
 for(const [key,count] of signatures){const i=key.indexOf('|'),file=key.slice(0,i),signature=key.slice(i+1);const registered=registry.writers[file]?.statements?.[signature];if(registered&&count>registered)errors.push(`${file} added privileged SQL call ${signature}`);}
 for(const entry of inventory.opaque){
  if(!registry.opaque.some(r=>r.file===entry.file&&r.command===entry.command&&r.expression===entry.expression))errors.push(`${entry.file}:${entry.line} unreviewed SQL expression ${entry.command}: ${entry.expression}`);
 }
 return errors;
}
