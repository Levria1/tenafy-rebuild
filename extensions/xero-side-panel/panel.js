import { updateQueue } from './statement.mjs';
import { lookupRequest, fingerprint, validResult } from './lookup.mjs';
import { tenafyRequest, TENAFY_PATTERN, TENAFY_ORIGIN } from './tenafy.mjs';

const status = document.querySelector('#status');
const pagination = document.querySelector('#pagination');
const list = document.querySelector('#lines');
const scan = document.querySelector('#scan');
const queue = new Map();
let port;
let scope;
let attachedTab;
let attachedWindow;
let generation = 0;
let snapshot;
let binding;
let bankCatalog;
const results = new Map();
const connection = document.querySelector('#connection');
const connect = document.querySelector('#connect');
const organisation = document.querySelector('#organisation');
const currencyInput = document.querySelector('#currency');
const saveMapping = document.querySelector('#save-mapping');

connect.addEventListener('click', async () => {
  connect.disabled = true;
  connect.textContent = 'Connecting…';
  connection.dataset.state = 'pending';
  connection.textContent = 'Checking your Tenafy session and enabled banks…';
  binding = undefined;
  bankCatalog = undefined;
  results.clear();
  try {
    if (!await chrome.permissions.request({ origins: [TENAFY_PATTERN] })) throw Error('Tenafy access was not granted. Local reading still works.');
    const next = await tenafyRequest('binding');
    if (!next?.org_id || !next.ui_org_slug) throw Error('The server-side Xero organisation binding needs configuration first.');
    const catalog = await tenafyRequest('accounts');
    if (catalog?.org_id !== next.org_id || catalog.ui_org_slug !== next.ui_org_slug || catalog.read_only !== true || !Array.isArray(catalog.accounts)) throw Error('Bank catalogue does not match the signed-in Tenafy organisation.');
    bankCatalog = catalog;
    binding = next;
    connection.dataset.state = 'connected';
    organisation.value = next.org_id;
    connection.textContent = `Connected to Tenafy organisation ${next.org_id}. ${catalog.accounts.length} enabled bank account(s) verified. Staff confirm in Xero.`;
  } catch (error) { organisation.value = ''; connection.dataset.state = 'error'; connection.textContent = error.message; }
  finally { connect.disabled = false; connect.textContent = binding ? 'Reconnect Tenafy' : 'Connect Tenafy'; if (snapshot) render(snapshot); }
});

document.querySelector('#mapping').addEventListener('submit', event => {
  event.preventDefault();
  if (!snapshot || !currentMapping(snapshot)) connection.textContent = 'This bank needs a verified enabled mapping in Tenafy.';
});

function currentMapping(value) {
  if (!binding || !bankCatalog || binding.org_id !== bankCatalog.org_id || binding.ui_org_slug !== value.organisation) return null;
  const found = bankCatalog.accounts.filter(a => a.xero_account_id === value.account);
  if (found.length !== 1) return null;
  return { xeroOrganisation: value.organisation, xeroAccount: value.account,
    tenafyOrganisation: bankCatalog.org_id, currency: found[0].currency, name: found[0].name };
}

function addText(parent, text) {
  const p = document.createElement('p'); p.textContent = text; parent.append(p);
}

