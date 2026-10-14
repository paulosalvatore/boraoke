const m=require('./measurements.json');const T=1;
const keys=[...new Set(Object.keys(m).map(k=>k.replace(/\|(pr|prod)$/,'')))];
let fails=0,inv=0,tot=0,hdr=[];
const d=(a,b)=>a.map((v,i)=>Math.round((v-b[i])*100)/100);
for(const k of keys){const pr=m[k+'|pr'],pd=m[k+'|prod'];
 if(pr.err||pd.err){console.log(k,'ERR',pr.err,pd.err);fails++;continue}
 console.log(`\n== ${k}  overflow pr sw=${pr.sw}/cw=${pr.cw} prod sw=${pd.sw}/cw=${pd.cw}  height pr=${pr.sh} prod=${pd.sh}`);
 if(pr.sw>pr.cw)console.log('  FAIL doc overflow');
 const ks=new Set([...Object.keys(pr.rows),...Object.keys(pd.rows)]);
 for(const e of ks){tot++;const a=pr.rows[e],b=pd.rows[e];
  if(!a||!b){fails++;console.log('  FAIL missing in',a?'prod':'pr',e);continue}
  const vis=b.hasBox||b.media||a.hasBox||a.media;
  if(a.lines!==b.lines){fails++;console.log('  FAIL lines',a.lines,b.lines,e);}
  if(a.tight&&b.tight){const t=d(a.tight,b.tight);if(t.some(v=>Math.abs(v)>T)){fails++;console.log('  FAIL text-rect',JSON.stringify(t),e,b.text)}}
  const bd=d(a.box,b.box);
  if(bd.some(v=>Math.abs(v)>T)){
    if(vis){fails++;console.log('  FAIL visible-box',JSON.stringify(bd),e)}
    else{inv++;if(k.startsWith('1440')||1)console.log('  inv-box  ',JSON.stringify(bd),'['+a.tag+']',e.slice(-60), a.text?('"'+a.text+'"'):'')}
  }
  if(a.hasBox!==b.hasBox||a.bg!==b.bg||a.bd!==b.bd||a.ol!==b.ol||a.sh!==b.sh){fails++;console.log('  FAIL style',e,a.bg,b.bg,a.bd,b.bd)}
 }}
console.log('\nTOTAL elements',tot,'FAIL',fails,'invisible-box deltas',inv);
