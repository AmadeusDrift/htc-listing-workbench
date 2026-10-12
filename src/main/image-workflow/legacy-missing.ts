import {existsSync,readdirSync,readFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {AmazonDraft} from '../../shared/amazon-contracts.ts';
import {UserFacingError} from '../../shared/errors.ts';
/** A missing run has no trustworthy slot mapping. Search paid artifacts before retrying. */
export function missingWorkflowBudget(db:DatabaseSync,directory:string,draft:AmazonDraft,attempts:number):1|2|3 {
  if(!Number.isSafeInteger(attempts)||attempts<0)throw new UserFacingError('旧图片尝试次数无效，原记录已保留');
  const associated=db.prepare("SELECT id FROM ai_results WHERE json_extract(record_json,'$.imageContext.listing.draftId')=? LIMIT 1").get(draft.id)
    ||db.prepare("SELECT id FROM ai_calls WHERE json_extract(record_json,'$.presentationContext.kind')='image' AND json_extract(record_json,'$.presentationContext.draftId')=? LIMIT 1").get(draft.id);
  if(associated)throw new UserFacingError('发现原图片请求或结果但工作流关联缺失；已保留成果，需恢复原图位关系后继续');
  const root=join(directory,'image-generation','candidates');
  if(existsSync(root)){
    if(lstatSync(root).isSymbolicLink())throw new UserFacingError('图片生成记录目录无效');
    for(const entry of readdirSync(root,{withFileTypes:true})){
      if(entry.isSymbolicLink())throw new UserFacingError('图片生成记录目录无效');
      if(!entry.isDirectory()||entry.name.startsWith('.'))continue;
      const path=join(root,entry.name,'candidate.json');if(!existsSync(path))continue;
      if(lstatSync(path).isSymbolicLink()||lstatSync(path).size>32768)throw new UserFacingError('图片生成记录无效');
      const candidate=JSON.parse(readFileSync(path,'utf8'));
      if(candidate.productId===draft.productId&&candidate.productRevision===draft.productRevision)throw new UserFacingError('发现同来源已生成图片但缺少原图位关联；已保留成果，未重复生成');
    }
  }
  if(attempts>=3)throw new UserFacingError('旧图片请求已用完三次尝试，原次数与费用记录保留');
  return (3-attempts) as 1|2|3;
}
