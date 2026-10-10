'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const p=require('../providers');
const text=[{role:'system',content:'Return JSON.'},{role:'user',content:'{"ok":true}'}];
const vision=[{role:'user',content:[{type:'text',text:'Return JSON.'},{type:'image_url',image_url:{url:'data:image/png;base64,aGVsbG8='}}]}];
for(const preset of p.PRESETS)for(const stage of ['grade','ocr'])test(preset.id+' '+stage+'：协议、认证与图像载荷',async()=>{
 const c={...p.normalizeConfig({...preset,provider:preset.id,baseUrl:preset.baseUrl||'http://127.0.0.1:5000/v1',model:'test-model'},stage),apiKey:'unit-test-provider-key'};
 const request=p.buildRequest(stage==='ocr'?vision:text,c,{reasoningEffort:stage==='ocr'?'low':'high'});
 assert.ok(request.url.endsWith(c.protocol==='anthropic'?'/messages':'/chat/completions'));
 assert.equal(request.body.model,'test-model');
 assert.equal(c.protocol==='anthropic'?request.headers['x-api-key']:request.headers.Authorization,c.protocol==='anthropic'?c.apiKey:'Bearer '+c.apiKey);
 assert.equal('reasoning_effort' in request.body,false);
 if(stage==='ocr')assert.equal(c.protocol==='anthropic'?request.body.messages[0].content[1].source.data:request.body.messages[0].content[1].image_url.url,c.protocol==='anthropic'?'aGVsbG8=':'data:image/png;base64,aGVsbG8=');
 const old=global.fetch;global.fetch=async()=>new Response(JSON.stringify(c.protocol==='anthropic'?{content:[{type:'thinking',thinking:'do not expose'},{type:'text',text:'{"ok":true}'}]}:{choices:[{message:{content:'{"ok":true}'}}]}));
 try{assert.equal(await p.callModel(stage==='ocr'?vision:text,c),' {"ok":true}'.trim());}finally{global.fetch=old;}
});
test('思考和JSON参数按协议与模型转换，Responses识别及修复历史正确',()=>{
 const deep={...p.normalizeConfig({provider:'deepseek'}),apiKey:'unit-test'};
 const grade=p.buildRequest(text,deep,{reasoningEffort:'high',topP:.95});assert.equal(grade.body.reasoning_effort,'high');assert.equal(grade.body.thinking.type,'enabled');assert.equal(grade.body.top_p,.95);
 const ocr=p.buildRequest(vision,deep,{reasoningEffort:'low'});assert.equal(ocr.body.reasoning_effort,'low');assert.equal(ocr.body.response_format.type,'json_object');
 const resp={...p.normalizeConfig({provider:'openai',protocol:'responses',model:'gpt-test',effort:'high',jsonMode:'object'}),apiKey:'unit-test'};
 const r=p.buildRequest([...vision,{role:'assistant',content:'{}'},text[1]],resp);assert.ok(r.url.endsWith('/responses'));assert.equal(r.body.input[0].content[1].type,'input_image');assert.equal(r.body.input[1].content[0].type,'output_text');assert.equal(r.body.reasoning.effort,'high');assert.equal(r.body.store,false);
 assert.equal(p.outputText({output:[{type:'reasoning'},{content:[{type:'output_text',text:'{}'}]}]},'responses'),'{}');
 const claude={...p.normalizeConfig({provider:'anthropic',model:'claude-sonnet-4-6',effort:'high'}),apiKey:'unit-test'};const a=p.buildRequest(text,claude);assert.equal(a.body.system,'Return JSON.');assert.equal(a.body.thinking.type,'adaptive');assert.equal(a.body.output_config.effort,'high');assert.equal('reasoning_effort' in a.body,false);
 const gemini={...p.normalizeConfig({provider:'gemini',model:'gemini-test',effort:'low'}),apiKey:'unit-test'};assert.equal(p.buildRequest(text,gemini).body.reasoning_effort,'low');
});
test('缺密钥、非法地址、参数、截断及错误回显处理',async()=>{
 assert.throws(()=>p.normalizeConfig({provider:'custom',baseUrl:'http://example.com',model:'test'}),/HTTPS/);
 assert.throws(()=>p.normalizeConfig({provider:'custom',baseUrl:'https://user:pass@example.com',model:'test'}),/密码/);
 assert.throws(()=>p.normalizeConfig({provider:'custom',baseUrl:'https://example.com?key=foo',model:'test'}),/查询/);
 assert.throws(()=>p.normalizeConfig({provider:'deepseek',effort:'bad'}),/强度/);
 await assert.rejects(p.callModel(text,p.normalizeConfig({provider:'deepseek'})),/尚未填写/);
 assert.throws(()=>p.outputText({choices:[{finish_reason:'length'}]},'chat'),/截断/);
 assert.throws(()=>p.outputText({stop_reason:'max_tokens'},'anthropic'),/截断/);
 assert.throws(()=>p.outputText({status:'incomplete'},'responses'),/未完成/);
 const old=global.fetch;global.fetch=async()=>new Response('provider echoes private information',{status:401});
 try{await assert.rejects(p.callModel(text,{...p.normalizeConfig({provider:'deepseek'}),apiKey:'unit-test'}),e=>e.status===401&&!e.message.includes('private'));}finally{global.fetch=old;}
});
