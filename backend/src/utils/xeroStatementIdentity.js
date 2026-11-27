// Bank text is data only. Match complete name words and bounded reference tokens.
const normal = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const cleanName = value => String(value || '').trim().replace(/\s+/g,' ').replace(/^(?:mr|mrs|ms|miss|dr)\.?\s+/i,'');
function nameForms(value) {
  const name=cleanName(value), words=name.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
  const forms=new Set([normal(name)]);
  if(words.length>1&&words.length<=4){
    const visit=(prefix,rest)=>{if(!rest.length){forms.add(prefix.join(''));return;}for(let i=0;i<rest.length;i++)visit([...prefix,rest[i]],rest.filter((_,n)=>n!==i));};
    visit([],words);
  }
  return [...forms].filter(Boolean);
}
function usableName(value) {
  const name=cleanName(value), compact=normal(name);
  return /\p{L}{2}/u.test(compact) && !/\.{3}|…/.test(name) && !new Set(['moneytransfer','transfer','payment','rent','deposit','refund','unknown','none','na','fps']).has(compact);
}
function businessRefs(value) {
  return [...new Set((String(value||'').match(/\b(?:TRIV|LEA|INV|BILL|RCPT|PAY)[\s#:-]*[A-Z0-9-]*\d[A-Z0-9-]*/gi)||[]).map(normal))].filter(s=>s.length>=5&&s.length<=80).slice(0,8);
}
function referencePattern(refs) {
  return `(?<![[:alnum:]])(?:${refs.map(r=>r.split('').join('[[:space:]#:-]*')).join('|')})(?![[:alnum:]])`;
}
function nameWords(value) {
  return cleanName(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .match(/\p{L}[\p{L}\p{M}]*/gu) || [];
}
const partialWords = value => [...new Set(nameWords(value).filter(word => word.length >= 2))];
function partialPolicy(policy) {
  if (!policy.payee || policy.name_source === 'remittance' || policy.direction !== 'received' ||
      isPaymentProcessor(policy.payee)) return [];
  const words = partialWords(policy.payee);
  return words.length >= 3 && words.length <= 6 ? words : [];
}
function isPaymentProcessor(value) {
  return /^(?:visa payments(?: limited| ltd)?|(?:transfer)?wise payments(?: hong kong)?(?: limited| ltd)?)$/i.test(cleanName(value));
}
function remittanceName(description) {
  const field = description.match(/\/REMI\/([^/]{1,200})(?:\/|$)/i)?.[1];
  const name = cleanName(field?.split(/[,;]/, 1)[0]);
  const words = nameWords(name);
  // Only a short name-shaped remittance prefix, with at least two full words.
  if (!/^[\p{L}\p{M}][\p{L}\p{M}\s.'’\-]+$/u.test(name) ||
      words.length > 5 || new Set(words.filter(word => word.length >= 3)).size < 2) return null;
  if (words.some(word => /^(?:for|from|payment|transfer|november|rent|invoice|deposit|thanks|reference)$/i.test(word))) return null;
  return name;
}
function identityFor(statement) {
  const description=String(statement.description||'');
  const marker=statement.direction==='spent'?'(?:BENM|BENE|BENEFICIARY)':'ORDP';
  const matches=[...description.matchAll(new RegExp(`/${marker}/([^/]{2,200})/(?=[A-Z]{3,12}/|$)`,'gi'))].map(m=>cleanName(m[1])).filter(usableName);
  const explicit=usableName(statement.payee)?cleanName(statement.payee):null;
  const processor = statement.direction === 'received' && [explicit, ...matches].some(isPaymentProcessor);
  const remitter = processor ? remittanceName(description) : null;
  const reported = [...(explicit?[explicit]:[]), ...matches];
  const distinct = remitter ? [...reported.filter(name => !isPaymentProcessor(name)), remitter] : reported;
  const conflict=distinct.some(name=>!nameForms(name).some(form=>nameForms(distinct[0]).includes(form)));
  const payee=distinct[0] || null;
  const structuredIncomplete=(!payee&&/\.{3}|…/.test(String(statement.payee||'')))||!payee&&new RegExp(`/${marker}/`,'i').test(description);
  const refs=businessRefs([statement.reference,description].join(' '));
  // A bank tracking reference is useful on its own, but does not override an
  // identified name merely because it is not a Tenafy invoice reference.
  if(!refs.length&&!payee){
    for(const token of String(statement.reference||'').split(/[,;\n]/)){
      const ref=normal(token);if(ref.length>=6&&ref.length<=80&&/\d/.test(ref))refs.push(ref);
      if(refs.length>=8)break;
    }
  }
  const mode=conflict?'identity_conflict':(structuredIncomplete||statement.identity_incomplete===true)?'identity_unreadable':payee&&refs.length?'name_and_reference':payee?'name':refs.length?'reference':'amount_only';
  return {mode,payee,direction:statement.direction,references:[...new Set(refs)],name_forms:payee?nameForms(payee):[],reference_pattern:refs.length?referencePattern([...new Set(refs)]):null,
    name_source: remitter ? 'remittance' : null,
    remittance_words: remitter ? [...new Set(nameWords(remitter).filter(word => word.length >= 3))] : []};
}
function candidateNames(row) {
  if(Number(row.type)===1)return [row.company_name].filter(Boolean);
  return [[row.first_name,row.middle_name,row.last_name].filter(Boolean).join(' '),[row.first_name,row.last_name].filter(Boolean).join(' ')].filter(Boolean);
}
function tenantNameColumns(alias='t') {
  return [
    `CASE WHEN ${alias}.type=1 THEN ${alias}.company_name ELSE CONCAT_WS(' ',${alias}.first_name,${alias}.middle_name,${alias}.last_name) END`,
    `CASE WHEN COALESCE(${alias}.type,0)<>1 THEN CONCAT_WS(' ',${alias}.first_name,${alias}.last_name) ELSE '' END`,
    `CASE WHEN COALESCE(${alias}.type,0)<>1 THEN CONCAT_WS(' ',${alias}.last_name,${alias}.first_name,${alias}.middle_name) ELSE '' END`,
    `CASE WHEN COALESCE(${alias}.type,0)<>1 THEN CONCAT_WS(' ',${alias}.last_name,${alias}.first_name) ELSE '' END`,
  ];
}
function normalSql(expression) {
  return `REGEXP_REPLACE(REGEXP_REPLACE(LOWER(CONVERT(COALESCE(${expression},'') USING utf8mb4)),'^(mr|mrs|ms|miss|dr)[.[:space:]]+',''),'[^[:alnum:]]','') COLLATE utf8mb4_0900_ai_ci`;
}
function identitySql(policy,{names=[],references=[],contentName=null,partialName=null}={}) {
  if(policy.mode==='identity_conflict'||policy.mode==='identity_unreadable')return {sql:'1=0',params:[]};
  const parts=[],params=[];
  if(policy.payee){
    const alternatives=names.map(expr=>{params.push(...policy.name_forms);return `${normalSql(expr)} IN (${policy.name_forms.map(()=>'?').join(',')})`;});
    const remittanceWords = policy.remittance_words || [];
    if(contentName && !remittanceWords.length){
      for(const form of policy.name_forms){alternatives.push(`LOCATE(?,${normalSql(contentName)})>0`);params.push(form);}
    }
    if (remittanceWords.length >= 2) {
      for (const expression of [...names, ...(contentName ? [contentName] : [])]) {
        const checks = remittanceWords.map(word => {
          params.push(`(^|[^[:alnum:]])${word}([^[:alnum:]]|$)`);
          return `REGEXP_LIKE(CONVERT(COALESCE(${expression},'') USING utf8mb4) COLLATE utf8mb4_0900_ai_ci,?,'i')`;
        });
        alternatives.push(`(${checks.join(' AND ')})`);
      }
    }
    const words = partialName ? partialPolicy(policy) : [];
    if (words.length) {
      const checks = words.map(word => {
        params.push(`(^|[^[:alnum:]])${word}([^[:alnum:]]|$)`);
        return `REGEXP_LIKE(CONVERT(COALESCE(${partialName},'') USING utf8mb4) COLLATE utf8mb4_0900_ai_ci,?,'i')`;
      });
      alternatives.push(`((${checks.join(' + ')}) >= ${Math.max(3, words.length - 1)})`);
    }
    parts.push(alternatives.length?'('+alternatives.join(' OR ')+')':'1=0');
  }
  if(policy.references.length){
    parts.push(references.length?'('+references.map(column=>{params.push(policy.reference_pattern);return `REGEXP_LIKE(COALESCE(${column},''),?,'i')`;}).join(' OR ')+')':'1=0');
  }
  return {sql:parts.length?parts.join(' AND '):'1=1',params};
}
function candidateNameMatch(policy,candidate) {
  const names = candidate._identity_names || [candidate.tenant_name];
  const expected = new Set(policy.name_forms);
  const remittanceWords = policy.remittance_words || [];
  if (remittanceWords.length >= 2 && names.some(name => {
    const words = new Set(nameWords(name));
    return remittanceWords.every(word => words.has(word));
  })) return 'remittance';
  if (names.some(name => nameForms(name).some(form => expected.has(form)))) return 'exact';
  const words = candidate.kind === 'invoice' && candidate._identity_company !== true ? partialPolicy(policy) : [];
  if (!words.length) return null;
  const other = partialWords(names[0]);
  const overlap = other.filter(word => words.includes(word)).length;
  return overlap >= Math.max(3, words.length - 1, other.length - 1) ? 'partial' : null;
}
function matchesCandidate(policy,candidate) {
  if(policy.mode==='identity_conflict'||policy.mode==='identity_unreadable')return false;
  if(policy.payee&&!candidateNameMatch(policy,candidate))return false;
  if(policy.references.length){
    const text=[candidate.code,candidate.lease_no,candidate.transaction_code,candidate.xero_transaction_id,candidate._identity_reference || candidate.note].filter(Boolean).join(' ');
    const pattern=policy.references.map(ref=>ref.split('').join('[\\s#:-]*')).join('|');
    if(!new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`,'iu').test(text))return false;
  }
  return true;
}
module.exports={identityFor,identitySql,tenantNameColumns,candidateNames,matchesCandidate,candidateNameMatch,nameForms,normal};