function appendResults(item, state, request) {
  if (state?.pending) { addText(item, 'Looking up Tenafy leads…'); return; }
  if (state?.error) { addText(item, state.error); return; }
  if (!state?.data) return;
  if (!validResult(state.data, request)) { addText(item, 'Suggestion expired or no longer matches this row. Look up again.'); return; }
  const data = state.data;
  const box = document.createElement('section'); box.className = 'suggestions';
  addText(box, data.status === 'unavailable' ? 'Financial sources unavailable; this is not a no-match result.' :
    `${data.candidates.length} possible lead(s). ${data.ambiguity ? 'Multiple leads need review.' : 'Staff review required.'}`);
  if (data.matching) {
    addText(box, data.matching.amount_only_fallback ? 'Amount-only leads: no usable name or reference was available. Identity is unverified.' : `Identity filter: ${[data.matching.payee, ...(data.matching.references || [])].filter(Boolean).join(' · ') || 'Bank identity needs manual review'}. Unrelated amount-only leads are hidden.`);
    if (data.status === 'no_identity_match') addText(box, 'No financial match for the bank identity. No fallback to other people with the same amount.');
  }
  if (data.status === 'partial') addText(box, 'Some financial sources are unavailable. Results are incomplete.');
  const candidates = document.createElement('ul');
  for (const candidate of data.candidates.slice(0, 30)) {
    const li = document.createElement('li');
    addText(li, [candidate.kind, candidate.code || candidate.lease_no || candidate.transaction_code,
      candidate.tenant_name, candidate.property_name, candidate.unit_name].filter(Boolean).join(' · '));
    addText(li, (candidate.reasons || []).join('; '));
    addText(li, candidate.review_path === 'find_and_match_review' ? 'Review existing entry in Find & Match; no automatic selection.' : 'Review evidence before creating or matching an entry.');
    candidates.append(li);
  }
  box.append(candidates);
  const evidence = data.evidence;
  if (evidence && !evidence.unavailable) {
    const windowLabel = evidence.lookback_days === 'all' ? 'All stored history' : [6,30].includes(evidence.lookback_days) ? `${evidence.lookback_days} days ending on the bank date` : 'window unverified';
    addText(box, `Stored Switchboard history · ${windowLabel} · page ${(state.pageIndex || 0) + 1}. Amount matches are leads; currency is unverified.`);
    if (evidence.expanded_from_days === 6) addText(box, 'No matches in six days; search expanded to 30 days.');
    if (evidence.coverage?.date_window) addText(box, `Search dates: ${evidence.coverage.date_window.start} to ${evidence.coverage.date_window.end}, inclusive.`);
    if (evidence.coverage) addText(box, `${evidence.coverage.messages} retained messages searched · ${evidence.coverage.earliest || 'unknown start'} to ${evidence.coverage.latest || 'unknown end'}.`);
    if (evidence.unlinked_included === false) addText(box, 'Search is incomplete: unlinked conversations could not be safely scoped.');
    for (const hit of (evidence.hits || []).slice(0, 10)) {
      const entry = document.createElement('article'); entry.className = 'history-hit';
      const contact = hit.contact || {};
      addText(entry, [contact.name, contact.phone, contact.email].filter(Boolean).join(' · ') || 'Contact not linked');
      addText(entry, `Copied ${hit.channel} · ${hit.timestamp} · ${hit.role || 'message'} · message ${hit.message_id}`);
      addText(entry, (hit.reasons || []).join('; '));
      addText(entry, hit.snippet);
      for (const nearby of (hit.context || []).slice(0, 2)) addText(entry, `Nearby ${nearby.role} · ${nearby.timestamp}: ${nearby.snippet}`);
      if (hit.context_unavailable) addText(entry, 'Nearby messages unavailable.');
      if (/^\d{1,20}$/.test(String(hit.session_id || ''))) {
        const link = document.createElement('a');
        link.href = `${TENAFY_ORIGIN}/chatbot/sessions/${hit.session_id}`;
        link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open conversation in Tenafy'; entry.append(link);
      }
      box.append(entry);
    }
    if (!(evidence.hits || []).length) addText(box, 'No matching stored text on this page. This does not rule out a payment or an image-only receipt.');
    addText(box, 'Slip images, attachments and history not copied into Tenafy are not searched.');
    const controls = document.createElement('div'); controls.className = 'history-pages';
    const pageIndex = state.pageIndex || 0;
    for (const [label, target, cursor, enabled] of [
      ['Previous messages', pageIndex - 1, state.cursors?.[pageIndex - 1], pageIndex > 0],
      ['More messages', pageIndex + 1, evidence.next_cursor, Boolean(evidence.next_cursor)],
    ]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.disabled = !enabled || state.historyPending === true;
      button.addEventListener('click', () => historyPage(request.statement.id_suffix, request, target, cursor)); controls.append(button);
    }
    for (const [days, label] of [[30, 'Search 30 days'], ['all', 'Search all history']]) {
      if (evidence.lookback_days === days) continue;
      const choose = document.createElement('button'); choose.type = 'button'; choose.textContent = label;
      choose.disabled = state.historyPending === true;
      choose.addEventListener('click', () => historyPage(request.statement.id_suffix, request, 0, null, days)); controls.append(choose);
    }
    box.append(controls);
    if (state.historyPending) addText(box, 'Searching more stored messages…');
    if (state.historyError) addText(box, state.historyError);
  }
  if (data.evidence?.unavailable) addText(box, 'Copied message evidence is unavailable.');
  for (const notice of data.notices || []) addText(box, notice);
  item.append(box);
}

