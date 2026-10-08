const { isExpiredRequest } = require('./signatureOverlap');
const { computePaperworkState } = require('./paperworkPeriod');

function ymd(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const pad = n => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function baseRow(lease, periodStart, periodEnd) {
  return {
    lease_id: String(lease.id),
    lease_no: lease.lease_no || null,
    request_id: null,
    property_name: lease.property_name || null,
    unit_name: lease.unit_name || null,
    tenant_name: lease.tenant_name || null,
    platform_name: lease.platform_name || null,
    source_missing: !lease.platform_name,
    period_start: periodStart,
    period_end: periodEnd,
    period_recorded: true,
    signed_method: null,
    sent_at: null,
    expires_at: null,
    signed_at: null,
  };
}

function documentStatus(doc, now) {
  const status = Number(doc.status);
  if (status === 3) return 'signed';
  if (status === 4) return 'declined';
  if (status === 5 || ((status === 1 || status === 2) && isExpiredRequest(doc, now))) return 'expired';
  return 'pending';
}

function buildSigningRows({ leases = [], documents = [], from, now = new Date() }) {
  const docsByLease = new Map();
  for (const doc of documents) {
    const key = String(doc.lease_id);
    if (!docsByLease.has(key)) docsByLease.set(key, []);
    docsByLease.get(key).push(doc);
  }

  const rows = [];
  for (const lease of leases) {
    const leaseId = String(lease.id);
    const leaseStart = ymd(lease.start_date);
    const leaseEnd = ymd(lease.end_date);

    // OTA bookings (Airbnb, Agoda — any platform with requires_signature = 0) have
    // no contract to sign. Listed once per booking as 'ota' so staff can see they
    // were checked rather than missing; never treated as unsigned.
    if (lease.requires_signature != null && Number(lease.requires_signature) === 0) {
      if (leaseStart >= from) {
        rows.push({
          ...baseRow(lease, leaseStart, leaseEnd),
          key: `ota:${leaseId}`,
          kind: 'ota',
          signed_status: 'ota',
        });
      }
      continue;
    }
    const allDocs = docsByLease.get(leaseId) || [];
    const activeDocs = allDocs.filter(doc => Number(doc.status) !== 6);

    for (const doc of activeDocs) {
      const recordedStart = ymd(doc.term_start);
      const recordedEnd = ymd(doc.term_end);
      const recorded = Boolean(recordedStart && recordedEnd);
      const periodStart = recordedStart || leaseStart;
      const periodEnd = recordedEnd || leaseEnd;
      const sentAt = ymd(doc.sent_at);
      const signedAt = ymd(doc.completed_at);
      if (!(periodStart >= from || sentAt >= from || signedAt >= from)) continue;

      const signedStatus = documentStatus(doc, now);
      rows.push({
        ...baseRow(lease, periodStart, periodEnd),
        key: `doc:${String(doc.id)}`,
        request_id: String(doc.id),
        period_recorded: recorded,
        kind: 'document',
        signed_status: signedStatus,
        signed_method: signedStatus === 'signed' ? (doc.signature_method || 'esign') : null,
        sent_at: sentAt,
        expires_at: ymd(doc.expires_at),
        signed_at: signedAt,
      });
    }

    if (!activeDocs.length && leaseStart >= from) {
      rows.push({
        ...baseRow(lease, leaseStart, leaseEnd),
        key: `lease:${leaseId}`,
        kind: 'new_lease',
        signed_status: 'unsigned',
      });
      continue;
    }

    if (activeDocs.some(doc => Number(doc.status) === 3)) {
      const paperwork = computePaperworkState({ leaseEndDate: leaseEnd, documents: activeDocs });
      const gap = paperwork.uncovered;
      if (paperwork.needs_document && gap && gap.from >= from) {
        const represented = activeDocs.some(doc => (
          Number(doc.status) !== 3
          && ymd(doc.term_start) === gap.from
          && ymd(doc.term_end) === gap.to
        ));
        if (!represented) {
          rows.push({
            ...baseRow(lease, gap.from, gap.to),
            key: `gap:${leaseId}`,
            kind: 'extension',
            signed_status: 'unsigned',
          });
        }
      }
    }
  }

  rows.sort((a, b) => (
    String(b.period_start || '').localeCompare(String(a.period_start || ''))
    || String(a.unit_name || '').localeCompare(String(b.unit_name || ''))
  ));
  return rows;
}

module.exports = { buildSigningRows };
