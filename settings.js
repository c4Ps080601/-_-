'use strict';
const fs=require('fs'),path=require('path');
const {PRESETS,normalizeConfig}=require('./providers');
const FONT_SCALES=[0.85,1,1.15,1.3];let SETTINGS_FILE=null,cipher=null;
function init(file){SETTINGS_FILE=file||null;}
function initEncryption(value){cipher=value;}
function readSettings(){try{return JSON.parse(fs.readFileSync(SETTINGS_FILE,'utf8'));}catch{return {};}}
function writeSettings(s){if(!SETTINGS_FILE)throw new Error('本地设置目录尚未初始化');fs.mkdirSync(path.dirname(SETTINGS_FILE),{recursive:true});const tmp=SETTINGS_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(s,null,2));fs.renameSync(tmp,SETTINGS_FILE);}
function encrypted(key){if(!cipher?.isEncryptionAvailable())throw Object.assign(new Error('系统加密服务不可用，无法保存密钥；请重启软件后重试'),{status:400});return cipher.encryptString(key).toString('base64');}
function decrypt(value){if(!value)return '';try{if(!cipher?.isEncryptionAvailable())return '';return cipher.decryptString(Buffer.from(value,'base64'));}catch{return '';}}
function defaultConfig(stage){return {...normalizeConfig({provider:'deepseek'},stage),credential:null};}
function configFor(stage){return readSettings().ai?.[stage]||defaultConfig(stage);}
function getAIConfig(stage='grade'){const c=configFor(stage);return {...c,apiKey:decrypt(c.credential)};}
function getPublicAISettings(){const s=readSettings();return {presets:PRESETS,sameOCR:s.sameOCR===true,onboardingSeen:s.onboardingSeen===true,secureStorageAvailable:!!cipher?.isEncryptionAvailable(),...Object.fromEntries(['grade','ocr'].map(stage=>{const c=configFor(stage);return [stage,{...Object.fromEntries(Object.entries(c).filter(([key])=>key!=='credential'&&key!=='apiKey')),hasKey:!!decrypt(c.credential),storedKey:!!c.credential}];}))};}
function updateSettings(body){
 if(!body||typeof body!=='object'||Array.isArray(body))throw Object.assign(new Error('设置格式不正确'),{status:400});const s=readSettings();
 if(body.theme!==undefined){if(!['light','dark'].includes(body.theme))throw Object.assign(new Error('外观参数无效'),{status:400});s.theme=body.theme;}
 if(body.fontScale!==undefined){if(!FONT_SCALES.includes(Number(body.fontScale)))throw Object.assign(new Error('字体大小参数无效'),{status:400});s.fontScale=Number(body.fontScale);}
 if(body.ai!==undefined){
  if(!body.ai||typeof body.ai!=='object'||Array.isArray(body.ai))throw Object.assign(new Error('API配置格式不正确'),{status:400});s.ai={...(s.ai||{})};
  for(const stage of ['grade','ocr'])if(body.ai[stage]!==undefined){
   if(stage==='ocr'&&body.ai.ocr.sameAsGrade===true){s.ai.ocr={...(s.ai.grade||defaultConfig('grade'))};s.sameOCR=true;continue;}
   if(stage==='ocr')s.sameOCR=false;
   const old=configFor(stage),input=body.ai[stage],c=normalizeConfig(input,stage),same=old.provider===c.provider&&old.baseUrl===c.baseUrl&&old.protocol===c.protocol;
   c.credential=same?old.credential:null;
   if(input.clearKey===true)c.credential=null;
   if(input.apiKey!==undefined&&input.apiKey!==''){
    if(typeof input.apiKey!=='string'||input.apiKey.trim().length<8||/[\r\n]/.test(input.apiKey))throw Object.assign(new Error('API Key格式不正确'),{status:400});c.credential=encrypted(input.apiKey.trim());
   }
   s.ai[stage]=c;
  }
 }
 writeSettings(s);
}
function acknowledgeOnboarding(){const s=readSettings();s.onboardingSeen=true;writeSettings(s);}
function getConfig(){return require('./config.json');}
function getApiKey(){return getAIConfig('grade').apiKey;}
function getApiKeyInfo(){return {hasCustom:!!getApiKey(),source:'本机用户配置',masked:getApiKey()?'已配置（不回传密钥）':'未配置'};}
function setApiKey(key){const c=configFor('grade');updateSettings({ai:{grade:{...c,apiKey:key||'',clearKey:!key}}});}
function getFontScale(){const v=Number(readSettings().fontScale);return FONT_SCALES.includes(v)?v:1;}
function getTheme(){return readSettings().theme==='dark'?'dark':'light';}
module.exports={init,initEncryption,getSettingsFile:()=>SETTINGS_FILE,getConfig,getAIConfig,getPublicAISettings,updateSettings,acknowledgeOnboarding,getApiKey,getApiKeyInfo,setApiKey,FONT_SCALES,getFontScale,getTheme,setFontScale:fontScale=>updateSettings({fontScale}),setTheme:theme=>updateSettings({theme}),getEndpoint:()=>configFor('grade').baseUrl,getModel:()=>configFor('grade').model};