async function findLeads(suffix, request) {
  const key = fingerprint(request), attempt = generation, token = Symbol('lookup');
  results.set(suffix, { key, token, pending: true }); render(snapshot);
  let state;
  try {
    const data = await tenafyRequest('lookup', request);
    if (!validResult(data, request)) throw Error('Tenafy returned an expired or mismatched proposal. Reconnect and retry.');
    state = { key, data, cursors: [null], pageIndex: 0 };
  } catch (error) { state = { key, error: error.message }; }
  if (attempt !== generation || !snapshot || !binding || results.get(suffix)?.token !== token) return;
  try {
    const current = lookupRequest(snapshot, currentMapping(snapshot), queue.get(suffix));
    if (fingerprint(current) !== key) return;
  } catch { return; }
  results.set(suffix, state); render(snapshot);
}

async function historyPage(suffix, request, pageIndex, cursor, lookbackDays) {
  const previous = results.get(suffix), key = fingerprint(request), attempt = generation;
  if (!previous?.data || previous.key !== key || previous.historyPending || !validResult(previous.data, request)) return;
  const days = lookbackDays || previous.data.evidence.lookback_days || 6;
  const token = Symbol('history');
  results.set(suffix, { ...previous, token, historyPending: true, historyError: null }); render(snapshot);
  let next;
  try {
    const data = await tenafyRequest('history', { ...request, lookback_days: days, ...(cursor ? { cursor } : {}) });
    if (!validResult(data, request) || !data.evidence || !validResult(previous.data, request)) throw Error('Suggestion expired or changed. Look up again.');
    const cursors = days === previous.data.evidence.lookback_days ? previous.cursors.slice(0, pageIndex + 1) : [null]; cursors[pageIndex] = cursor || null;
    // A message page must not extend the lifetime of the financial proposal.
    next = { ...previous, data: { ...previous.data, evidence: data.evidence }, cursors, pageIndex };
  } catch (error) { next = { ...previous, historyError: error.message }; }
  if (attempt !== generation || !snapshot || !binding || results.get(suffix)?.token !== token) return;
  try {
    if (fingerprint(lookupRequest(snapshot, currentMapping(snapshot), queue.get(suffix))) !== key) return;
  } catch { return; }
  results.set(suffix, next); render(snapshot);
}

function clear(message) {
  queue.clear();
  snapshot = undefined;
  results.clear();
  scope = undefined;
  pagination.textContent = '';
  list.replaceChildren();
  status.textContent = message;
  document.querySelector('#scope').textContent = '';
  saveMapping.disabled = true;
  saveMapping.textContent = 'Select a Xero bank tab';
  currencyInput.value = '';
}

