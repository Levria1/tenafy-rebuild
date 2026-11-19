export const TENAFY_ORIGIN = 'https://platform.tenafy.com';
export const TENAFY_PATTERN = TENAFY_ORIGIN + '/*';

// Runs in an isolated content-script world on a signed-in Tenafy tab. Cookies
// stay with the browser's same-origin fetch; no token is read or copied out.
export async function staffRequest(operation, payload) {
  if (location.origin !== 'https://platform.tenafy.com') return { error: 'The Tenafy tab navigated away. Reconnect.' };
  const paths = { binding: '/api/integrations/xero/browser/binding', lookup: '/api/integrations/xero/browser/lookup' };
  if (!Object.hasOwn(paths, operation)) return { error: 'Unsupported operation.' };
  try {
    const response = await fetch(paths[operation], { method: operation === 'binding' ? 'GET' : 'POST',
      credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json' }, ...(operation === 'lookup' ? { body: JSON.stringify(payload) } : {}) });
    if (response.status === 401) return { error: 'Sign in to Tenafy in that browser, then reconnect.' };
    if (response.status === 403) return { error: 'Your Tenafy account does not have reconciliation access.' };
    if (response.status === 404) return { error: 'The Tenafy lookup backend has not been released yet.' };
    if (response.status === 429) return { error: 'Lookup limit reached. Wait a minute before retrying.' };
    const raw = await response.text();
    if (raw.length > 150000) return { error: 'Tenafy response exceeded the review limit.' };
    const json = JSON.parse(raw);
    if (!response.ok || json.code !== 200) return { error: json.message || 'Tenafy lookup is unavailable.' };
    return { data: json.data };
  } catch { return { error: 'Could not reach Tenafy. Keep a signed-in Tenafy tab open and retry.' }; }
}

export async function tenafyRequest(operation, payload) {
  if (!['binding', 'lookup'].includes(operation)) throw Error('Unsupported operation.');
  if (!await chrome.permissions.contains({ origins: [TENAFY_PATTERN] })) throw Error('Connect Tenafy to grant access to its tab first.');
  const tabs = await chrome.tabs.query({ url: TENAFY_PATTERN });
  const tab = tabs.filter(t => t.id && t.url?.startsWith(TENAFY_ORIGIN + '/')).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  if (!tab) throw Error('Open Tenafy and sign in, then reconnect here.');
  const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED',
    func: staffRequest, args: [operation, payload] });
  if (injection?.result?.error) throw Error(injection.result.error);
  if (!injection?.result || !Object.hasOwn(injection.result, 'data')) throw Error('Tenafy did not return a usable response.');
  return injection.result.data;
}
