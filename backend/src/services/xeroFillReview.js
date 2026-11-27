// Read-only preparation for an explicit browser fill. No Xero write API calls.
const browser = require('./xeroBrowserLookup');
const xero = require('./xeroClient');
const { normal } = require('../utils/xeroStatementIdentity');
const { personOrCompanyName } = require('../utils/personName');
const fail = (message,status=409) => { throw Object.assign(new Error(message),{status,reviewError:true}); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
function list(response,key) { if(!Array.isArray(response?.[key])) fail('Xero review settings are unavailable.',503); return response[key]; }

async function previewAllocation(pool, orgId, body, options = {}) {
  if (body?.expected_org_id !== String(orgId)) fail('Reconnect to the expected Tenafy organisation.');
  const code = typeof body.invoice_code === 'string' ? body.invoice_code.trim() : '';
  if (!/^[A-Z0-9][A-Z0-9_-]{2,49}$/i.test(code)) fail('Enter an exact Tenafy invoice reference.',400);
  const statement = browser.validateStatement(body.statement);
  const account = browser.normalizeAccountId(body.xero_account_id);
  const slug = browser.slug(body.ui_org_slug);
  const mapping = await browser.resolveMapping(pool,orgId,slug,account,statement,options);
  const bank = mapping.bank_account_id != null;
  const propertyScope = bank ? 'p.bank_account_id=?' : `EXISTS (
    SELECT 1 FROM accounting prior WHERE prior.org_id=p.org_id AND prior.property_id=p.id
    AND prior.deleted_at IS NULL AND prior.account_setting_id=? AND UPPER(TRIM(prior.currency_type))=?)`;
  const scopeValues = bank ? [mapping.bank_account_id] : [mapping.account_setting_id,statement.currency];
  const [rows] = await pool.execute(`
    SELECT i.id,i.invoice_code,i.amount,t.first_name,t.middle_name,t.last_name,t.company_name,t.type,
      p.display_name AS property_name,u.name AS unit_name,
      i.amount-COALESCE((SELECT SUM(al.amount) FROM accounting_line al
        JOIN accounting a ON a.id=al.accounting_id AND a.org_id=i.org_id AND a.deleted_at IS NULL
        WHERE al.invoice_code=i.invoice_code AND al.deleted_at IS NULL),0) AS outstanding,
      EXISTS(SELECT 1 FROM accounting_line al
        JOIN accounting a ON a.id=al.accounting_id AND a.org_id=i.org_id AND a.deleted_at IS NULL
        WHERE al.invoice_code=i.invoice_code AND al.deleted_at IS NULL
          AND NULLIF(TRIM(a.currency_type),'') IS NULL) AS legacy_currency_labels
    FROM invoice i
    JOIN property p ON p.id=i.property_id AND p.org_id=i.org_id AND p.deleted_at IS NULL AND ${propertyScope}
    LEFT JOIN tenant t ON t.id=i.tenant_id AND t.org_id=i.org_id AND t.deleted_at IS NULL
    LEFT JOIN unit u ON u.id=i.unit_id AND u.property_id=p.id AND u.deleted_at IS NULL
    WHERE i.org_id=? AND i.deleted_at IS NULL AND i.status IN (0,2)
      AND i.currency_id=? AND i.type=? AND UPPER(i.invoice_code)=?
      AND NOT EXISTS (SELECT 1 FROM accounting_line al
        JOIN accounting a ON a.id=al.accounting_id AND a.org_id=i.org_id AND a.deleted_at IS NULL
        WHERE al.invoice_code=i.invoice_code AND al.deleted_at IS NULL
          AND (a.currency_id IS NULL OR a.currency_id<>i.currency_id
            OR (NULLIF(TRIM(a.currency_type),'') IS NOT NULL AND UPPER(TRIM(a.currency_type))<>?)))
    LIMIT 2`,[...scopeValues,orgId,mapping.currency_id,statement.direction==='received'?0:1,code.toUpperCase(),statement.currency]);
  if (rows.length !== 1) fail('No unique open invoice with that reference in this bank and currency.',404);
  const invoice = rows[0];
  const outstanding = browser.decimalMinor(invoice.outstanding,statement.digits);
  if (!outstanding) fail('This invoice has no verified outstanding balance.');
  const applied = Math.min(statement.amount_minor,outstanding);
  return {
    org_id:String(orgId),ui_org_slug:slug,xero_account_id:account,statement_id:statement.id_suffix,
    currency:statement.currency,bank_minor:statement.amount_minor,outstanding_minor:outstanding,
    invoice_minor:applied,bank_unallocated_minor:statement.amount_minor-applied,
    invoice_remaining_minor:outstanding-applied,financial_writes:false,
    legacy_currency_labels:Number(invoice.legacy_currency_labels)===1,
    invoice:{ id:String(invoice.id),code:invoice.invoice_code,name:personOrCompanyName(invoice),
      property:invoice.property_name,unit:invoice.unit_name },
  };
}
function matchingPropertyOptions(options, propertyName) {
  const wanted = normal(propertyName);
  if (!wanted) return [];
  const exact = options.filter(option => normal(option.name) === wanted);
  if (exact.length) return exact;
  const words = String(propertyName).match(/[\p{L}\p{N}]+/gu) || [];
  const initials = words.length >= 2 && words.length <= 5 ? words.map(word => word[0]).join('').toUpperCase() : '';
  return options.filter(option => {
    const inner = /\(([^()]*)\)\s*$/.exec(option.name)?.[1].trim();
    if (!inner) return false;
    if (normal(inner) === wanted) return true;
    return Boolean(initials && inner.startsWith(initials + ' ') && normal(inner.slice(initials.length)) === wanted);
  });
}

function bankDescription(statement) {
  const reference = statement.reference || '';
  const [year, month, day] = String(statement.date).split('-');
  const monthLabel = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][Number(month) - 1];
  const stamp = /^NB\d{8,16}\((\d{2}[A-Z]{3}\d{2})\)$/i.exec(reference)?.[1]?.toUpperCase();
  const description = statement.description || '';
  if (stamp && stamp === day + monthLabel + year.slice(-2) &&
      !description.toUpperCase().includes(reference.toUpperCase())) {
    return [description,reference].filter(Boolean).join('\n');
  }
  return description;
}

