(() => {
  if (globalThis.tenafyReviewReader) return;
  globalThis.tenafyReviewReader = true;

  const readText = (element) => element?.textContent.trim() || null;
  const linePattern = /^sl([0-9a-f]{32})$/i;
  const accountPattern = /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
  const route = '/bankrec/bankrec.aspx';

  function scan() {
    const url = new URL(location.href);
    if (url.pathname.toLowerCase() !== route) return null;
    const account = url.searchParams.get('accountID') || '';
    const root = document.querySelector('#statementLines');
    if (!root || !accountPattern.test(account)) return null;

    const slugs = new Set();
    for (const link of document.querySelectorAll('a[href*="/settings"]')) {
      let target;
      try {
        target = new URL(link.href, url);
      } catch {
        continue;
      }
      const path = target.pathname.match(/^\/app\/!([^/]+)\/settings\/?$/);
      if (target.protocol === 'https:' && target.hostname.endsWith('.xero.com') && path) {
        slugs.add(path[1]);
      }
    }

    const rows = [];
    for (const row of root.querySelectorAll(':scope > .line[id^="sl"]')) {
      const suffix = row.id.match(linePattern)?.[1]?.toLowerCase();
      const bank = row.querySelector(':scope > .bank-transaction');
      if (!suffix || !bank) continue;

      const spent = readText(bank.querySelector('.amount-spent > span'));
      const received = readText(bank.querySelector('.amount-received > span'));
      const direction = spent && !received ? 'Spent' : received && !spent ? 'Received' : null;
      const details = bank.querySelector('.line-details');
      const date = details?.querySelector(':scope > span.font-size-small');
      const summary = Array.from(details?.querySelectorAll(':scope > span') || [])
        .filter((span) => span !== date)
        .map(readText)
        .filter(Boolean);
      rows.push({
        suffix,
        date: readText(date),
        direction,
        amount: direction === 'Spent' ? spent : direction === 'Received' ? received : null,
        summary,
      });
    }

    return {
      account: account.replaceAll('-', '').toLowerCase(),
      organisation: slugs.size === 1 ? [...slugs][0] : null,
      pagination: readText(document.querySelector('nav.xui-pagination')),
      rows,
    };
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'tenafy-read-only') return;
    let timer;
    let previous;
    const publish = () => {
      const snapshot = scan();
      const serialized = JSON.stringify(snapshot);
      if (previous === serialized) return;
      previous = serialized;
      port.postMessage(snapshot);
    };
    const observer = new MutationObserver(() => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        publish();
      }, 150);
    });
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['id', 'href', 'class'],
    });
    port.onDisconnect.addListener(() => {
      observer.disconnect();
      clearTimeout(timer);
    });
    publish();
  });
})();
