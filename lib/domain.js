'use strict';
const MONTHS=['january','february','march','april','may','june','july','august','september','october','november','december'];
const DATE_RE=/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})/;
const MS_DAY=86400000;
const ws=s=>s.replace(/[“”]/g,'"').replace(/[‘’]/g,"'").replace(/\s+/g,' ').trim();

/** Normalization: text -> ordered blocks with page/section locations (form feed = page break). */
function normalize(text,version=1){
  const blocks=[];let page=1,section;let order=0;
  for(const pageText of String(text).split('\f')){
    for(const raw of pageText.split(/\n\s*\n/)){
      const t=raw.trim();if(!t)continue;
      const h=t.match(/^((?:Section\s+)?\d+(?:\.\d+)*\.?|Schedule\s+[A-Z])\s+\S/i);
      const isHeading=!!h&&t.length<90&&!/[.;]$/.test(t);
      if(h)section=h[1].replace(/^Section\s+/i,'').replace(/\.$/,'');
      blocks.push({id:`v${version}-b${order}`,type:isHeading?'heading':'paragraph',text:t,page,section,order:order++});
    }
    page++;
  }
  return {version,blocks};
}
const parseDate=s=>{const m=s&&s.match(DATE_RE);if(!m)return null;return new Date(Date.UTC(+m[3],MONTHS.indexOf(m[1].toLowerCase()),+m[2])).toISOString().slice(0,10)};

/** Deterministic date engine: the LLM never computes dates. */
function calcDeadline({anchor,days,direction='before'}){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(anchor||'')||!Number.isInteger(days)||days<0)return null;
  const d=new Date(anchor+'T00:00:00Z').getTime()+(direction==='before'?-1:1)*days*MS_DAY;
  return {sourceRule:`${days} calendar days ${direction} expiry`,anchor,method:'calendar days, UTC date arithmetic',date:new Date(d).toISOString().slice(0,10)};
}
const dueState=(iso,now=new Date(),soonDays=30)=>{if(!iso)return 'unknown';const diff=(new Date(iso+'T00:00:00Z')-new Date(now.toISOString().slice(0,10)+'T00:00:00Z'))/MS_DAY;return diff<0?'overdue':diff<=soonDays?'due_soon':'upcoming'};

/** Citation validation: quote must exist verbatim (whitespace-normalised) in the document. */
function validateCitation(doc,quote){
  const q=ws(quote||'');if(q.length<8)return null;
  const b=doc.blocks.find(b=>ws(b.text).includes(q));
  return b?{blockId:b.id,section:b.section||null,page:b.page,version:doc.version,quote:q}:null;
}

/** Business-level comparison of two extraction sets, keyed by category(+key). */
function compareItems(prev,next){
  const key=i=>i.category+(i.key?':'+i.key:'');const pm=new Map(prev.map(i=>[key(i),i]));const out=[];
  for(const n of next){const p=pm.get(key(n));
    if(!p)out.push({type:'added',category:n.category,current:n.value,quote:n.quote});
    else if(ws(String(p.aiValue))!==ws(String(n.value)))out.push({type:'changed',category:n.category,key:n.key,previous:p.value,current:n.value,section:n.citation&&n.citation.section,quote:n.quote});
    pm.delete(key(n));}
  for(const p of pm.values())out.push({type:'removed',category:p.category,previous:p.value});
  return out;
}
const reviewStatus=items=>{if(!items.length)return 'processing';return items.every(i=>i.state!=='pending'&&!i.stale)?'reviewed':'needs_review'};
module.exports={normalize,parseDate,calcDeadline,dueState,validateCitation,compareItems,reviewStatus,ws,DATE_RE};
