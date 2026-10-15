const {chromium}=require('/Users/paulosalvatore/Documents/GitHub/boraoke/node_modules/playwright');
const fs=require('fs');
const [out,creator]=[process.argv[2],process.argv[3]==='creator'];
const T={pr:'http://localhost:3460',prod:'https://boraoke.com'};
const routes=creator?['/']:['/','/default'];
(async()=>{const br=await chromium.launch({headless:true});const res={};
for(const w of [1440,390,320])for(const r of routes)for(const [tag,base] of Object.entries(T)){
 const c=await br.newContext({viewport:{width:w,height:900},locale:'pt-BR'});
 if(creator) await c.addInitScript(()=>{localStorage.setItem('cantai_rooms_v1',JSON.stringify([{id:'bar-do-ze',name:'Bar do Zé',role:'created',lastTouched:Date.now(),claimable:true}]));localStorage.setItem('cantai_last_room','bar-do-ze')});
 const p=await c.newPage();await p.goto(base+r,{waitUntil:'load',timeout:60000});await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(1500);
 res[`${w}|${r}|${tag}`]=await p.evaluate(()=>{const els={};
  const cls=e=>[...e.classList].map(c=>c.replace(/__[A-Za-z0-9_-]+$/,'')).join('.');
  const walk=(e,path)=>{[...e.children].forEach((ch,i)=>{if(['SCRIPT','STYLE','LINK','NOSCRIPT'].includes(ch.tagName))return;
   const k=(path?path+'>':'')+ch.tagName.toLowerCase()+i+(cls(ch)?'.'+cls(ch):'');const b=ch.getBoundingClientRect();
   els[k]=[b.x,b.y+scrollY,b.width,b.height].map(v=>Math.round(v*100)/100);walk(ch,k);});};
  walk(document.body,'');return {els,sw:document.documentElement.scrollWidth};});
 await c.close();}
fs.writeFileSync(out,JSON.stringify(res));await br.close();})();
