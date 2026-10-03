'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const S=require('./lib/service'),EX=require('./lib/example'),D=require('./lib/domain');
const PORT=process.env.PORT||3000,MAX=8*1024*1024,sessions=new Map();
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css'};
const send=(res,code,body,h={})=>{res.writeHead(code,{'Content-Type':'application/json','X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",...h});res.end(JSON.stringify(body))};
const fail=(res,e)=>send(res,e.status||500,{error:e.status?e.message:'The server could not complete this request. No document content was logged.'});
const body=req=>new Promise((ok,no)=>{let n=0;const ch=[];req.on('data',c=>{n+=c.length;if(n>MAX){no(Object.assign(new Error('File is larger than the 8 MB limit.'),{status:413}));req.destroy()}else ch.push(c)});req.on('end',()=>{try{ok(JSON.parse(Buffer.concat(ch).toString()||'{}'))}catch{no(Object.assign(new Error('Invalid request body.'),{status:400}))}})});
const user=req=>{const m=(req.headers.cookie||'').match(/sid=([a-f0-9]+)/);const uid=m&&sessions.get(m[1]);return uid&&S.db.users.find(u=>u.id===uid)};
async function extract(b){ // PDF/DOCX/text -> text. Magic bytes checked, not just the extension.
  const buf=Buffer.from(b.fileBase64,'base64');const fn=String(b.filename||'').toLowerCase();
  if(buf.slice(0,4).toString()==='%PDF'){let pdf;try{pdf=require('pdf-parse')}catch{throw Object.assign(new Error('PDF support needs the optional pdf-parse package (npm install).'),{status:501})}
    const r=await pdf(buf,{pagerender:p=>p.getTextContent().then(c=>c.items.map(i=>i.str).join(' ')+'\n\f')});
    if(r.text.replace(/\s/g,'').length<40)throw Object.assign(new Error('The uploaded PDF does not contain selectable text. OCR is not supported by this application.'),{status:422});return r.text}
  if(buf.slice(0,2).toString()==='PK'&&fn.endsWith('.docx')){let m;try{m=require('mammoth')}catch{throw Object.assign(new Error('DOCX support needs the optional mammoth package (npm install).'),{status:501})}return (await m.extractRawText({buffer:buf})).value}
  if(/\.(txt|md)$/.test(fn)&&!buf.includes(0))return buf.toString('utf8');
  throw Object.assign(new Error('Unsupported file. Upload a PDF or DOCX with selectable text, or paste the contract text.'),{status:415});
}
const routes=[];
const server0=null;const R=(m,p,fn,pub)=>routes.push({m,re:new RegExp('^'+p.replace(/:\w+/g,'([\\w-]+)')+'$'),fn,pub});
const sess=(res,u)=>{const sid=crypto.randomBytes(24).toString('hex');sessions.set(sid,u.id);return {'Set-Cookie':`sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${process.env.NODE_ENV==='production'?'; Secure':''}`}};
R('POST','/api/auth/register',async(q,r)=>{const b=await body(q);const u=S.register(b.email,b.password,b.workspace);send(r,201,{ok:1},sess(r,u))},1);
R('POST','/api/auth/login',async(q,r)=>{const b=await body(q);send(r,200,{ok:1},sess(r,S.login(b.email,b.password)))},1);
R('POST','/api/auth/logout',async(q,r)=>{send(r,200,{ok:1},{'Set-Cookie':'sid=; Max-Age=0; Path=/'})},1);
R('GET','/api/me',async(q,r,u)=>send(r,200,{email:u.email,workspace:S.db.workspaces.find(w=>w.id===u.workspaceId).name}));
R('GET','/api/example',async(q,r)=>send(r,200,{text:EX,label:'Example contract — fictional data'}));
R('GET','/api/contracts',async(q,r,u)=>send(r,200,S.db.contracts.filter(c=>c.workspaceId===u.workspaceId).map(c=>({...c,progress:S.detail(u.workspaceId,c.id).progress})).reverse()));
R('POST','/api/contracts',async(q,r,u)=>{const b=await body(q);const text=b.fileBase64?await extract(b):b.text;send(r,202,S.addVersion(u,{name:b.name,filename:b.filename,text,example:b.example}))});
R('GET','/api/contracts/:id',async(q,r,u,[id])=>{const d=S.detail(u.workspaceId,id);d?send(r,200,d):send(r,404,{error:'Contract not found.'})});
R('POST','/api/contracts/:id/versions',async(q,r,u,[id])=>{const b=await body(q);const text=b.fileBase64?await extract(b):b.text;send(r,202,S.addVersion(u,{contractId:id,filename:b.filename,text}))});
R('GET','/api/contracts/:id/summary',async(q,r,u,[id])=>{const s=S.summary(u.workspaceId,id);s?send(r,200,s):send(r,404,{error:'Contract not found.'})});
R('POST','/api/items/:id/review',async(q,r,u,[id])=>send(r,200,S.review(u,id,await body(q))));
R('GET','/api/items/:id/evidence',async(q,r,u,[id])=>{const e=S.evidence(u.workspaceId,id);e?send(r,200,e):send(r,404,{error:'Item not found.'})});
R('POST','/api/clarifications/:id',async(q,r,u,[id])=>{const b=await body(q);const c=S.db.clarifications.find(x=>x.id===id&&x.workspaceId===u.workspaceId);if(!c)return send(r,404,{error:'Clarification not found.'});
  if(b.note)c.notes.push({text:String(b.note).slice(0,1000),at:S.now()});if(b.resolved!==undefined)c.status=b.resolved?'resolved':'open';S.audit(u.workspaceId,u.id,'clarification.updated',`${c.status==='resolved'?'Resolved':'Updated'}: ${c.title}`,c.contractId);S.save();send(r,200,c)});
R('GET','/api/activity',async(q,r,u)=>send(r,200,S.db.audit.filter(a=>a.workspaceId===u.workspaceId).reverse().slice(0,200)));
http.createServer(async(req,res)=>{
  try{const url=new URL(req.url,'http://x');
    if(url.pathname==='/healthz')return send(res,200,{ok:true});
    if(url.pathname.startsWith('/api/')){const rt=routes.find(r=>r.m===req.method&&r.re.test(url.pathname));if(!rt)return send(res,404,{error:'Unknown endpoint.'});
      const u=user(req);if(!rt.pub&&!u)return send(res,401,{error:'Please sign in to continue.'});return await rt.fn(req,res,u,url.pathname.match(rt.re).slice(1))}
    const f=path.join(__dirname,'public',url.pathname==='/'?'index.html':path.normalize(url.pathname).replace(/^(\.\.[\/\\])+/,''));
    if(!f.startsWith(path.join(__dirname,'public'))||!fs.existsSync(f))return send(res,404,{error:'Not found'});
    res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});fs.createReadStream(f).pipe(res);
  }catch(e){fail(res,e)}
}).listen(PORT,'0.0.0.0',()=>console.log(`Contract assistant on http://localhost:${PORT}`));
