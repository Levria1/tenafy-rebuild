export function amountInMinorUnits(raw, currency) {
  if (!raw || !currency || !Intl.supportedValuesOf('currency').includes(currency)) return null;
  const fractionDigits = new Intl.NumberFormat('en', {
    style: 'currency', currency,
  }).resolvedOptions().maximumFractionDigits;
  const match = raw.match(/^(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/);
  if (!match || (match[2]?.length || 0) > fractionDigits) return null;
  const whole = match[1].replaceAll(',', '');
  const fraction = (match[2] || '').padEnd(fractionDigits, '0');
  const minorUnits = Number(whole + fraction);
  return Number.isSafeInteger(minorUnits) ? minorUnits : null;
}

export function updateQueue(queue, rows, currency) {
  const counts = new Map();
  for (const row of rows) counts.set(row.suffix, (counts.get(row.suffix) || 0) + 1);
  for (const row of queue.values()) row.current = false;
  for (const row of rows) {
    if (counts.get(row.suffix) !== 1) {
      queue.delete(row.suffix);
      continue;
    }
    queue.set(row.suffix, {
      ...row, current: true, currency,
      minorUnits: amountInMinorUnits(row.amount, currency),
    });
  }
}
