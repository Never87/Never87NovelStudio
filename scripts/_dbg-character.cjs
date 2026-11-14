const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9398;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function httpJson(url){return new Promise((res,rej)=>{http.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})}).on('error',rej)})}
class Cdp{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result)}})}
send(method,params={}){const id=++this.id;this.ws.send(JSON.stringify({id,method,params}));return new Promise((resolve,reject)=>this.pending.set(id,{resolve,reject}))}
async eval(expression){const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails){throw new Error(r.exceptionDetails.exception?.description||JSON.stringify(r.exceptionDetails))}return r.result.value}}
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dbg-'));
  const chrome=spawn(CHROME,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${dir}`,'--headless=new','--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
  let target=null;
  for(let i=0;i<60;i++){try{const l=await httpJson(`http://127.0.0.1:${PORT}/json/list`);target=l.find(t=>t.type==='page');if(target)break}catch{}await sleep(250)}
  const ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',rej,{once:true})});
  const cdp=new Cdp(ws);
  await cdp.send('Runtime.enable');await cdp.send('Page.enable');
  await cdp.send('Page.navigate',{url:'http://localhost:5177/'});
  await sleep(2500);
  const out=await cdp.eval(`(async()=>{
    const dbMod=await import('/src/db/index.ts');
    const {NovelStudioDb,__setDbForTesting}=dbMod;
    const db=new NovelStudioDb('dbg-'+Date.now());
    __setDbForTesting(db); await db.open();
    const {ProjectService}=await import('/src/services/project-service.ts');
    const {CharacterService}=await import('/src/services/character-service.ts');
    const {WorldService}=await import('/src/services/world-service.ts');
    const projects=new ProjectService();
    const worldService=new WorldService();
    const characters=new CharacterService();
    try{
      const project=await projects.createProject({title:'CapAlpha',description:'CapAlpha-N87 description with a secret-sounding phrase: sk-LEAKCANARY',genre:['fantasy'],tags:['CapAlpha-N87']});
      const projectId=project.id;
      await worldService.createWorld(projectId,{title:'CapAlpha-N87 world',overview:'Overview of CapAlpha-N87',themes:['theme-CapAlpha-N87'],sections:[{title:'Geography',content:'Mountains of CapAlpha-N87.'}]});
      const charA=await characters.createCharacter(projectId,{name:'CapAlpha-N87 Elara',role:'protagonist',summary:'Brave.'});
      const charB=await characters.createCharacter(projectId,{name:'CapAlpha-N87 Aria',role:'supporting'});
      return {ok:true,a:charA.id,b:charB.id};
    }catch(e){
      return {ok:false, msg:e.message, issues:e.issues, cause: e.cause? String(e.cause.message||e.cause):null, stack:(e.stack||'').split('\\n').slice(0,6)};
    }
  })()`);
  console.log(JSON.stringify(out,null,2));
  try{ws.close()}catch{};try{chrome.kill()}catch{};try{fs.rmSync(dir,{recursive:true,force:true})}catch{}
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});

