// Independent re-gate measurement (App Tester). Usage: node regate-measure.js <outdir>
const {chromium}=require('/Users/paulosalvatore/Documents/GitHub/boraoke/node_modules/playwright');
const fs=require('fs');const out=process.argv[2];
const T={pr:'http://localhost:3461',prod:'https://boraoke.com'};
const cases=[['anon','/'],['anon','/default'],['creator','/']];
const room=[{id:'bar-do-ze',name:'Bar do Zé',role:'created',lastTouched:1700000000000,claimable:true}];
function collect(){
  const cls=e=>(typeof e.className==='string'?e.className:(e.className&&e.className.baseVal)||'').split(/\s+/).filter(Boolean).map(c=>c.replace(/__[A-Za-z0-9_-]+$/,'')).join('.');
  const r2=v=>Math.round(v*100)/100;const rows={};
  const walk=(e,path)=>{[...e.children].forEach((ch,i)=>{
    if(['SCRIPT','STYLE','LINK','NOSCRIPT','META','TITLE','HEAD'].includes(ch.tagName))return;
    const k=(path?path+'>':'')+ch.tagName.toLowerCase()+i+(cls(ch)?'.'+cls(ch):'');
    const cs=getComputedStyle(ch);const b=ch.getBoundingClientRect();
    const shown=cs.display!=='none'&&cs.visibility!=='hidden'&&b.width>0&&b.height>0&&+cs.opacity>0;
    if(shown){
      const tr=a=>!a||a==='rgba(0, 0, 0, 0)'||a==='transparent';
      const bw=['Top','Right','Bottom','Left'].some(s=>parseFloat(cs['border'+s+'Width'])>0&&cs['border'+s+'Style']!=='none'&&!tr(cs['border'+s+'Color']));
      const hasBox=!tr(cs.backgroundColor)||cs.backgroundImage!=='none'||bw||(cs.outlineStyle!=='none'&&parseFloat(cs.outlineWidth)>0)||cs.boxShadow!=='none';
      const media=['IMG','SVG','CANVAS','VIDEO','INPUT','TEXTAREA','SELECT'].includes(ch.tagName.toUpperCase());
      let own='';[...ch.childNodes].forEach(n=>{if(n.nodeType===3)own+=n.textContent});own=own.trim();
      let tight=null,lines=0;
      if(own){const rg=document.createRange();rg.selectNodeContents(ch);
        const rs=[...rg.getClientRects()].filter(r=>r.width>0);
        if(rs.length){const x0=Math.min(...rs.map(r=>r.left)),y0=Math.min(...rs.map(r=>r.top)),x1=Math.max(...rs.map(r=>r.right)),y1=Math.max(...rs.map(r=>r.bottom));
          tight=[x0,y0+scrollY,x1-x0,y1-y0].map(r2);lines=new Set(rs.map(r=>Math.round(r.top))).size;}}
      if(true)
        rows[k]={tag:ch.tagName,hasBox,media,text:own.slice(0,30),box:[b.x,b.y+scrollY,b.width,b.height].map(r2),tight,lines,
          bg:cs.backgroundColor,bd:cs.borderTopWidth+' '+cs.borderTopStyle+' '+cs.borderTopColor,ol:cs.outlineStyle+' '+cs.outlineWidth,sh:cs.boxShadow==='none'?'':cs.boxShadow.slice(0,40)};
    }
    walk(ch,k);});};
  walk(document.body,'');
  const d=document.documentElement;
  return {rows,sw:d.scrollWidth,cw:d.clientWidth,sh:d.scrollHeight,bsw:document.body.scrollWidth};
}
(async()=>{const br=await chromium.launch({headless:true});const res={};
for(const w of [1440,390,320])for(const [mode,r] of cases)for(const [tag,base] of Object.entries(T)){
  const c=await br.newContext({viewport:{width:w,height:w===1440?900:w===390?844:568},locale:'pt-BR'});
  if(mode==='creator')await c.addInitScript(rm=>{localStorage.setItem('cantai_rooms_v1',JSON.stringify(rm));localStorage.setItem('cantai_last_room','bar-do-ze')},room);
  const p=await c.newPage();
  try{await p.goto(base+r,{waitUntil:'load',timeout:90000});await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(2500);
  const key=`${w}|${mode}|${r}|${tag}`;res[key]=await p.evaluate(collect);
  await p.screenshot({path:`${out}/shot-${mode}${r==='/'?'-home':'-default'}-${w}-${tag}.png`,fullPage:true});}catch(e){res[`${w}|${mode}|${r}|${tag}`]={err:String(e)}}
  await c.close();console.error('done',w,mode,r,tag);}
fs.writeFileSync(`${out}/measurements.json`,JSON.stringify(res));await br.close();})();
