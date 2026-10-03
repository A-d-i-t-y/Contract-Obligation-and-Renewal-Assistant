'use strict';
const {parseDate,validateCitation,DATE_RE}=require('./domain');
/**
 * ContractAnalyzer: analyze(NormalizedDocument) => {items, clarifications}.
 * Replace with an LLM adapter (schema-constrained JSON; contract text passed ONLY as delimited, untrusted data).
 * Whatever the provider returns is re-validated by finalize().
 */
const sentences=t=>t.split(/(?<=[.;])\s+(?=[A-Z0-9"“])/);
const find=(doc,re,extra)=>{for(const b of doc.blocks)for(const s of sentences(b.text))if(re.test(s)&&(!extra||extra(s,b)))return {s,b};return null};
const findAll=(doc,re)=>doc.blocks.flatMap(b=>sentences(b.text).filter(s=>re.test(s)).map(s=>({s,b})));
const DAYS=/(\d+)\s*(?:calendar\s+)?days/i;
class RuleAnalyzer{
  async analyze(doc){
    const items=[],clar=[];
    const add=(category,label,value,hit,confidence,why,extra={})=>items.push({category,label,value,quote:hit&&hit.s,confidence,rationale:why,...extra});
    const pb=find(doc,/between\s+.+?\(.*?\)\s*and\s+.+?\(/is);
    if(pb){const m=pb.s.match(/between\s+(.+?)\s*\(.*?\)\s*and\s+(.+?)\s*\(/is);if(m){add('Parties','Party A',m[1].trim(),pb,'confirmed','Named in the agreement preamble.',{key:'a'});add('Parties','Party B',m[2].trim(),pb,'confirmed','Named in the agreement preamble.',{key:'b'})}}
    const ef=find(doc,/effective date/i,s=>DATE_RE.test(s));if(ef)add('Effective date','Effective date',parseDate(ef.s),ef,'confirmed','A sentence defining the Effective Date contains an explicit date.');
    const ex=find(doc,/(expire|expiry|ending on)/i,s=>DATE_RE.test(s)&&!/effective date/i.test(s));if(ex)add('Expiry','Expiry',parseDate(ex.s),ex,'confirmed','A term sentence contains an explicit expiry date.');
    const rn=find(doc,/automatically renew/i);if(rn)add('Renewal','Renewal mechanism','Automatic renewal',rn,'confirmed','The sentence states the agreement renews automatically.');
    const notices=findAll(doc,DAYS).filter(h=>/(non-renewal|renew|expir)/i.test(h.s)&&/notice/i.test(h.s));
    const vals=[...new Set(notices.map(h=>+h.s.match(DAYS)[1]))];
    if(notices.length){const conflict=vals.length>1;
      add('Renewal notice','Renewal notice period',`${vals[0]} days before expiry`,notices[0],conflict?'needs_review':'confirmed',conflict?'Several different notice periods were found; the system cannot decide which controls.':'The sentence states the non-renewal notice period.',conflict?{}:{numeric:vals[0]});
      if(conflict)clar.push({title:'Conflicting notice periods',detail:notices.map(n=>`${n.b.section?'Section '+n.b.section:'An unlabelled clause'} refers to ${n.s.match(DAYS)[1]} days.`).join(' '),question:'Which notice period should be used for renewal tracking?',evidence:notices.map(n=>n.s)});}
    const tm=find(doc,/terminate/i,s=>/(material breach|for cause|convenience)/i.test(s));if(tm)add('Termination','Termination right',tm.s,tm,'uncertain','Termination wording needs human interpretation; shown as written.');
    for(const [re,label] of [[/(shall|must|will)\s+pay|invoice/i,'Payment'],[/(shall|must|will)\s+(provide|deliver|submit).*report/i,'Reporting']]){
      const h=find(doc,re);if(!h)continue;const d=h.s.match(/within\s+(\d+)\s+(?:calendar\s+)?days[^,.;]*/i);const who=(h.s.match(/\b(Customer|Provider|Vendor|Client|Supplier)\b/)||[])[1]||null;
      add('Obligation',`${label} obligation`,h.s,h,who&&d?'confirmed':'uncertain',who&&d?'Sentence names a responsible party and a time limit.':'Responsible party or deadline is not clearly stated.',{key:label,party:who,trigger:d?d[0]:null});}
    const vague=find(doc,/(reasonable efforts|as soon as practicable|promptly|from time to time)/i);
    if(vague){add('Ambiguity','Vague performance standard',vague.s,vague,'needs_review','Wording relies on undefined standards and needs human interpretation.');clar.push({title:'Undefined performance standard',detail:vague.s,question:'How should this standard be tracked internally?',evidence:[vague.s]})}
    return {items,clarifications:clar};
  }
}
/** Every citation is programmatically verified; failure downgrades the item to needs_review. */
function finalize(doc,result){
  for(const i of result.items){i.citation=validateCitation(doc,i.quote);if(!i.citation){i.confidence='needs_review';i.rationale='Source reference could not be verified in the document. '+(i.rationale||'')}}
  return result;
}
module.exports={RuleAnalyzer,finalize};
