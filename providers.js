'use strict';
const PRESETS=[
 {id:'deepseek',name:'DeepSeek',baseUrl:'https://api.deepseek.com',protocol:'chat',gradeModel:'deepseek-flash',ocrModel:'deepseek-flash'},
 {id:'openai',name:'OpenAI',baseUrl:'https://api.openai.com/v1',protocol:'chat'},
 {id:'qwen',name:'通义千问 / 百炼',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',protocol:'chat',gradeModel:'qwen-plus',ocrModel:'qwen-vl-plus'},
 {id:'kimi',name:'Kimi / Moonshot',baseUrl:'https://api.moonshot.cn/v1',protocol:'chat',gradeModel:'kimi-k3'},
 {id:'glm',name:'智谱 GLM',baseUrl:'https://open.bigmodel.cn/api/paas/v4',protocol:'chat',gradeModel:'glm-5.3'},
 {id:'siliconflow',name:'硅基流动',baseUrl:'https://api.siliconflow.cn/v1',protocol:'chat'},
 {id:'gemini',name:'Google Gemini',baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai',protocol:'chat'},
 {id:'anthropic',name:'Anthropic Claude',baseUrl:'https://api.anthropic.com/v1',protocol:'anthropic'},
 {id:'custom',name:'自定义 / 本地兼容接口',baseUrl:'',protocol:'chat'}
];
const fail=message=>{throw Object.assign(new Error(message),{status:400});};
function normalizeConfig(input,stage='grade'){
 if(!input||typeof input!=='object'||Array.isArray(input))fail('API配置格式不正确');
 const preset=PRESETS.find(p=>p.id===input.provider);if(!preset)fail('请选择有效的服务商');
 const baseUrl=String(input.baseUrl??preset.baseUrl).trim().replace(/\/+$/,'');let url;
 try{url=new URL(baseUrl);}catch{fail('API地址格式不正确');}
 if(url.username||url.password||url.search||url.hash)fail('API地址不能包含账号、密码、查询参数或片段');
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))fail('远程接口必须使用HTTPS；本地接口可使用HTTP');
 const protocol=input.protocol||preset.protocol;if(!['chat','responses','anthropic'].includes(protocol))fail('API协议无效');
 const model=String(input.model??preset[stage+'Model']??'').trim();if(!model||model.length>160||/[\r\n]/.test(model))fail('请填写有效的模型ID');
 const effort=input.effort||'auto',jsonMode=input.jsonMode||'auto';
 if(!['auto','off','low','medium','high','max'].includes(effort))fail('思考强度无效');
 if(!['auto','prompt','object'].includes(jsonMode))fail('JSON模式无效');
 if(protocol==='anthropic'&&jsonMode==='object')fail('Claude Messages请选择自动或提示词JSON模式');
 return {provider:preset.id,baseUrl,protocol,model,effort,jsonMode};
}
function endpoint(c){const suffix=c.protocol==='anthropic'?'/messages':c.protocol==='responses'?'/responses':'/chat/completions';return c.baseUrl.endsWith(suffix)?c.baseUrl:c.baseUrl+suffix;}
function blocks(content){if(typeof content==='string')return [{type:'text',text:content}];return content.map(c=>{if(c.type==='text')return c;const m=c.image_url?.url?.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s);if(!m)fail('Claude图片须为PNG、JPEG或WebP的base64数据');return {type:'image',source:{type:'base64',media_type:m[1],data:m[2]}};});}
function buildRequest(messages,c,opts={}){
 const headers={'Content-Type':'application/json'},effort=c.effort==='auto'?(opts.reasoningEffort||'low'):c.effort;let body;
 if(c.protocol==='anthropic'){
  headers['x-api-key']=c.apiKey;headers['anthropic-version']='2023-06-01';
  body={model:c.model,max_tokens:16384,system:messages.filter(m=>m.role==='system').map(m=>m.content).join('\n'),messages:messages.filter(m=>m.role!=='system').map(m=>({role:m.role,content:blocks(m.content)})),stream:false};
  if(c.effort!=='auto'){
   if(c.effort==='off')body.thinking={type:'disabled'};
   else if(/^claude-(opus|sonnet)-(?:4-[6-9]|5)/.test(c.model)){body.thinking={type:'adaptive'};body.output_config={effort};}
   else {if(effort==='max')fail('该Claude模型请使用High或自动思考强度');body.thinking={type:'enabled',budget_tokens:{low:1024,medium:4096,high:8192}[effort]};}
  }
 }else{
  headers.Authorization='Bearer '+c.apiKey;
  if(c.protocol==='responses'){
   body={model:c.model,input:messages.map(m=>({role:m.role,content:typeof m.content==='string'?[{type:m.role==='assistant'?'output_text':'input_text',text:m.content}]:m.content.map(t=>t.type==='text'?{type:'input_text',text:t.text}:{type:'input_image',image_url:t.image_url.url})})),stream:false,store:false};
   if(c.effort!=='auto'&&c.effort!=='off')body.reasoning={effort};
   if(c.jsonMode==='object')body.text={format:{type:'json_object'}};
  }else{
   body={model:c.model,messages,stream:false};
   if(c.jsonMode==='object'||(c.jsonMode==='auto'&&['deepseek','openai'].includes(c.provider)))body.response_format={type:'json_object'};
   if(c.provider==='deepseek'&&/^deepseek-(flash|pro|reasoner|v4)/i.test(c.model)){
    body.thinking={type:c.effort==='off'?'disabled':'enabled'};
    if(c.effort!=='off'){if(!['low','high','max'].includes(effort))fail('DeepSeek思考强度仅支持Low、High或Max');body.reasoning_effort=effort;}
    if(opts.topP!==undefined)body.top_p=opts.topP;
   }else if(['openai','gemini','custom'].includes(c.provider)&&c.effort!=='auto')body.reasoning_effort=c.effort==='off'?'none':effort;
   else if(c.provider==='kimi'&&/^kimi-k3/.test(c.model)){if(!['low','high','max'].includes(effort))fail('Kimi K3思考强度仅支持Low、High或Max');body.reasoning_effort=effort;}
   else if(c.provider==='qwen'&&/^qwen3/i.test(c.model))body.enable_thinking=c.effort!=='off';
   else if(c.provider==='glm'&&c.effort==='off')body.thinking={type:'disabled'};
  }
 }
 return {url:endpoint(c),headers,body};
}
function outputText(data,protocol){
 if(protocol==='anthropic'){if(data.stop_reason==='max_tokens')throw new Error('AI返回结果被截断，请调整模型或重试');return (data.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('');}
 if(protocol==='responses'){if(['incomplete','failed'].includes(data.status))throw new Error('AI返回结果未完成，请调整模型或重试');return data.output_text||(data.output||[]).flatMap(o=>o.content||[]).filter(c=>c.type==='output_text').map(c=>c.text).join('');}
 const choice=data.choices?.[0];if(choice?.finish_reason==='length')throw new Error('AI返回结果被截断，请调整模型或重试');const content=choice?.message?.content;return Array.isArray(content)?content.filter(c=>c.type==='text').map(c=>c.text).join(''):content;
}
async function callModel(messages,c,opts={}){
 if(!c.apiKey&&!(c.provider==='custom'&&['localhost','127.0.0.1','[::1]'].includes(new URL(c.baseUrl).hostname)))throw Object.assign(new Error('尚未填写API Key，请打开设置配置自己的密钥'),{status:401});
 const {url,headers,body}=buildRequest(messages,c,opts),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),opts.timeoutMs||180000);
 try{
  const resp=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),signal:controller.signal,redirect:'error'});
  if(!resp.ok){const hints={400:'请求参数不兼容，请核对模型、协议、思考强度与JSON模式',401:'API Key无效，请在设置中更换',402:'服务商账户余额不足',403:'无权访问该模型，请检查账户权限',404:'模型或接口不存在',413:'图片或请求过大',429:'请求频率过高或额度不足'};throw Object.assign(new Error('模型服务返回 '+resp.status+'：'+(hints[resp.status]||'服务暂时不可用，请稍后重试')),{status:resp.status});}
  let data;try{data=await resp.json();}catch{throw new Error('服务商返回了非JSON响应，请核对API基础地址与协议');}
  const text=outputText(data,c.protocol);if(!text)throw new Error('模型未返回正文，请选用支持文本输出的模型');return text;
 }finally{clearTimeout(timer);}
}
module.exports={PRESETS,normalizeConfig,buildRequest,outputText,callModel};