function render(snapshot) {
  if (!snapshot) {
    clear('Waiting for the statement lines on Xero’s Reconcile tab.');
    return;
  }
  const mapping = snapshot.organisation ? currentMapping(snapshot) : null;
  const currency = mapping?.currency || null;
  if (currency) currencyInput.value = currency;
  currencyInput.readOnly = true;
  if (!currency) currencyInput.value = '';
  const nextScope = JSON.stringify([
    snapshot.organisation, snapshot.account, mapping?.tenafyOrganisation,
  ]);
  if (nextScope !== scope || !snapshot.organisation) { queue.clear(); results.clear(); }
  scope = nextScope;

  updateQueue(queue, snapshot.rows, currency);
  pagination.textContent = snapshot.pagination || '';
  const ready = currency ? ` Bank: ${mapping.name} (${currency}).` : bankCatalog ? ' This bank is not in the verified enabled account list. Review its server mapping.' : ' Connect Tenafy to load enabled banks and currencies.';
  status.textContent = `${queue.size} statement line(s) discovered. Suggestions only; no Xero fields are edited.${ready}`;
  document.querySelector('#scope').textContent = `Xero organisation: ${snapshot.organisation || 'unverified'} · Bank account: ${snapshot.account}`;
  saveMapping.disabled = true;
  saveMapping.textContent = mapping ? 'Mapped automatically' : 'Bank setup needed';

  const entries = Array.from(queue.values(), (row) => {
    const item = document.createElement('li');
    const heading = document.createElement('strong');
    const amount = row.amount ? [row.amount, row.currency].filter(Boolean).join(' ') : 'Amount unavailable';
    heading.textContent = [row.date || 'Date unavailable', row.direction, amount].filter(Boolean).join(' · ');
    item.append(heading);
    for (const text of row.summary) {
      const detail = document.createElement('p');
      detail.textContent = text;
      item.append(detail);
    }
    if (!row.current || (row.currency && row.minorUnits === null)) {
      const note = document.createElement('p');
      note.textContent = row.current ? 'Amount format needs review.' : 'Previously discovered on this account.';
      item.append(note);
    }
    let request, issue;
    try {
      if (!binding || binding.org_id !== mapping?.tenafyOrganisation || binding.ui_org_slug !== snapshot.organisation) throw Error('Connect the matching Tenafy organisation first.');
      request = lookupRequest(snapshot, mapping, row);
    } catch (error) { issue = error.message; }
    const state = results.get(row.suffix);
    const currentState = request && state?.key === fingerprint(request) ? state : null;
    if (!currentState && state) results.delete(row.suffix);
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Find Tenafy leads';
    button.disabled = !request || currentState?.pending === true;
    button.addEventListener('click', () => findLeads(row.suffix, request)); item.append(button);
    if (issue) addText(item, issue);
    if (request) appendResults(item, currentState, request);
    return item;
  });
  list.replaceChildren(...entries);
}

setInterval(() => {
  if (snapshot && [...results.values()].some(state => state.data && Date.parse(state.data.expires_at) <= Date.now())) render(snapshot);
}, 15000);

function detach(message) {
  generation += 1;
  port?.disconnect();
  port = undefined;
  attachedTab = undefined;
  attachedWindow = undefined;
  clear(message);
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (windowId === attachedWindow && tabId !== attachedTab) {
    detach('Read this Xero tab to start a new review.');
  }
});

scan.addEventListener('click', async () => {
  detach('Connecting to Xero…');
  const attempt = generation;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (attempt !== generation) return;
    const url = tab?.url ? new URL(tab.url) : null;
    if (!url || url.protocol !== 'https:' || !url.hostname.endsWith('.xero.com') ||
        url.pathname.toLowerCase() !== '/bankrec/bankrec.aspx') {
      clear('Open the bank account’s Reconcile tab, then click the extension’s toolbar icon.');
      return;
    }

    attachedTab = tab.id;
    attachedWindow = tab.windowId;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, files: ['reader.js'],
    });
    if (attempt !== generation) return;
    const connection = chrome.tabs.connect(tab.id, {
      documentId: result.documentId, name: 'tenafy-read-only',
    });
    port = connection;
    connection.onMessage.addListener((next) => {
      if (port === connection) { snapshot = next; render(next); }
    });
    connection.onDisconnect.addListener(() => {
      if (port !== connection) return;
      port = undefined;
      attachedTab = undefined;
      attachedWindow = undefined;
      clear('Xero disconnected. Select Read this Xero tab to reconnect.');
    });
  } catch {
    if (attempt === generation) detach('Could not access the page. Open Reconcile and click the extension’s toolbar icon again.');
  }
});
