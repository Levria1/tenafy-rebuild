import { accounts } from './accounts.js';
import { updateQueue } from './statement.mjs';
import { lookupRequest, fingerprint, validResult } from './lookup.mjs';
import { tenafyRequest, TENAFY_PATTERN } from './tenafy.mjs';

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
let storedAccounts = [];
const results = new Map();
const connection = document.querySelector('#connection');
const connect = document.querySelector('#connect');
const organisation = document.querySelector('#organisation');
const currencyInput = document.querySelector('#currency');
const saveMapping = document.querySelector('#save-mapping');

chrome.storage.local.get('tenafyAccounts').then(value => {
  storedAccounts = Array.isArray(value.tenafyAccounts) ? value.tenafyAccounts.filter(a => a && typeof a === 'object') : [];
  if (snapshot) render(snapshot);
}).catch(() => { connection.textContent = 'Saved account mappings could not be loaded.'; });

connect.addEventListener('click', async () => {
  connect.disabled = true;
  binding = undefined;
  results.clear();
  try {
    if (!await chrome.permissions.request({ origins: [TENAFY_PATTERN] })) throw Error('Tenafy access was not granted. Local reading still works.');
    const next = await tenafyRequest('binding');
    if (!next?.org_id || !next.ui_org_slug) throw Error('The server-side Xero organisation binding needs configuration first.');
    binding = next;
    organisation.value = next.org_id;
    connection.textContent = `Connected to Tenafy organisation ${next.org_id}. Suggestions only; staff confirm in Xero.`;
  } catch (error) { organisation.value = ''; connection.textContent = error.message; }
  finally { connect.disabled = false; if (snapshot) render(snapshot); }
});

currencyInput.addEventListener('input', () => { currencyInput.value = currencyInput.value.toUpperCase(); });
document.querySelector('#mapping').addEventListener('submit', async event => {
  event.preventDefault();
  const currency = currencyInput.value.trim();
  if (!binding || !snapshot?.organisation || binding.ui_org_slug !== snapshot.organisation || !Intl.supportedValuesOf('currency').includes(currency)) {
    connection.textContent = 'Connect the matching Tenafy organisation and supply the verified bank currency.';
    return;
  }
  const entry = { xeroOrganisation: snapshot.organisation, xeroAccount: snapshot.account,
    tenafyOrganisation: binding.org_id, currency };
  const next = storedAccounts.filter(a => a.xeroOrganisation !== entry.xeroOrganisation || a.xeroAccount !== entry.xeroAccount);
  next.push(entry);
  try {
    await chrome.storage.local.set({ tenafyAccounts: next });
    storedAccounts = next;
    results.clear();
    render(snapshot);
  } catch { connection.textContent = 'Account mapping could not be saved. Retry before requesting suggestions.'; }
});

function currentMapping(value) {
  const saved = storedAccounts.filter(a => a.xeroOrganisation === value.organisation && a.xeroAccount === value.account);
  const matching = saved.length ? saved : accounts.filter(a => a.xeroOrganisation === value.organisation && a.xeroAccount === value.account);
  return matching.length === 1 ? matching[0] : null;
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
  for (const hit of (data.evidence?.hits || []).slice(0, 10)) addText(box, `Copied ${hit.channel} · ${hit.timestamp} · message ${hit.message_id}: ${hit.snippet}`);
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
    state = { key, data };
  } catch (error) { state = { key, error: error.message }; }
  if (attempt !== generation || !snapshot || !binding || results.get(suffix)?.token !== token) return;
  try {
    const current = lookupRequest(snapshot, currentMapping(snapshot), queue.get(suffix));
    if (fingerprint(current) !== key) return;
  } catch { return; }
  results.set(suffix, state); render(snapshot);
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
}

function render(snapshot) {
  if (!snapshot) {
    clear('Waiting for the statement lines on Xero’s Reconcile tab.');
    return;
  }
  const mapping = snapshot.organisation ? currentMapping(snapshot) : null;
  const currency = mapping?.currency || null;
  const nextScope = JSON.stringify([
    snapshot.organisation, snapshot.account, mapping?.tenafyOrganisation,
  ]);
  if (nextScope !== scope || !snapshot.organisation) { queue.clear(); results.clear(); }
  scope = nextScope;

  updateQueue(queue, snapshot.rows, currency);
  pagination.textContent = snapshot.pagination || '';
  const ready = currency ? '' : ' Configure the organisation and bank account currency to parse amounts.';
  status.textContent = `${queue.size} statement line(s) discovered. Suggestions only; no Xero fields are edited.${ready}`;
  document.querySelector('#scope').textContent = `Xero organisation: ${snapshot.organisation || 'unverified'} · Bank account: ${snapshot.account}`;
  saveMapping.disabled = !binding || binding.ui_org_slug !== snapshot.organisation;

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