async function prepare(pool,orgId,body,options={}) {
  const selected=body?.candidate;
  if(!selected || !['invoice','accounting'].includes(selected.kind) || typeof selected.id!=='string' || !/^\d{1,20}$/.test(selected.id)) fail('Select an invoice or an existing Xero entry to review.',400);
  const current=await (options.lookup||browser.lookup)(pool,orgId,body,options);
  if(Object.values(current.source_status).some(s=>s!=='ok')) fail('Financial sources are incomplete. Refresh before preparing a fill.');
  const matches=current.candidates.filter(c=>c.kind===selected.kind&&c.id===selected.id);
  if(matches.length!==1) fail('This match is no longer available. Look up the bank line again.');
  const candidate=matches[0];
  if(candidate.kind==='accounting') {
    if(!candidate.xero_transaction_id) fail('This accounting entry needs manual review; do not create it again.');
    return {identity:current.identity,expires_at:current.expires_at,path:'find_and_match',candidate,
      reference:candidate.transaction_code||'',xero_transaction_id:candidate.xero_transaction_id,financial_writes:false};
  }
  if (candidate.outstanding_minor !== current.identity.statement.amount_minor) {
    fail('The invoice balance differs from this bank line. Review the allocation before using Xero.');
  }
  if(!candidate.tenant_name || !candidate.code) fail('The invoice needs a named contact and invoice reference before filling.');
  const query=body.contact_query==null?candidate.tenant_name:body.contact_query;
  if(typeof query!=='string'||query.trim().length<2||query.length>100) fail('Contact search must be 2–100 characters.',400);
  const statement=current.identity.statement;
  let reference=candidate.code;
  let description=[candidate.code,candidate.tenant_name,candidate.property_name,candidate.unit_name].filter(Boolean).join(' · ');
  const draftNotices=[];
  const bankText=bankDescription(statement);
  if(statement.direction==='received' && /\b(?:rent|rental)\b/i.test(candidate.category || '')){
    const [[invoice]]=await pool.execute(
      'SELECT note FROM invoice WHERE id=? AND org_id=? AND invoice_code=? AND deleted_at IS NULL',
      [candidate.id,orgId,candidate.code]
    );
    if(!invoice) fail('The invoice changed. Look up the bank line again.');
    const note=String(invoice.note || '').trim().replace(/\s+/g,' ');
    const rentReference=[candidate.code,note].filter(Boolean).join(' ');
    if(rentReference.length<=255) reference=rentReference;
    else draftNotices.push('The invoice notes are too long for the Xero Reference. Review a short reference before filling.');
    if(!note) draftNotices.push('No rent period is recorded in the Tenafy invoice notes. Check the reference before filling.');
    description=rentReference;
    if(!bankText) draftNotices.push('Check Xero’s statement Description and add the bank text if available.');
  }
  description=[description,bankText].filter(Boolean).join('\n');
  const bankReferences=[...new Set([candidate.code,reference])];
  const bankReferenceFilter=bankReferences.map(ref=>'Reference=='+JSON.stringify(ref)).join(' OR ');
  const remote=options.getRemote||xero.xeroApiGet;
  const controller=new AbortController();
  const get=(pool,org,path,params)=>remote(pool,org,path,params,{signal:controller.signal,timeoutMs:12000});
  let timer;
  try {
    const responses=await Promise.race([Promise.all([
      get(pool,orgId,'/Accounts',{}),get(pool,orgId,'/TaxRates',{}),
      get(pool,orgId,'/TrackingCategories',{includeArchived:false}),
      get(pool,orgId,'/Contacts',{searchTerm:query.trim(),page:1,pageSize:100}),
      get(pool,orgId,'/Invoices',{where:'InvoiceNumber=='+JSON.stringify(candidate.code)}),
      get(pool,orgId,'/BankTransactions',{where:bankReferenceFilter}),
    ]),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(new Error('Xero review settings timed out. Retry shortly.'),{status:503,reviewError:true}));},12000);})]);
    const existingInvoices=list(responses[4],'Invoices').filter(i=>i.InvoiceNumber===candidate.code&&!['DELETED','VOIDED'].includes(i.Status));
    const existingBank=list(responses[5],'BankTransactions').filter(b=>bankReferences.includes(b.Reference)&&b.Status!=='DELETED'&&String(b.BankAccount?.AccountID||'').replace(/-/g,'').toLowerCase()===current.identity.xero_account_id);
    if(existingInvoices.length||existingBank.length)return {identity:current.identity,expires_at:current.expires_at,path:'find_and_match',candidate,reference:candidate.code,financial_writes:false,existing_xero_entry:true};
    const accounts=list(responses[0],'Accounts').filter(a=>uuid(a.AccountID)&&a.Status==='ACTIVE'&&a.Type!=='BANK'&&a.Code&&a.Name)
      .map(a=>({id:a.AccountID,code:String(a.Code),name:a.Name,tax_type:a.TaxType||null}));
    const taxes=list(responses[1],'TaxRates').filter(t=>t.Status==='ACTIVE'&&t.TaxType&&t.Name)
      .map(t=>({id:t.TaxType,name:t.Name,rate:Number(t.EffectiveRate)})).filter(t=>Number.isFinite(t.rate));
    const tracking=list(responses[2],'TrackingCategories').filter(t=>t.Status==='ACTIVE'&&uuid(t.TrackingCategoryID)&&t.Name)
      .map(t=>({id:t.TrackingCategoryID,name:t.Name,options:(t.Options||[]).filter(o=>o.Status==='ACTIVE'&&uuid(o.TrackingOptionID)&&o.Name).map(o=>({id:o.TrackingOptionID,name:o.Name}))}));
    const contacts=list(responses[3],'Contacts').filter(c=>uuid(c.ContactID)&&c.ContactStatus==='ACTIVE'&&c.Name)
      .map(c=>({id:c.ContactID,name:c.Name}));
    // API IDs identify records. Duplicate display names require manual handling:
    // current browser widgets cannot always expose those IDs when committing.
    const uniqueNames=items=>items.filter(a=>items.filter(b=>normal(b.name)===normal(a.name)).length===1);
    const safeContacts=contacts.length<100?uniqueNames(contacts):[], safeAccounts=uniqueNames(accounts),safeTaxes=uniqueNames(taxes);
    const sameName=safeContacts.filter(c=>normal(c.name)===normal(candidate.tenant_name));
    const property=tracking.filter(t=>normal(t.name)==='property');
    const propertyOptions=property.length===1?matchingPropertyOptions(property[0].options,candidate.property_name):[];
    return {identity:current.identity,expires_at:current.expires_at,path:'create_details',candidate,
      fields:{date:statement.date,reference,description,amount_minor:statement.amount_minor,currency:statement.currency},
      catalogue:{accounts:safeAccounts,taxes:safeTaxes,tracking:tracking.map(t=>({...t,options:uniqueNames(t.options)})),contacts:safeContacts},
      defaults:{contact_id:sameName.length===1?sameName[0].id:null,property_category_id:property.length===1?property[0].id:null,property_option_id:propertyOptions.length===1?propertyOptions[0].id:null},
      identity_verified:['name','name_and_reference','reference'].includes(candidate.match_basis || current.matching?.mode),
      attachment_source:'staff_selected_file',financial_writes:false,
      notices:[...draftNotices,'Choose the account and tax treatment explicitly. Existing Xero transactions must use Find & Match.','Select the original receipt from the Switchboard slip review or attach the original file in Xero.','The extension fills an unsaved form only. Staff click Save Transaction and final reconciliation.']};
  } catch(error) { if(error.reviewError)throw error;fail('Could not load verified Xero contacts and settings. Reconnect or retry.',503); }
  finally {clearTimeout(timer);controller.abort();}
}
module.exports={prepare,previewAllocation};
