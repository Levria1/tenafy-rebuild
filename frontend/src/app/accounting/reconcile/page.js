'use client';

// /accounting/reconcile — Xero reconciliation review queue.
//
// User flow:
//   1. Click "Sync Now" → backend pulls Xero transactions, stages proposals.
//   2. Each row shows: date / amount / description / proposed action + confidence.
//   3. User reviews, optionally tweaks (category / account / linked invoice),
//      then clicks Approve to commit, or Skip to discard.
//
// This is intentionally a fairly utilitarian page — it's optimised for
// throughput (you may have 50+ rows to clear after the first sync) rather
// than visual polish. Bulk actions can be layered on later.

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card, Table, Button, Tag, message, Select, Space, Typography, Tooltip,
  Modal, DatePicker, Alert, Popconfirm, Empty, Collapse, InputNumber,
} from 'antd';
import {
  SyncOutlined, CheckOutlined, CloseOutlined, LinkOutlined,
  WarningOutlined, QuestionCircleOutlined, SettingOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import MainLayout from '../../../components/Layout';
import { xero, accountingApi } from '../../../lib/api';

const { Title, Paragraph, Text } = Typography;

// Match-kind metadata — color + label + short description for the UI badge.
const KIND_META = {
  dedup_existing:   { color: 'cyan',    label: 'Link to existing', tip: 'Tenafy already has a matching entry on this date and amount. Approving will link them (no duplicate).' },
  invoice_payment:  { color: 'green',   label: 'Pay invoice',      tip: 'Matched an open invoice by amount + payer name. Approving creates a payment against that invoice.' },
  new_entry:        { color: 'blue',    label: 'New entry',        tip: 'No match found. Approving creates a fresh accounting entry in the mapped account.' },
  ambiguous:        { color: 'orange',  label: 'Ambiguous',        tip: 'Multiple Tenafy entries match the date and amount. Pick the right one before approving.' },
  unmapped_account: { color: 'red',     label: 'Unmapped',         tip: 'The Xero bank account isn\'t mapped to a Tenafy account yet. Set a target account on this row, or finish the mapping page first.' },
};

const CONFIDENCE_COLOR = { high: 'green', medium: 'gold', low: 'red' };

export default function ReconcilePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState([]);
  const [accounts, setAccounts] = useState([]);     // Tenafy account_setting list
  const [categories, setCategories] = useState([]); // Tenafy category_setting list
  const [overrides, setOverrides] = useState({});   // pending row id → { account_id, category_id }
  const [syncRange, setSyncRange] = useState(null);
  const [selected, setSelected] = useState({});   // xeroAccountId → array of row ids
  const [bulkBusy, setBulkBusy] = useState(false);
  // Balance comparison panel (Tenafy vs Xero closing balance).
  const [balances, setBalances] = useState(null);   // null = not loaded yet
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [balancesError, setBalancesError] = useState(null);
  const [invCandidates, setInvCandidates] = useState({}); // row id → [{invoice_id, invoice_code, tenant_name, outstanding, ...}]

  const loadBalances = async () => {
    setBalancesLoading(true);
    setBalancesError(null);
    try {
      const r = await xero.getBalances();
      if (r.data?.code === 200) {
        setBalances(r.data.data.balances || []);
        setBalancesError(r.data.data.report_error || null);
      } else {
        setBalancesError(r.data?.message || 'Failed to load balances');
      }
    } catch (e) {
      setBalancesError(e.response?.data?.message || 'Failed to load balances');
    } finally {
      setBalancesLoading(false);
    }
  };

  // Lazy-load when the panel is first expanded.
  const onBalancePanelChange = (keys) => {
    const open = Array.isArray(keys) ? keys.includes('balances') : keys === 'balances';
    if (open && balances === null && !balancesLoading) loadBalances();
  };

  const fmtMoney = (n) => `HK$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const loadPending = async () => {
    setLoading(true);
    try {
      const r = await xero.getPending();
      if (r.data?.code === 200) setPending(r.data.data.pending || []);
    } catch (e) {
      message.error(e.response?.data?.message || 'Failed to load pending');
    } finally {
      setLoading(false);
    }
  };

  const loadDropdowns = async () => {
    // Reuse the existing accounting settings endpoints — same data the
    // accounting page's dropdowns use.
    try {
      const [accountsRes, categoriesRes] = await Promise.all([
        accountingApi.getAccounts().catch(() => null),
        accountingApi.getCategories().catch(() => null),
      ]);
      if (accountsRes?.data?.code === 200) {
        const data = accountsRes.data.data;
        setAccounts(Array.isArray(data) ? data : (data?.content || []));
      }
      if (categoriesRes?.data?.code === 200) {
        const data = categoriesRes.data.data;
        setCategories(Array.isArray(data) ? data : (data?.content || []));
      }
    } catch (e) {
      // Non-fatal — page still works without these; user can still approve
      // dedup_existing rows that don't need a category override.
    }
  };

  useEffect(() => { loadPending(); loadDropdowns(); }, []);

  const onSync = async () => {
    setSyncing(true);
    try {
      const body = {};
      if (syncRange?.[0]) body.since_date = syncRange[0].format('YYYY-MM-DD');
      if (syncRange?.[1]) body.until_date = syncRange[1].format('YYYY-MM-DD');
      const r = await xero.sync(body);
      if (r.data?.code === 200) {
        const s = r.data.data;
        message.success(
          `Pulled ${s.pulled}, staged ${s.staged}, skipped ${s.skipped_already_imported} already-imported${s.skipped_ignored ? `, ${s.skipped_ignored} from ignored accounts` : ''}${s.errors ? `, ${s.errors} errors` : ''}.`
        );
        await loadPending();
      } else {
        message.error(r.data?.message || 'Sync failed');
      }
    } catch (e) {
      message.error(e.response?.data?.message || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const updateOverride = (id, field, value) => {
    setOverrides(prev => ({
      ...prev,
      [id]: { ...(prev[id] || {}), [field]: value },
    }));
  };

  // The account that will be used if the row is committed as a new entry —
  // the user's override, else the proposed/mapped account from the backend.
  const effectiveAccount = (row) => (overrides[row.id]?.account_id) || row.proposed_account_id || null;

  // Inflow/outflow direction. User override wins; otherwise derive from the
  // stored amount sign (negative = outflow). Rows pulled before the sign fix
  // are stored positive, so they default to inflow until the user flips them.
  const effectiveDirection = (row) =>
    overrides[row.id]?.direction || (Number(row.amount) < 0 ? 'outflow' : 'inflow');

  const loadInvCandidates = useCallback(async (row, search) => {
    try {
      const r = await xero.getInvoiceCandidates(row.id, search, effectiveDirection(row));
      if (r.data?.code === 200) setInvCandidates(prev => ({ ...prev, [row.id]: r.data.data || [] }));
    } catch { /* non-fatal — manual search still works */ }
  }, []);

  // ── Category split helpers ────────────────────────────────────────────────
  // overrides[id].lines = [{ amount, category_id }] when the user splits one
  // transaction across multiple categories (null/absent = single category).
  const setLines = (id, lines) =>
    setOverrides(prev => ({ ...prev, [id]: { ...(prev[id] || {}), lines } }));
  const splitSum = (lines) => (lines || []).reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const splitValid = (row) => {
    const lines = overrides[row.id]?.lines;
    if (!lines || !lines.length) return false;
    if (!lines.every(l => l.category_id && Number(l.amount) > 0)) return false;
    return Math.abs(splitSum(lines) - Math.abs(Number(row.amount) || 0)) < 0.01;
  };
  const splitBlockReason = (row) => {
    const lines = overrides[row.id]?.lines;
    if (!lines || !lines.length) return null;
    const cands = invCandidates[row.id] || [];
    const chosen = lines.map(l => l.invoice_id).filter(Boolean);
    if (new Set(chosen).size !== chosen.length) {
      return 'The same invoice is allocated on more than one line. Each invoice can appear only once.';
    }
    for (const l of lines) {
      const c = cands.find(x => x.invoice_id === l.invoice_id);
      if (c && Number(l.amount) > Number(c.outstanding) + 0.01) {
        return `The amount on invoice ${c.invoice_code} (HK$${Number(l.amount).toFixed(2)}) is more than its outstanding balance of HK$${Number(c.outstanding).toFixed(2)}. Lower the amount or pick another invoice.`;
      }
    }
    return null;
  };
  // A new-entry row is approvable when it has an account and, if split, the
  // split is valid (every line categorized + sums to the transaction total).
  const newEntryApprovable = (row) =>
    !!effectiveAccount(row) && (overrides[row.id]?.lines ? (splitValid(row) && !splitBlockReason(row)) : true);

  // Build the approve payload the backend expects, per match_kind. Ambiguous
  // rows resolve EITHER to a link (accounting_id) or a new entry (account_id).
  const buildBody = (row) => {
    const ov = overrides[row.id] || {};
    if (row.match_kind === 'ambiguous') {
      if (ov.link && ov.link !== '__new__') return { accounting_id: ov.link };
      // "Create as new entry instead"
      return {
        account_id: effectiveAccount(row) || undefined,
        category_id: (ov.category_id || row.proposed_category_id) || undefined,
        lines: (ov.lines && splitValid(row)) ? ov.lines.map(l => ({ amount: Number(l.amount), category_id: l.category_id, invoice_id: l.invoice_id || undefined })) : undefined,
        direction: effectiveDirection(row),
      };
    }
    return {
      account_id: effectiveAccount(row) || undefined,
      category_id: (ov.category_id || row.proposed_category_id) || undefined,
      lines: (ov.lines && splitValid(row)) ? ov.lines.map(l => ({ amount: Number(l.amount), category_id: l.category_id, invoice_id: l.invoice_id || undefined })) : undefined,
      invoice_id: (ov.invoice_id || row.proposed_invoice_id) || undefined,
      accounting_id: ov.accounting_id || undefined,
      direction: effectiveDirection(row),
    };
  };

  // A dedup_existing row whose link target wasn't captured at staging time
  // can't be linked — treat it like a new entry (needs an account chosen).
  const isBrokenLink = (row) => row.match_kind === 'dedup_existing' && !row.existing_accounting_id;

  // Whether Approve should be enabled for a row given current selections.
  const isApprovable = (row) => {
    if (row.match_kind === 'dedup_existing') return row.existing_accounting_id ? true : newEntryApprovable(row);
    if (row.match_kind === 'ambiguous') {
      const link = overrides[row.id]?.link;
      if (link && link !== '__new__') return true;        // linking to a match
      if (link === '__new__') return newEntryApprovable(row); // new entry needs an account (+ valid split if any)
      return false;                                        // no choice made yet
    }
    // new_entry / unmapped_account / invoice_payment all create an entry → need an account (+ valid split if any)
    return newEntryApprovable(row);
  };

  const onApprove = async (row) => {
    const blocked = overrides[row.id]?.lines ? splitBlockReason(row) : null;
    if (blocked) { Modal.error({ title: 'Cannot approve this allocation', content: blocked }); return; }
    try {
      const body = buildBody(row);
      const r = await xero.approvePending(row.id, body);
      if (r.data?.code === 200) {
        message.success('Committed.');
        setPending(p => p.filter(x => x.id !== row.id));
      } else {
        message.error(r.data?.message || 'Approve failed');
      }
    } catch (e) {
      message.error(e.response?.data?.message || 'Approve failed');
    }
  };

  const onSkip = async (row) => {
    try {
      const r = await xero.skipPending(row.id);
      if (r.data?.code === 200) {
        setPending(p => p.filter(x => x.id !== row.id));
      } else {
        message.error(r.data?.message || 'Skip failed');
      }
    } catch (e) {
      message.error(e.response?.data?.message || 'Skip failed');
    }
  };

  // Bulk approve the selected rows in one account. Each row carries its current
  // override (account/category picked in the UI). Rows still missing a required
  // account are reported back as failures rather than silently dropped.
  const onBulkApprove = async (xeroAccountId, rows) => {
    const ids = selected[xeroAccountId] || [];
    if (!ids.length) return;
    const items = rows
      .filter(r => ids.includes(r.id))
      .map(r => ({ id: r.id, ...buildBody(r) }));
    setBulkBusy(true);
    try {
      const r = await xero.bulkApprovePending(items);
      if (r.data?.code === 200) {
        const { approved_count, failed_count, approved, failed } = r.data.data;
        const approvedIds = new Set((approved || []).map(a => a.id));
        setPending(p => p.filter(x => !approvedIds.has(x.id)));
        setSelected(s => ({ ...s, [xeroAccountId]: [] }));
        if (failed_count > 0) {
          // Surface the actual backend reason(s) rather than a hardcoded guess.
          // Dedupe — bulk failures usually share one root cause.
          const reasons = [...new Set((failed || []).map(f => f.reason).filter(Boolean))];
          const detail = reasons.length ? `: ${reasons.join('; ')}` : '';
          message.warning(`${approved_count} committed, ${failed_count} failed${detail}`);
        } else {
          message.success(`${approved_count} committed.`);
        }
      } else {
        message.error(r.data?.message || 'Bulk approve failed');
      }
    } catch (e) {
      message.error(e.response?.data?.message || 'Bulk approve failed');
    } finally {
      setBulkBusy(false);
    }
  };

  const onBulkSkip = async (xeroAccountId) => {
    const ids = selected[xeroAccountId] || [];
    if (!ids.length) return;
    setBulkBusy(true);
    try {
      const r = await xero.bulkSkipPending(ids);
      if (r.data?.code === 200) {
        const idSet = new Set(ids);
        setPending(p => p.filter(x => !idSet.has(x.id)));
        setSelected(s => ({ ...s, [xeroAccountId]: [] }));
        message.success(`${r.data.data.skipped_count} skipped.`);
      } else {
        message.error(r.data?.message || 'Bulk skip failed');
      }
    } catch (e) {
      message.error(e.response?.data?.message || 'Bulk skip failed');
    } finally {
      setBulkBusy(false);
    }
  };

  // Group pending rows by Xero bank account for sectioned rendering.
  const grouped = useMemo(() => {
    const buckets = {};
    for (const row of pending) {
      const key = row.xero_account_id || '__unknown__';
      if (!buckets[key]) buckets[key] = { name: row.xero_account_name || '(unmapped account)', rows: [] };
      buckets[key].rows.push(row);
    }
    return buckets;
  }, [pending]);

  // Category control for a new entry: either a single Category select (+ a
  // "Split" link) or, in split mode, one amount+category line per category with
  // a running total that must equal the transaction amount.
  const renderCategoryOrSplit = (row) => {
    const ov = overrides[row.id] || {};
    const categoryId = ov.category_id || row.proposed_category_id;
    const lines = ov.lines || null;
    const amountAbs = Math.abs(Number(row.amount) || 0);
    const catOptions = categories.map(c => ({ label: c.name, value: String(c.id) }));
    const catFilter = (input, option) => (option?.label || '').toLowerCase().includes(input.toLowerCase());
    const linkBtn = { type: 'link', size: 'small', style: { padding: 0, height: 'auto', fontSize: 12 } };

    if (!lines) {
      return (
        <>
          <Select size="small" showSearch placeholder="Category" style={{ width: 220 }}
            value={categoryId || undefined}
            onChange={v => updateOverride(row.id, 'category_id', v)}
            options={catOptions} filterOption={catFilter} />
          <div>
            <Button {...linkBtn} onClick={() => {
              setLines(row.id, [{ amount: amountAbs, category_id: categoryId || null, invoice_id: null }]);
              if (!invCandidates[row.id]) loadInvCandidates(row);
            }}>
              Split invoices / categories…
            </Button>
          </div>
        </>
      );
    }
    const sum = splitSum(lines);
    const balanced = Math.abs(sum - amountAbs) < 0.01;
    return (
      <div style={{ width: 320 }}>
        {lines.map((ln, i) => (
          <Space key={i} size={4} style={{ display: 'flex', marginBottom: 4 }} align="start" wrap>
            <InputNumber size="small" prefix="$" style={{ width: 95 }} controls={false} min={0}
              value={ln.amount}
              onChange={v => { const next = lines.map((x, j) => j === i ? { ...x, amount: v } : x); setLines(row.id, next); }} />
            <Select size="small" showSearch placeholder="Category" style={{ width: 140 }}
              value={ln.category_id || undefined}
              onChange={v => { const next = lines.map((x, j) => j === i ? { ...x, category_id: v } : x); setLines(row.id, next); }}
              options={catOptions} filterOption={catFilter} status={!ln.category_id ? 'warning' : undefined} />
            <Select size="small" showSearch allowClear placeholder="Invoice (optional)" style={{ width: 200 }}
              value={ln.invoice_id || undefined}
              onSearch={(txt) => { if (txt && txt.length >= 2) loadInvCandidates(row, txt); }}
              filterOption={false} notFoundContent={null}
              status={(() => {
                const dupe = ln.invoice_id && lines.filter(x => x.invoice_id === ln.invoice_id).length > 1;
                const cand = (invCandidates[row.id] || []).find(c => c.invoice_id === ln.invoice_id);
                const over = cand && Number(ln.amount) > Number(cand.outstanding) + 0.01;
                return (dupe || over) ? 'error' : undefined;
              })()}
              options={(invCandidates[row.id] || []).map(c => ({
                value: c.invoice_id,
                label: `${c.invoice_code} · ${c.tenant_name} · out HK$${Number(c.outstanding).toFixed(2)}`,
              }))}
              onChange={(v) => {
                const cand = (invCandidates[row.id] || []).find(c => c.invoice_id === v);
                const next = lines.map((x, j) => j === i
                  ? { ...x, invoice_id: v || null, amount: (v && cand) ? Number(cand.outstanding) : x.amount }
                  : x);
                setLines(row.id, next);
              }} />
            {lines.length > 1 && (
              <Button type="text" size="small" icon={<CloseOutlined />}
                onClick={() => setLines(row.id, lines.filter((_, j) => j !== i))} />
            )}
          </Space>
        ))}
        <Space size={10} wrap style={{ fontSize: 12 }}>
          <Button {...linkBtn} onClick={() => setLines(row.id, [...lines, { amount: Math.max(0, Number((amountAbs - sum).toFixed(2))), category_id: null, invoice_id: null }])}>
            + add line
          </Button>
          <Button {...linkBtn} onClick={() => setLines(row.id, null)}>single category</Button>
          <span style={{ color: balanced ? '#52c41a' : '#ff4d4f' }}>
            HK${sum.toFixed(2)} / HK${amountAbs.toFixed(2)}{balanced ? ' ✓' : ''}
          </span>
        </Space>
        {splitBlockReason(row) && (
          <div style={{ color: '#ff4d4f', fontSize: 12, marginTop: 2 }}>⛔ {splitBlockReason(row)}</div>
        )}
      </div>
    );
  };

  const renderProposal = (row) => {
    const kind = KIND_META[row.match_kind] || { color: 'default', label: row.match_kind };
    const ov = overrides[row.id] || {};
    const accountId  = ov.account_id  || row.proposed_account_id;
    const categoryId = ov.category_id || row.proposed_category_id;

    // Per match_kind, render slightly different action chrome.
    if (row.match_kind === 'dedup_existing') {
      // Normal case: the link target is known — just link, no input needed.
      if (!isBrokenLink(row)) {
        return (
          <div>
            <div style={{ fontSize: 12, color: '#666' }}>
              Will link to existing accounting entry. No duplicate created.
            </div>
          </div>
        );
      }
      // Broken link: matched an existing entry but the target wasn't captured.
      // Fall back to creating a new entry — show the account/category pickers.
      return (
        <div>
          <div style={{ fontSize: 12, color: '#fa8c16', marginBottom: 4 }}>
            <WarningOutlined /> Matched an existing entry but the link target is missing.
            Pick an account to record it as a new entry instead, or Skip it.
          </div>
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Select
              size="small"
              showSearch
              placeholder="Account (required)"
              style={{ width: 220 }}
              value={accountId || undefined}
              onChange={v => updateOverride(row.id, 'account_id', v)}
              options={accounts.map(a => ({ label: a.name, value: String(a.id) }))}
              filterOption={(input, option) =>
                (option?.label || '').toLowerCase().includes(input.toLowerCase())
              }
              status={!accountId ? 'warning' : undefined}
            />
            <Select
              size="small"
              showSearch
              placeholder="Category"
              style={{ width: 220 }}
              value={categoryId || undefined}
              onChange={v => updateOverride(row.id, 'category_id', v)}
              options={categories.map(c => ({ label: c.name, value: String(c.id) }))}
              filterOption={(input, option) =>
                (option?.label || '').toLowerCase().includes(input.toLowerCase())
              }
            />
          </Space>
        </div>
      );
    }
    if (row.match_kind === 'invoice_payment') {
      return (
        <div>
          <div style={{ fontSize: 12 }}>
            <Text strong>Invoice {row.proposed_invoice_code}</Text>
            {row.proposed_tenant_name ? <> · {row.proposed_tenant_name}</> : null}
          </div>
          <div style={{ marginTop: 4 }}>
            <Select
              size="small"
              showSearch
              placeholder="Category"
              style={{ width: 200 }}
              value={categoryId || undefined}
              onChange={v => updateOverride(row.id, 'category_id', v)}
              options={categories.map(c => ({ label: c.name, value: String(c.id) }))}
              filterOption={(input, option) =>
                (option?.label || '').toLowerCase().includes(input.toLowerCase())
              }
            />
          </div>
        </div>
      );
    }
    if (row.match_kind === 'ambiguous') {
      const link = ov.link;
      const isNew = link === '__new__';
      return (
        <div>
          <div style={{ fontSize: 12, color: '#fa8c16', marginBottom: 4 }}>
            <WarningOutlined /> {row.ambiguous_candidates?.length || 0} Tenafy entries match
            this date &amp; amount — link one, or create new.
          </div>
          <Select
            size="small"
            style={{ width: 340 }}
            placeholder="Link to a matching entry…"
            value={link || undefined}
            onChange={v => updateOverride(row.id, 'link', v)}
            options={[
              ...(row.ambiguous_candidates || []).map(c => ({
                label: `🔗 ${c.label}`,
                value: c.accounting_id,
              })),
              { label: '➕ Create as a new entry instead', value: '__new__' },
            ]}
          />
          {isNew && (
            <Space direction="vertical" size={4} style={{ width: '100%', marginTop: 4 }}>
              <Select
                size="small"
                showSearch
                placeholder="Account (required)"
                style={{ width: 220 }}
                value={accountId || undefined}
                onChange={v => updateOverride(row.id, 'account_id', v)}
                options={accounts.map(a => ({ label: a.name, value: String(a.id) }))}
                filterOption={(input, option) =>
                  (option?.label || '').toLowerCase().includes(input.toLowerCase())
                }
                status={!accountId ? 'warning' : undefined}
              />
              {renderCategoryOrSplit(row)}
            </Space>
          )}
        </div>
      );
    }
    // new_entry or unmapped_account — needs account + category override
    return (
      <div>
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Select
            size="small"
            showSearch
            placeholder="Account (required)"
            style={{ width: 220 }}
            value={accountId || undefined}
            onChange={v => updateOverride(row.id, 'account_id', v)}
            options={accounts.map(a => ({ label: a.name, value: String(a.id) }))}
            filterOption={(input, option) =>
              (option?.label || '').toLowerCase().includes(input.toLowerCase())
            }
            status={!accountId ? 'warning' : undefined}
          />
          {renderCategoryOrSplit(row)}
        </Space>
      </div>
    );
  };

  const columns = [
    {
      title: 'Date', dataIndex: 'transaction_date', width: 110,
      render: v => v ? dayjs(v).format('YYYY-MM-DD') : '-',
    },
    {
      title: 'Direction', key: 'direction', width: 120,
      render: (_, row) => {
        const dir = effectiveDirection(row);
        return (
          <Select
            size="small"
            style={{ width: 110 }}
            value={dir}
            onChange={v => updateOverride(row.id, 'direction', v)}
            options={[
              { value: 'inflow',  label: <span style={{ color: '#52c41a' }}>Inflow</span> },
              { value: 'outflow', label: <span style={{ color: '#ff4d4f' }}>Outflow</span> },
            ]}
          />
        );
      },
    },
    {
      title: 'Amount', dataIndex: 'amount', width: 120, align: 'right',
      render: (v, row) => {
        const n = Math.abs(Number(v));
        const isOut = effectiveDirection(row) === 'outflow';
        const display = `HK$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        return isOut
          ? <span style={{ color: '#ff4d4f' }}>-{display}</span>
          : <span style={{ color: '#52c41a' }}>{display}</span>;
      },
    },
    {
      title: 'Description', key: 'desc',
      render: (_, row) => (
        <div>
          <div>{row.contact_name || row.reference || '(no contact)'}</div>
          {row.description && row.description !== row.reference && (
            <div style={{ fontSize: 11, color: '#999' }}>{row.description}</div>
          )}
        </div>
      ),
    },
    {
      title: 'Proposed Action', key: 'action_proposed', width: 160,
      render: (_, row) => {
        const kind = KIND_META[row.match_kind] || { color: 'default', label: row.match_kind, tip: '' };
        return (
          <Tooltip title={kind.tip}>
            <Tag color={kind.color}>{kind.label}</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: 'Details / Override', key: 'details',
      render: (_, row) => renderProposal(row),
    },
    {
      title: 'Confidence', dataIndex: 'confidence', width: 100,
      render: v => <Tag color={CONFIDENCE_COLOR[v] || 'default'}>{v}</Tag>,
    },
    {
      title: 'Action', key: 'act', width: 150, fixed: 'right',
      render: (_, row) => (
        <Space size={4}>
          <Button
            type="primary"
            size="small"
            icon={<CheckOutlined />}
            onClick={() => onApprove(row)}
            disabled={!isApprovable(row)}
          >
            Approve
          </Button>
          <Popconfirm
            title="Skip this transaction?"
            description="It will be marked skipped and won't reappear in this queue. You can re-stage by clearing it from the staging table."
            onConfirm={() => onSkip(row)}
          >
            <Button size="small" icon={<CloseOutlined />}>Skip</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <MainLayout>
      <div style={{ padding: '0 0 24px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 12 }}>
          <Title level={3} style={{ margin: 0 }}>Xero Reconciliation</Title>
          <Space wrap>
            <Button
              icon={<SettingOutlined />}
              onClick={() => router.push('/settings/integrations/xero/accounts')}
            >
              Account mapping
            </Button>
            <DatePicker.RangePicker
              placeholder={['Sync from', 'Sync to']}
              value={syncRange}
              onChange={setSyncRange}
              format="YYYY-MM-DD"
              allowEmpty={[true, true]}
              style={{ width: 280 }}
            />
            <Button
              type="primary"
              icon={<SyncOutlined spin={syncing} />}
              loading={syncing}
              onClick={onSync}
            >
              Sync Now
            </Button>
          </Space>
        </div>

        <Paragraph type="secondary" style={{ marginBottom: 16 }}>
          Pull bank transactions from Xero and review the proposals below.
          Nothing commits to Tenafy until you click <strong>Approve</strong>. The default
          sync range is the last 5 days; pick a specific range above to control it.
        </Paragraph>

        <Collapse
          style={{ marginBottom: 16 }}
          onChange={onBalancePanelChange}
          items={[{
            key: 'balances',
            label: (
              <span>
                <strong>Account balance check</strong>
                <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                  Compare each Tenafy account balance against its mapped Xero account
                </Text>
              </span>
            ),
            extra: (
              <Button
                size="small"
                icon={<SyncOutlined spin={balancesLoading} />}
                onClick={(e) => { e.stopPropagation(); loadBalances(); }}
              >
                Refresh
              </Button>
            ),
            children: (
              <>
                {balancesError && (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message={balancesError}
                  />
                )}
                <Table
                  size="small"
                  loading={balancesLoading}
                  dataSource={balances || []}
                  rowKey="xero_account_id"
                  pagination={false}
                  locale={{ emptyText: 'No mapped accounts. Map Xero accounts first (Account mapping).' }}
                  columns={[
                    { title: 'Tenafy Account', dataIndex: 'tenafy_account_name', render: v => v || '—' },
                    {
                      title: 'Tenafy Balance', dataIndex: 'tenafy_balance', align: 'right',
                      render: v => fmtMoney(v),
                    },
                    { title: 'Xero Account', dataIndex: 'xero_account_name', render: v => v || '—' },
                    {
                      title: 'Xero Balance', dataIndex: 'xero_balance', align: 'right',
                      render: v => v == null ? <Text type="secondary">—</Text> : fmtMoney(v),
                    },
                    {
                      title: 'Difference', dataIndex: 'difference', align: 'right',
                      render: (v) => v == null ? <Text type="secondary">—</Text>
                        : (Math.abs(v) < 0.01
                            ? <Text type="secondary">{fmtMoney(0)}</Text>
                            : <span style={{ color: '#ff4d4f' }}>{fmtMoney(v)}</span>),
                    },
                    {
                      title: 'Status', dataIndex: 'matched', align: 'center', width: 120,
                      render: (m) => m == null
                        ? <Tag>Unknown</Tag>
                        : (m ? <Tag color="green">Matched</Tag> : <Tag color="red">Unmatched</Tag>),
                    },
                  ]}
                />
              </>
            ),
          }]}
        />

        {loading ? (
          <Card><Text type="secondary">Loading…</Text></Card>
        ) : pending.length === 0 ? (
          <Empty
            description={
              <div>
                <div style={{ marginBottom: 4 }}>No pending transactions to review.</div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Click "Sync Now" to pull the latest from Xero.
                </Text>
              </div>
            }
          />
        ) : (
          Object.entries(grouped).map(([xeroAccountId, group]) => {
            const sel = selected[xeroAccountId] || [];
            return (
            <Card
              key={xeroAccountId}
              size="small"
              style={{ marginBottom: 16 }}
              title={
                <span>
                  <LinkOutlined style={{ marginRight: 6 }} />
                  {group.name}
                  <Tag style={{ marginLeft: 8 }}>{group.rows.length} pending</Tag>
                </span>
              }
              extra={
                <Space>
                  <Button
                    size="small"
                    onClick={() => setSelected(s => ({
                      ...s,
                      [xeroAccountId]: sel.length === group.rows.length ? [] : group.rows.map(r => r.id),
                    }))}
                  >
                    {sel.length === group.rows.length ? 'Clear all' : 'Select all'}
                  </Button>
                  <Button
                    type="primary"
                    size="small"
                    icon={<CheckOutlined />}
                    disabled={sel.length === 0}
                    loading={bulkBusy}
                    onClick={() => onBulkApprove(xeroAccountId, group.rows)}
                  >
                    Approve selected ({sel.length})
                  </Button>
                  <Popconfirm
                    title={`Skip ${sel.length} selected transaction(s)?`}
                    description="They'll be marked skipped and won't reappear in this queue."
                    onConfirm={() => onBulkSkip(xeroAccountId)}
                    disabled={sel.length === 0}
                  >
                    <Button size="small" icon={<CloseOutlined />} disabled={sel.length === 0} loading={bulkBusy}>
                      Skip selected ({sel.length})
                    </Button>
                  </Popconfirm>
                </Space>
              }
            >
              <Table
                rowKey="id"
                columns={columns}
                dataSource={group.rows}
                pagination={false}
                size="small"
                scroll={{ x: 1100 }}
                rowSelection={{
                  selectedRowKeys: sel,
                  onChange: (keys) => setSelected(s => ({ ...s, [xeroAccountId]: keys })),
                }}
              />
            </Card>
            );
          })
        )}
      </div>
    </MainLayout>
  );
}
