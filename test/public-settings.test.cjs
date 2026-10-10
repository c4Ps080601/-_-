'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const settings=require('../settings');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'public-settings-'));
const file=path.join(dir,'settings.json'),secret=crypto.randomBytes(32);
const cipher={isEncryptionAvailable:()=>true,encryptString(text){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',secret,iv),data=Buffer.concat([c.update(text),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]);},decryptString(data){const c=crypto.createDecipheriv('aes-256-gcm',secret,data.subarray(0,12));c.setAuthTag(data.subarray(12,28));return Buffer.concat([c.update(data.subarray(28)),c.final()]).toString();}};
test('公开设置：无内置Key、加密保存、不回传、配置隔离、原子校验、清除与首次提示',()=>{
 settings.init(file);assert.equal(settings.getApiKey(),'');assert.equal(settings.getPublicAISettings().onboardingSeen,false);settings.initEncryption(cipher);
 const c={provider:'deepseek',apiKey:'unit-test-private-placeholder'};
 settings.updateSettings({ai:{grade:c,ocr:{sameAsGrade:true}},theme:'dark',fontScale:1.3});
 assert.equal(settings.getAIConfig('grade').apiKey,c.apiKey);assert.equal(settings.getAIConfig('ocr').apiKey,c.apiKey);assert.equal(fs.readFileSync(file,'utf8').includes(c.apiKey),false);
 const publicJSON=JSON.stringify(settings.getPublicAISettings());assert.equal(publicJSON.includes(c.apiKey),false);assert.equal(publicJSON.includes('credential'),false);assert.equal(settings.getPublicAISettings().sameOCR,true);
 settings.updateSettings({theme:'light'});assert.equal(settings.getApiKey(),c.apiKey);
 const before=fs.readFileSync(file,'utf8');assert.throws(()=>settings.updateSettings({theme:'dark',ai:{grade:{...c},ocr:{provider:'custom',baseUrl:'invalid',model:'test'}}}),/地址/);assert.equal(fs.readFileSync(file,'utf8'),before);
 settings.updateSettings({ai:{grade:{provider:'qwen',model:'qwen-plus'},ocr:{sameAsGrade:true}}});assert.equal(settings.getApiKey(),'');assert.equal(settings.getAIConfig('ocr').apiKey,'');
 settings.updateSettings({ai:{grade:c,ocr:{sameAsGrade:true}}});settings.updateSettings({ai:{grade:{provider:'deepseek',model:'deepseek-pro',clearKey:true}}});assert.equal(settings.getApiKey(),'');
 settings.acknowledgeOnboarding();assert.equal(settings.getPublicAISettings().onboardingSeen,true);
 settings.initEncryption({isEncryptionAvailable:()=>false});assert.throws(()=>settings.updateSettings({ai:{grade:c}}),/加密/);assert.equal(settings.getApiKey(),'');
 settings.initEncryption(cipher);
});
