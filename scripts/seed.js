// Optional: npm run seed:example  -> creates demo@example.com / demo-password-1 with ONE clearly-labelled fictional contract.
const S=require('../lib/service'),EX=require('../lib/example');
let u;try{u=S.register('demo@example.com','demo-password-1','Example workspace')}catch{u=S.login('demo@example.com','demo-password-1')}
S.addVersion(u,{name:'Example contract — fictional data',text:EX,example:true});setTimeout(()=>{console.log('Seeded. Sign in as demo@example.com / demo-password-1');process.exit(0)},300);
