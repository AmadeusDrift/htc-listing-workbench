import {createHash} from 'node:crypto';
import {parseSync} from 'rolldown/utils';

// A bounded SQL token inventory, not a SQL interpreter. Values/comments cannot become table names.
export function sqlWrites(sql){
 const cleaned=sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g,' ').replace(/'(?:''|[^'])*'/g,"''");
 const tokens=cleaned.match(/\$\{[^}]*\}|[a-z_][a-z_0-9]*|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|[.;]/gi)??[];
 const result=[];
 for(let i=0;i<tokens.length;i++){
  const word=tokens[i].toUpperCase();let j=i+1,operation;
  if(word==='INSERT'||word==='REPLACE'){
   if(tokens[j]?.toUpperCase()==='OR')j+=2;
   if(tokens[j]?.toUpperCase()!=='INTO')continue;j++;operation=word;
  }else if(word==='UPDATE'){
   if(tokens[j]?.toUpperCase()==='SET')continue; // UPSERT DO UPDATE SET is not a second table.
   if(tokens[j]?.toUpperCase()==='OR')j+=2;operation=word;
  }else if(word==='DELETE'){
   if(tokens[j]?.toUpperCase()!=='FROM')continue;j++;operation=word;
  }else if(['CREATE','ALTER','DROP'].includes(word)){
   if(tokens[j]?.toUpperCase()==='TEMP'||tokens[j]?.toUpperCase()==='TEMPORARY')j++;
   if(tokens[j]?.toUpperCase()!=='TABLE')continue;j++;operation=word;
   if(tokens[j]?.toUpperCase()==='IF'){j++;if(tokens[j]?.toUpperCase()==='NOT')j++;if(tokens[j]?.toUpperCase()==='EXISTS')j++;}
  }else continue;
  if(tokens[j+1]==='.')j+=2;
  const token=tokens[j];if(!token)continue;
  if(operation==='UPDATE'&&tokens[j+1]?.toUpperCase()!=='SET')continue;
  result.push({operation,table:token.startsWith('${')?'$dynamic':token.replace(/^["`\[]|["`\]]$/g,'').toLowerCase()});
 }
 return result;
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
   const sql=node.type==='Literal'?node.value:node.quasis.map((q,i)=>q.value.cooked+(i<node.expressions.length?'${'+source.slice(node.expressions[i].start,node.expressions[i].end)+'}':'')).join('');
   const found=sqlWrites(sql);
   if(found.length)writes.push({file,command,line:source.slice(0,node.start).split('\n').length,sql,...{writes:found}});
  }
  if(node.type==='CallExpression'&&node.callee?.type==='MemberExpression'&&['prepare','exec'].includes(node.callee.property.name)&&node.arguments.length){
   const arg=node.arguments[0];
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
