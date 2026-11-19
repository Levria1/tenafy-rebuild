const { personOrCompanyName } = require('../utils/personName');

/** Primary first, then additional tenant IDs ascending. Never hide an invalid
 * linked party: return an empty name so preview/send can report it to staff. */
async function loadLeaseTenants(pool, orgId, leaseId) {
  const [[lease]] = await pool.execute(`SELECT l.tenant_id FROM leasing l
    JOIN unit u ON u.id=l.unit_id JOIN property p ON p.id=u.property_id
    WHERE l.id=? AND p.org_id=? AND l.deleted_at IS NULL LIMIT 1`, [leaseId,orgId]);
  if (!lease) throw Object.assign(new Error('Lease not found'), {status:404});
  const [rows] = await pool.execute(`SELECT ids.tenant_id AS id, t.first_name,t.middle_name,t.last_name,
    t.company_name,t.type,t.id_card,t.id_type,t.email,t.phone
    FROM (SELECT ? AS tenant_id,0 AS primary_party UNION ALL
      SELECT lat.tenant_id,1 FROM leasing_additional_tenant lat WHERE lat.leasing_id=?) ids
    LEFT JOIN tenant t ON t.id=ids.tenant_id AND t.org_id=? AND t.deleted_at IS NULL
    ORDER BY ids.primary_party,CAST(ids.tenant_id AS UNSIGNED)`, [lease.tenant_id,leaseId,orgId]);
  const seen=new Set();
  return rows.filter(t=>{const id=String(t.id);if(seen.has(id))return false;seen.add(id);return true;})
    .map(t=>({...t,id:String(t.id),display_name:personOrCompanyName(t)}));
}

function normalName(s) { return String(s||'').trim().replace(/\s+/g,' '); }
function validateSigners(tenants, input) {
  const fail=message=>{throw Object.assign(new Error(message),{status:400});};
  if(!Array.isArray(input)||!input.length)fail('Add all lease tenants to the signer list.');
  const byId=new Map(tenants.map(t=>[String(t.id),t]));
  const matched=new Map(),extras=[];
  for(const p of input){
    if(!p||!['tenant','guarantor','other'].includes(p.role||'tenant'))fail('Invalid signer role.');
    const role=p.role||'tenant';
    const name=normalName(p.signer_name),email=String(p.signer_email||'').trim().toLowerCase();
    if(!name||name.length>255)fail('Every signer needs their full name.');
    if(email.length>255||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email))fail(`${name} needs a valid signing email address.`);
    if(role!=='tenant'){
      if(p.tenant_id!=null)fail('Only required lease tenants can carry a tenant ID.');
      extras.push({signer_name:name,signer_email:email,role,tenant_id:null});continue;
    }
    // Compatibility for older single-tenant clients. Joint leases require IDs.
    const id=p.tenant_id==null && tenants.length===1 ? String(tenants[0].id):String(p.tenant_id||'');
    const tenant=byId.get(id);
    if(!tenant)fail('Signer is not a tenant on this lease. Refresh the signing page.');
    if(matched.has(id))fail('A lease tenant appears more than once in the signer list.');
    if(!tenant.display_name||name!==normalName(tenant.display_name))fail('Signer name must match the tenant record. Correct the contact and refresh the preview.');
    if(email!==String(tenant.email||'').trim().toLowerCase())fail('Signing email must match the tenant record. Correct the contact and refresh the preview.');
    matched.set(id,{tenant_id:id,signer_name:tenant.display_name,signer_email:email,role:'tenant'});
  }
  if(matched.size!==tenants.length)fail('Every lease tenant must be included in the signing request. Refresh the signing page.');
  return [...tenants.map(t=>matched.get(String(t.id))),...extras];
}
module.exports={loadLeaseTenants,validateSigners};
