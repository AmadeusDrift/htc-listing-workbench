import type { TextModelCapability,TextGateway,ReasoningEffort } from '../../shared/ai-purpose-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';

// Public protocol snapshots, not a claim that an account has model access.
export const TEXT_MODEL_CAPABILITIES:readonly TextModelCapability[]=[
  {gateway:'openrouter',model:'openai/gpt-6-luna-decisions',name:'GPT-6 Luna Decisions',vision:true,json:true,efforts:['not_applicable'],batch:false,verifiedAt:'2026-10-13',sourceUrl:'https://openrouter.ai/openai/gpt-6-luna-decisions',accountVerified:false,endpoint:'decisions'},
  {gateway:'openrouter',model:'typesafe/jev-1.13',name:'TypeSafe Jev 1.13',vision:false,json:true,efforts:['not_applicable'],batch:false,verifiedAt:'2026-10-13',sourceUrl:'https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request',accountVerified:false,endpoint:'decisions'},
  {gateway:'openrouter',model:'openai/gpt-6-luna',name:'GPT-6 Luna',vision:true,json:true,efforts:['none','low','medium','high','xhigh','max'],batch:true,verifiedAt:'2026-10-13',sourceUrl:'https://developers.openai.com/api/docs/models/gpt-6-luna',accountVerified:false},
  {gateway:'openrouter',model:'openai/gpt-6.1-sol',name:'GPT-6.1 Sol',vision:true,json:true,efforts:['low','medium','high','xhigh','max'],batch:true,verifiedAt:'2026-10-13',sourceUrl:'https://developers.openai.com/api/docs/models/gpt-6.1-sol',accountVerified:false},
  {gateway:'openrouter',model:'openai/gpt-6-astra',name:'GPT-6 Astra',vision:true,json:true,efforts:['low','medium','high','xhigh','max'],batch:true,verifiedAt:'2026-10-13',sourceUrl:'https://developers.openai.com/api/docs/models/gpt-6-astra',accountVerified:false},
  {gateway:'deepseek',model:'deepseek-flash',name:'DeepSeek Flash',vision:true,json:true,efforts:['none','low','high','max'],batch:false,verifiedAt:'2026-10-13',sourceUrl:'https://api-docs.deepseek.com/api/create-chat-completion/',accountVerified:false},
  {gateway:'deepseek',model:'deepseek-v4-pro',name:'DeepSeek V4 Pro',vision:false,json:true,efforts:['none','low','high','max'],batch:false,verifiedAt:'2026-10-13',sourceUrl:'https://api-docs.deepseek.com/api/create-chat-completion/',accountVerified:false},
];
export function textModelCapability(gateway:TextGateway,model:string):TextModelCapability{
  const value=TEXT_MODEL_CAPABILITIES.find(item=>item.gateway===gateway&&item.model===model);
  if(!value)throw new UserFacingError('模型与所选渠道不匹配，或尚未登记真实能力；未自动替换');return structuredClone(value);
}
export function checkReasoning(gateway:TextGateway,model:string,effort:ReasoningEffort):TextModelCapability{
  const capability=textModelCapability(gateway,model);if(!capability.efforts.includes(effort))throw new UserFacingError(`${capability.name} 不支持所选思考强度 ${effort}，请选择有效档位`);return capability;
}
