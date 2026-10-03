'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const D=require('./domain'),{RuleAnalyzer,finalize}=require('./analyzer');
const FILE=process.env.DB_FILE||path.join(__dirname,'..','data','db.json');
const empty=()=>({users:[],workspaces:[],contracts:[],versions:[],items:[],clarifications:[],audit:[]});
let db=fs.existsSync(FILE)?JSON.parse(fs.readFileSync(FILE,'utf8')):empty();
const save=()=>{fs.mkdirSync(path.dirname(FILE),{recursive:true});fs.writeFileSync(FILE,JSON.stringify(db),{mode:0o600})};
const id=()=>crypto.randomUUID(),now=()=>new Date().toISOString();
const analyzer=new RuleAnalyzer(); // swap provider here
const audit=(ws,user,type,summary,ref)=>{db.audit.push({id:id(),workspaceId:ws,userId:user,type,summary,ref,at:now()});};
const hash=(pw,salt=crypto.randomBytes(16).toString('hex'))=>salt+':'+crypto.scryptSync(pw,salt,64).toString('hex');
const verify=(pw,h)=>{const [s,k]=h.split(':');return crypto.timingSafeEqual(Buffer.from(hash(pw,s).split(':')[1],'hex'),Buffer.from(k,'hex'))};
const own=(ws,cid)=>db.contracts.find(c=>c.id===cid&&c.workspaceId===ws); // tenant isolation choke-point
const safeName=n=>String(n||'Pasted contract').replace(/[\\/\0<>:"|?*\x00-\x1f]/g,'_').replace(/^\.+/,'').slice(0,120)||'contract';

function register(email,password,wsName){
  if(!/^\S+@\S+\.\S+$/.test(email||'')||String(password||'').length<8)throw Object.assign(new Error('Use a valid email and a password of at least 8 characters.'),{status:400});
  if(db.users.some(u=>u.email===email.toLowerCase()))throw Object.assign(new Error('An account with this email already exists.'),{status:409});
  const w={id:id(),name:String(wsName||'My workspace').slice(0,80),createdAt:now()};const u={id:id(),email:email.toLowerCase(),pw:hash(password),workspaceId:w.id,createdAt:now()};
  db.workspaces.push(w);db.users.push(u);audit(w.id,u.id,'workspace.created','Workspace created');save();return u;
}
function login(email,password){const u=db.users.find(u=>u.email===String(email).toLowerCase());if(!u||!verify(String(password),u.pw))throw Object.assign(new Error('Email or password is incorrect.'),{status:401});return u}

/** Create contract + immutable version, then analyze asynchronously. */
function addVersion(user,{contractId,name,text,filename,example}){
  if(!text||text.trim().length<40)throw Object.assign(new Error('The document contains too little text to analyze.'),{status:422});
  let c=contractId&&own(user.workspaceId,contractId);if(contractId&&!c)throw Object.assign(new Error('Contract not found.'),{status:404});
  if(!c){c={id:id(),workspaceId:user.workspaceId,name:safeName(name||filename),example:!!example,createdAt:now(),currentVersion:0};db.contracts.push(c)}
  const n=db.versions.filter(v=>v.contractId===c.id).length+1;
  const v=Object.freeze({id:id(),contractId:c.id,workspaceId:user.workspaceId,number:n,text,sourceFile:safeName(filename||'pasted text'),uploadedAt:now()});
  db.versions.push(v);c.currentVersion=n;c.status='processing';audit(user.workspaceId,user.id,'version.uploaded',`Version ${n} uploaded: ${c.name}`,c.id);save();
  setImmediate(()=>runAnalysis(user,c,v).catch(e=>{c.status='failed';c.error='Analysis failed: '+e.message;save()}));
  return c;
}
async function runAnalysis(user,c,v){
  const doc=D.normalize(v.text,v.number);const r=finalize(doc,await analyzer.analyze(doc));
  const prev=db.items.filter(i=>i.contractId===c.id&&i.versionNumber===v.number-1);
  const changes=v.number>1?D.compareItems(prev,r.items):[];
  const items=r.items.map(i=>({...i,id:id(),contractId:c.id,workspaceId:c.workspaceId,versionNumber:v.number,aiValue:i.value,state:'pending',stale:null,calc:null}));
  const expiry=items.find(i=>i.category==='Expiry');
  for(const it of items){
    if(it.category==='Renewal notice'&&expiry&&it.numeric)it.calc=D.calcDeadline({anchor:expiry.value,days:it.numeric});
    const p=prev.find(x=>x.category===it.category&&x.key===it.key);
    if(p&&p.state!=='pending'&&D.ws(String(p.aiValue))===D.ws(String(it.value))&&D.ws(String(p.value))===D.ws(String(it.value))){it.state=p.state;it.carriedFrom=p.versionNumber} // unchanged -> carried forward
    else if(p&&p.state!=='pending'){it.stale={previousValue:p.value,previousVersion:p.versionNumber,reason:'The underlying clause changed in this version.'};}
  }
  db.items.push(...items);
  db.clarifications=db.clarifications.filter(x=>!(x.contractId===c.id&&x.status==='open'));
  db.clarifications.push(...r.clarifications.map(x=>({...x,id:id(),contractId:c.id,workspaceId:c.workspaceId,versionNumber:v.number,status:'open',notes:[]})));
  c.changes=changes;c.status=changes.some(x=>x.type==='changed')?'changes_detected':D.reviewStatus(items);
  c.failedCitations=items.filter(i=>!i.citation).length;
  audit(c.workspaceId,user.id,'analysis.completed',`Analysis of version ${v.number} completed${changes.length?`; ${changes.length} change(s) detected`:''}`,c.id);save();
}
function review(user,itemId,{action,value,reason}){
  const it=db.items.find(i=>i.id===itemId&&i.workspaceId===user.workspaceId);if(!it)throw Object.assign(new Error('Item not found.'),{status:404});
  if(it.stale&&action==='keep_previous'){it.value=it.stale.previousValue;it.state='approved'}
  else if(it.stale&&action==='approve'){it.state='approved'}
  else if(action==='approve')it.state='approved';else if(action==='reject')it.state='rejected';
  else if(action==='edit'){if(!String(value||'').trim()||!String(reason||'').trim())throw Object.assign(new Error('An edit needs a new value and a reason.'),{status:400});it.value=String(value).slice(0,500);it.state='edited';it.editReason=String(reason).slice(0,500);
    const days=+(String(value).match(/(\d+)\s*days/)||[])[1];if(it.category==='Renewal notice'&&days){const ex=db.items.find(i=>i.contractId===it.contractId&&i.versionNumber===it.versionNumber&&i.category==='Expiry');it.calc=D.calcDeadline({anchor:ex&&ex.value,days})}}
  else throw Object.assign(new Error('Unknown review action.'),{status:400});
  if(action!=='edit')delete it.editReason;it.stale=null;it.reviewedAt=now();
  audit(user.workspaceId,user.id,'item.'+it.state,`${{approved:'Approved',rejected:'Rejected',edited:'Corrected'}[it.state]}: ${it.label}${it.state==='edited'?` (${it.aiValue} → ${it.value})`:''}`,it.contractId);
  const c=own(user.workspaceId,it.contractId);const cur=db.items.filter(i=>i.contractId===c.id&&i.versionNumber===c.currentVersion);if(D.reviewStatus(cur)==='reviewed')c.status='reviewed',c.lastReviewed=now();save();return it;
}
function detail(ws,cid){
  const c=own(ws,cid);if(!c)return null;
  const items=db.items.filter(i=>i.contractId===cid&&i.versionNumber===c.currentVersion).map(i=>({...i,due:i.calc?D.dueState(i.calc.date):undefined}));
  const versions=db.versions.filter(v=>v.contractId===cid).map(({text,...v})=>v);
  return {...c,items,versions,clarifications:db.clarifications.filter(x=>x.contractId===cid),audit:db.audit.filter(a=>a.ref===cid).reverse(),progress:{done:items.filter(i=>i.state!=='pending'&&!i.stale).length,total:items.length}};
}
function evidence(ws,itemId){
  const it=db.items.find(i=>i.id===itemId&&i.workspaceId===ws);if(!it)return null;
  const v=db.versions.find(v=>v.contractId===it.contractId&&v.number===it.versionNumber);const doc=D.normalize(v.text,v.number);
  return {item:it,sourceFile:v.sourceFile,blocks:it.citation?doc.blocks.filter(b=>Math.abs(b.order-(+it.citation.blockId.split('-b')[1]))<=1):[],citation:it.citation};
}
function summary(ws,cid){
  const d=detail(ws,cid);if(!d)return null;const g=cat=>d.items.filter(i=>i.category===cat&&i.state!=='rejected');
  return {contract:d.name,version:d.currentVersion,generatedAt:now(),sections:{
    overview:[...g('Parties'),...g('Effective date'),...g('Expiry')],renewal:[...g('Renewal'),...g('Renewal notice')],obligations:g('Obligation'),termination:g('Termination'),
    openQuestions:d.clarifications.filter(x=>x.status==='open'),history:d.audit.filter(a=>/^item\./.test(a.type)),unreviewed:d.items.filter(i=>i.state==='pending').length}};
}
module.exports={get db(){return db},save,register,login,addVersion,review,detail,evidence,summary,own,audit,id,now};
