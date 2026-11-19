// Visual prototype only. No database access, API writes, signing requests or sends.
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const renderer=require('../backend/src/services/leasePdfRenderer');
const {substitute,sampleContext}=require('../backend/src/services/leaseTemplateVariables');
const {stampLease}=require('../backend/src/services/signatureStamper');
const base=require('../backend/test-support/joint-tenant-preview/base-template.json');
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paragraphs=[...base.body_html.matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/g)];
if(!paragraphs[27][0].includes('{{TENANT_NAME}}')||!paragraphs[76][0].includes('{{SIGNATURE_TENANT}}'))throw Error('Source template layout changed');
const partySource=base.body_html.slice(paragraphs[27].index,paragraphs[28].index+paragraphs[28][0].length);
const signatureSource=base.body_html.slice(paragraphs[76].index,paragraphs[82].index+paragraphs[82][0].length);
const prototype=base.body_html.replace(partySource,'{{TENANT_PARTIES}}').replace(signatureSource,'{{TENANT_SIGNATURES}}');
const alice={first_name:'Alice',last_name:'Wong',id_card:'TEST-P10001',email:'alice@example.invalid',phone:'+852 0000 0000',type:0};
const bob={first_name:'Bob',last_name:'Chan',id_card:'TEST-P10002',email:'bob@example.invalid',phone:'+852 0000 0001',type:0};
function ctxFor(tenant){const ctx=sampleContext();ctx.tenant=Object.fromEntries(Object.entries(tenant).map(([k,v])=>[k,typeof v==='string'?escape(v):v]));ctx.additionalTenants=[];ctx.today=new Date('2026-11-19T04:00:00Z');ctx.realRender=true;ctx.property={...ctx.property,street_address:'15 Example Street',display_name:'Sample Building',district:'Wan Chai',city:'Hong Kong'};return ctx;}
function expand(tenants){
 const party=tenants.map((t,i)=>{
  let html=substitute(partySource,ctxFor(t));
  if(tenants.length>1)html=html.replace('The&nbsp;Tenant','Tenant&nbsp;'+(i+1));
  return `<div style="break-inside:avoid;page-break-inside:avoid">${html}</div>`;
 }).join('');
 const signatures=tenants.map((t,i)=>{
  let html=signatureSource;
  if(i)html=html.replace('{{SIGNATURE_TENANT}}',`{{SIGNATURE_TENANT_${i+1}}}`);
  if(tenants.length>1){
   html=html.replace(/<p>\{\{SIGNATURE_TENANT(?:_\d+)?\}\}[\s\S]*?<\/p>/,m=>m.replace(/_{20,}/,'________________________').replace(/<span[\s\S]*?<\/span>/g,''));
  }
  return substitute(html,ctxFor(t));
 });
 // Preserve the existing one-tenant HTML byte-for-byte in both sections.
 const partyHtml=tenants.length===1?substitute(partySource,ctxFor(tenants[0])):party;
 const signatureHtml=tenants.length===1?signatures[0]:`<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;break-inside:avoid;page-break-inside:avoid">${signatures.map(s=>`<div style="min-width:0;overflow-wrap:anywhere">${s}</div>`).join('')}</div>`;
 return substitute(prototype.replace('{{TENANT_PARTIES}}',partyHtml).replace('{{TENANT_SIGNATURES}}',signatureHtml),ctxFor(tenants[0]));
}
async function run(){
 const out=path.resolve(process.argv[2]||path.join(root,'artifacts/joint-tenant-preview'));
 fs.mkdirSync(out,{recursive:true});
 fs.writeFileSync(path.join(out,'TEST-template-dynamic-tenant-blocks.html'),prototype);
 const watermark='<div style="color:#b00;font-size:9px">FORMATTING TEST — SYNTHETIC DATA — NOT FOR SIGNING</div>';
 const docs=[['baseline-one-tenant',[alice],true],['proposed-one-tenant',[alice]],['proposed-two-tenants',[alice,bob]],['proposed-two-long-names',[{...alice,first_name:'Alexandra Catherine',last_name:'Wong Robertson'},{...bob,first_name:'Benjamin Christopher',last_name:'Chan Montgomery',email:'benjamin.montgomery@example.invalid'}]]];
 const puppeteer=await renderer.loadPuppeteer();
 const browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox']});
 try{
  const canvas=await browser.newPage();
  for(const [name,tenants,baseline] of docs){
   const body=baseline?substitute(base.body_html,ctxFor(alice)):expand(tenants);
   const bytes=await renderer.renderInlinePreview({body_html:body,header_html:watermark+(base.header_html||''),footer_html:substitute(base.footer_html||'',ctxFor(alice)),page_size:base.page_size});
   fs.writeFileSync(path.join(out,name+'.pdf'),bytes);
   if(!baseline){
    const parties=[];
    for(let i=0;i<tenants.length;i++){
     const t=tenants[i];
     const signature=await canvas.evaluate(label=>{const c=document.createElement('canvas');c.width=440;c.height=110;const p=c.getContext('2d');p.fillStyle='#194a99';p.font='italic 32px serif';p.fillText(label,8,60);return c.toDataURL('image/png');},'TEST '+t.first_name);
     parties.push({id:String(i+1),role:'tenant',sort_order:i,status:2,signature_png:signature,signer_name:t.first_name+' '+t.last_name,typed_name:t.first_name+' '+t.last_name,signer_email:t.email,signed_at:new Date('2026-11-19T04:00:00Z')});
    }
    const signed=await stampLease({unsignedPdf:bytes,parties,landlordSig:null,request:{id:'FORMAT-TEST-ONLY',lease_id:'SYNTHETIC',created_at:new Date('2026-11-19T04:00:00Z')}});
    fs.writeFileSync(path.join(out,name+'-simulated-signatures.pdf'),signed);
   }
   console.log('Rendered',name);
  }
 }finally{await browser.close();}
 console.log('Output:',out);
}
run().then(()=>process.exit(0)).catch(e=>{console.error(e.stack);process.exit(1);});
