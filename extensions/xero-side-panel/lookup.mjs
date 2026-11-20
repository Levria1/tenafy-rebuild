const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function statementDate(raw) {
  const text = String(raw || '').trim().replace(/\s+/g, ' ');
  let year, month, day;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const named = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(text);
  const reverse = /^([A-Za-z]+) (\d{1,2}),? (\d{4})$/.exec(text);
  const monthIndex = name => {
    const i = months.indexOf(name.slice(0, 3).toLowerCase());
    const full = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    return i >= 0 && [months[i], full[i]].includes(name.toLowerCase()) ? i + 1 : 0;
  };
  if (iso) [, year, month, day] = iso;
  else if (named) { day = named[1]; month = monthIndex(named[2]); year = named[3]; }
  else if (reverse) { month = monthIndex(reverse[1]); day = reverse[2]; year = reverse[3]; }
  else return null;
  if (!Number(month)) return null;
  const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

export function lookupRequest(snapshot, mapping, row) {
  if (!mapping || !snapshot?.organisation || mapping.xeroOrganisation !== snapshot.organisation ||
      mapping.xeroAccount !== snapshot.account || !/^\d{1,20}$/.test(mapping.tenafyOrganisation || '')) throw Error('Map this account to the verified Tenafy organisation first.');
  if (!row?.current || !/^[0-9a-f]{32}$/.test(row.suffix || '')) throw Error('This statement line is no longer available.');
  const date = statementDate(row.date);
  if (!date) throw Error('Statement date format needs review; use an unambiguous date.');
  if (!['Spent', 'Received'].includes(row.direction) || !Number.isSafeInteger(row.minorUnits) || row.minorUnits <= 0 || row.currency !== mapping.currency) throw Error('Statement amount, direction or currency needs review.');
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency: row.currency }).resolvedOptions().maximumFractionDigits;
  if (digits > 2) throw Error('This currency exceeds Tenafy’s supported decimal precision.');
  const identity = {};
  for (const key of ['payee','reference','description']) {
    if (typeof row[key] === 'string' && row[key].trim()) {
      if (row[key].length > 1000) throw Error('Bank identity text is too long; review this line manually.');
      identity[key] = row[key].trim();
    }
  }
  // Summary spans have no reliable field labels. Only forward recognised bank
  // identity formats; do not guess which arbitrary span is a person's name.
  const recognised = (row.summary || []).filter(text => typeof text === 'string' && /\/(?:ORDP|BENM|BENE|BENEFICIARY)\/|\b(?:TRIV|LEA|INV|BILL|RCPT|PAY)[\s#:-]*[A-Z0-9-]*\d/i.test(text));
  if (!identity.description && recognised.length) {
    identity.description = recognised.join(' ');
    if(identity.description.length > 1000) throw Error('Bank identity text is too long; review this line manually.');
  }
  if (!identity.payee && !identity.reference && !identity.description && (row.summary || []).some(text => String(text).trim() && !/^(?:rent|payment|transfer|deposit|refund|fps|money transfer)$/i.test(String(text).trim()))) identity.identity_incomplete = true;
  return {
    expected_org_id: mapping.tenafyOrganisation,
    ui_org_slug: snapshot.organisation, xero_account_id: snapshot.account,
    statement: { id_suffix: row.suffix, date, direction: row.direction.toLowerCase(), currency: row.currency, amount_minor: row.minorUnits, ...identity },
  };
}
export const fingerprint = request => JSON.stringify(request);

export function validResult(result, request, now = Date.now()) {
  if (result?.version !== 1 || !Array.isArray(result.candidates) || !Array.isArray(result.notices) ||
      result?.capabilities?.read_only !== true || result.capabilities.live_autofill !== false ||
      !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) <= now) return false;
  const id = result.identity, statement = id?.statement;
  return id?.org_id === request.expected_org_id && id.ui_org_slug === request.ui_org_slug &&
    id.xero_account_id === request.xero_account_id && statement &&
    ['id_suffix', 'date', 'direction', 'currency', 'amount_minor'].every(key => statement[key] === request.statement[key]) &&
    ['payee','reference','description'].every(key => (statement[key] || '') === (request.statement[key] || '')) &&
    (statement.identity_incomplete === true) === (request.statement.identity_incomplete === true);
}
