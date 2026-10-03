process.env.DB_FILE=require('path').join(require('os').tmpdir(),'cora-test-'+process.pid+'.json');
const test=require('node:test'),assert=require('node:assert'),S=require('../lib/service'),EX=require('../lib/example');
const wait=()=>new Promise(r=>setTimeout(r,100));
test('upload → analyze → review → audit; cross-workspace isolation; version change → stale',async()=>{
  const a=S.register('a@x.io','password1','A'),b=S.register('b@x.io','password1','B');
  const c=S.addVersion(a,{name:'../../evil<name>.pdf',text:EX});assert.ok(!/[\/<>]/.test(c.name));await wait();
  const d=S.detail(a.workspaceId,c.id);assert.ok(d.items.length>5);assert.equal(S.detail(b.workspaceId,c.id),null);
  assert.throws(()=>S.addVersion(b,{contractId:c.id,text:EX}),/not found/);
  const n=d.items.find(i=>i.category==='Renewal notice');assert.equal(n.confidence,'needs_review');assert.equal(n.calc,null);const orig=n.aiValue;
  S.review(a,n.id,{action:'edit',value:'60 days before expiry',reason:'Confirmed against Schedule B.'});
  const e=S.db.items.find(i=>i.id===n.id);assert.equal(e.aiValue,orig);assert.equal(e.value,'60 days before expiry');assert.equal(e.calc.date,'2027-11-01');
  assert.throws(()=>S.review(b,n.id,{action:'approve'}),/not found/);
  assert.ok(S.db.audit.some(x=>/Corrected/.test(x.summary)));
  for(const i of d.items.filter(i=>i.id!==n.id))S.review(a,i.id,{action:'approve'});
  S.addVersion(a,{contractId:c.id,text:EX.replace('January 1, 2027','February 1, 2027')});await wait();
  const d2=S.detail(a.workspaceId,c.id);assert.equal(d2.status,'changes_detected');assert.ok(d2.items.some(i=>i.stale));assert.equal(d2.versions.length,2);
});
