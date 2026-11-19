// Preserve a template author's original tenant paragraphs as a layout recipe.
// Values are escaped before substitution; template HTML is staff-authored.
const { personOrCompanyName }=require('../utils/personName');
const PARTIES='{{TENANT_PARTIES}}',SIGNATURES='{{TENANT_SIGNATURES}}';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tokens=s=>[...String(s||'').matchAll(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g)].map(m=>m[1]);
const DEFAULT_PARTIES='<p>The&nbsp;Tenant&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;:&nbsp;&nbsp;{{TENANT_NAME}}</p><p>HKID/Passport&nbsp;Number/BR&nbsp;Number:&nbsp;{{TENANT_ID_CARD}}</p>';
const DEFAULT_SIGNATURES='<p>{{SIGNATURE_TENANT}}_____________________________</p><p>Signature</p><p>Name: {{TENANT_NAME}}</p><p>I.D.No: {{TENANT_ID_CARD}}</p><p>DATE: {{TODAY_FORMATTED}}</p><p>EMAIL: {{TENANT_EMAIL}}</p><p>NUMBER: {{TENANT_PHONE}}</p>';
function parseLayout(value){
  if(!value)return null;
  let l;
  try{l=typeof value==='string'?JSON.parse(value):value;}
  catch{throw Object.assign(new Error('Invalid tenant layout.'),{status:400});}
  if(!l||l.version!==1||Object.keys(l).some(k=>!['version','parties','signatures'].includes(k))||
    !['parties','signatures'].every(k=>typeof l[k]==='string'&&l[k].length<50000))throw Object.assign(new Error('Invalid tenant layout.'),{status:400});
  if(!tokens(l.parties).includes('TENANT_NAME')||!tokens(l.parties).includes('TENANT_ID_CARD')||
    !tokens(l.signatures).includes('SIGNATURE_TENANT')||!tokens(l.signatures).includes('TENANT_NAME'))throw Object.assign(new Error('Tenant layout is missing required fields.'),{status:400});
  if([...tokens(l.parties),...tokens(l.signatures)].some(t=>['TENANT_PARTIES','TENANT_SIGNATURES'].includes(t)))throw Object.assign(new Error('Tenant layouts cannot contain repeating blocks.'),{status:400});
  return l;
}
function tenantsFor(ctx){return ctx.tenants || [ctx.tenant,...(ctx.additionalTenants||[])].filter(Boolean);}
function renderBlock(kind,ctx,substitute){
  const tenants=tenantsFor(ctx),layout=parseLayout(ctx.tenantLayout);
  const source=layout?.[kind] || (kind==='parties'?DEFAULT_PARTIES:DEFAULT_SIGNATURES);
  const rendered=tenants.map((t,i)=>{
    let html=source;
    if(kind==='parties'&&tenants.length>1)html=html.replace(/The(?:&nbsp;|\s)+Tenant/i,`Tenant&nbsp;${i+1}`);
    if(kind==='signatures'&&tenants.length>1){
      html=html.replace(/<p\b[^>]*>\s*\{\{SIGNATURE_TENANT(?:_\d+)?\}\}[\s\S]*?<\/p>/g,
        m=>m.replace(/_{20,}/,'________________________').replace(/<span\b[^>]*>(?:&nbsp;|\s)*<\/span>/g,''));
    }
    if(kind==='signatures'&&i>0)html=html.replace(/\{\{\s*(?:SIGNATURE_TENANT|SIGNATURE)\s*\}\}/g,
      i<3?`{{SIGNATURE_TENANT_${i+1}}}`:''); // Later parties use the stamper fallback.
    // The source already contains labelled signature lines. Use production-size
    // anchors in editor previews too; legacy 160px dashed placeholders can wrap
    // a two-column signature line and misrepresent its actual pagination.
    return substitute(html,{...ctx,realRender:kind==='signatures'?true:ctx.realRender,alignSignatureLines:kind==='signatures',tenant:t,tenants:[],additionalTenants:[],tenantLayout:null,escapeTemplateValues:true});
  });
  if(tenants.length===1)return rendered[0]||'';
  if(kind==='parties')return rendered.map(h=>`<div style="break-inside:avoid;page-break-inside:avoid">${h}</div>`).join('');
  return `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;${tenants.length<=2?'break-inside:avoid;page-break-inside:avoid':''}">${rendered.map(h=>`<div style="min-width:0;overflow-wrap:anywhere;${tenants.length>2?'break-inside:avoid':''}">${h}</div>`).join('')}</div>`;
}
function upgradeTemplate(html){
  const fail=()=>{throw Object.assign(new Error('This layout needs a manual tenant-block conversion. No changes were saved.'),{status:400});};
  const ps=[...String(html||'').matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/g)];
  if(tokens(html).some(t=>['TENANT_PARTIES','TENANT_SIGNATURES'].includes(t)))fail();
  const name=ps.findIndex(p=>tokens(p[0]).includes('TENANT_NAME'));
  const sig=ps.findIndex(p=>tokens(p[0]).includes('SIGNATURE_TENANT'));
  if(name<0||sig<=name+1||!tokens(ps[name+1]?.[0]).includes('TENANT_ID_CARD'))fail();
  const end=sig+6;
  const required=['SIGNATURE_TENANT',null,'TENANT_NAME','TENANT_ID_CARD','TODAY_FORMATTED','TENANT_EMAIL','TENANT_PHONE'];
  if(!required.every((key,i)=>ps[sig+i]&&(!key||tokens(ps[sig+i][0]).includes(key))))fail();
  const part=html.slice(ps[name].index,ps[name+1].index+ps[name+1][0].length);
  const signatures=html.slice(ps[sig].index,ps[end].index+ps[end][0].length);
  const body=html.replace(signatures,`<p>${SIGNATURES}</p>`).replace(part,`<p>${PARTIES}</p>`);
  // Any remaining personal placeholder could still print only the primary party.
  if(tokens(body).some(t=>/^TENANT_(NAME|FIRST_NAME|LAST_NAME|MIDDLE_NAME|EMAIL|PHONE|ID_CARD)$/.test(t)))fail();
  return {body_html:body,tenant_layout:{version:1,parties:part,signatures}};
}
function jointTemplateProblems(htmlParts,count){
  if(count<2)return [];
  const all=tokens(htmlParts.join('\n'));
  const problems=[];
  if(!all.includes('TENANT_PARTIES'))problems.push('Template needs the dynamic tenant-details block for a joint lease.');
  if(!all.includes('TENANT_SIGNATURES'))problems.push('Template needs the dynamic tenant-signatures block for a joint lease.');
  return problems;
}
function emptyTenantFields(ctx){
  return tenantsFor(ctx).flatMap((t,i)=>[
    !personOrCompanyName(t)&&`Tenant ${i+1}: legal name`,!String(t.id_card||'').trim()&&`Tenant ${i+1}: identification number`,
    !String(t.email||'').trim()&&`Tenant ${i+1}: email`,
  ].filter(Boolean));
}
module.exports={parseLayout,tenantsFor,renderBlock,upgradeTemplate,jointTemplateProblems,emptyTenantFields,escapeValue:esc};
