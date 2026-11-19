"""Synthetic panel smoke test. Chrome APIs and HTTPS endpoints are intercepted.

Exercises the real panel modules and same-origin staff fetch, not Chrome's actual
permission prompt/side-panel runtime or a live Xero/Tenafy session.
"""
import asyncio
import json
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'extensions/xero-side-panel'
ACCOUNT = 'a' * 32
FIRST = '1' * 32
SECOND = '2' * 32


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


MOCK_CHROME = r"""
const storage = {};
let listener, activated, granted = false;
globalThis.__stored = storage;
globalThis.__emitSnapshot = value => listener?.(value);
globalThis.__activate = value => activated?.(value);
globalThis.chrome = {
 storage: {local: {get: async () => structuredClone(storage), set: async value => Object.assign(storage,value)}},
 permissions: {contains: async () => granted, request: async value => {
  if(JSON.stringify(value.origins)!==JSON.stringify(['https://platform.tenafy.com/*'])) throw Error('Unexpected host access');
  granted=true; return true;
 }},
 tabs: {
  onActivated: {addListener: fn => activated=fn},
  query: async value => value.url ? [{id:77,url:'https://platform.tenafy.com/accounting',lastAccessed:1}] :
   [{id:1,windowId:1,url:'https://go.xero.com/BankRec/BankRec.aspx?accountID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}],
  connect: () => ({disconnect(){listener=undefined},onMessage:{addListener:fn=>listener=fn},onDisconnect:{addListener(){}}})
 },
 scripting: {executeScript: async value => {
  if(value.files) return [{documentId:'synthetic-xero-document'}];
  if(value.world!=='ISOLATED'||value.target.tabId!==77) throw Error('Unexpected execution target');
  return [{result:await globalThis.__staffRequest(value.func.toString(),value.args)}];
 }}
};
"""


async def run(port):
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport=dict(width=420, height=900))
        await context.add_cookies([dict(name='__s_t', value='SYNTHETIC-TEST-COOKIE',
            url='https://platform.tenafy.com', secure=True, httpOnly=True, sameSite='Lax')])
        hold_next = False
        started, release = asyncio.Event(), asyncio.Event()
        requests = []

        async def route(request):
            nonlocal hold_next
            url = request.request.url
            if url.endswith('/browser/binding'):
                return await request.fulfill(json=dict(code=200, data=dict(org_id='1', ui_org_slug='verified-org')))
            if url.endswith('/browser/lookup'):
                payload = request.request.post_data_json
                headers = await request.request.all_headers()
                assert 'SYNTHETIC-TEST-COOKIE' in headers.get('cookie', '')
                assert 'authorization' not in headers
                assert payload['expected_org_id'] == '1'
                requests.append(payload)
                if hold_next:
                    hold_next = False
                    started.set()
                    await release.wait()
                data = dict(version=1, status='leads', expires_at=(datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat(),
                    identity=dict(org_id='1', ui_org_slug=payload['ui_org_slug'], xero_account_id=payload['xero_account_id'], statement=payload['statement']),
                    candidates=[dict(id='100', kind='invoice', code='TEST-INV', tenant_name='<img id="unsafe" src=x onerror=alert(1)>',
                        reasons=['exact amount'], review_path='create_review')],
                    capabilities=dict(read_only=True, live_autofill=False, final_confirmation='staff'),
                    ambiguity=False, evidence=dict(hits=[dict(channel='whatsapp', timestamp='2026-11-19', message_id='TEST-MESSAGE', snippet='<script>unsafe()</script>')]),
                    notices=['Synthetic evidence; staff review required.'])
                return await request.fulfill(json=dict(code=200, data=data))
            return await request.fulfill(content_type='text/html', body='<title>Synthetic Tenafy staff tab</title>')

        await context.route('https://platform.tenafy.com/**', route)
        staff = await context.new_page()
        await staff.goto('https://platform.tenafy.com/accounting')
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))

        async def staff_request(source, args):
            return await staff.evaluate('value => { const fn = (0,eval)("("+value.source+")"); return fn(...value.args); }', dict(source=source, args=args))

        await page.expose_function('__staffRequest', staff_request)
        await page.add_init_script(MOCK_CHROME)
        await page.goto(f'http://127.0.0.1:{port}/panel.html')
        await page.locator('#connect').click()
        await page.locator('#connection').filter(has_text='Connected to Tenafy organisation 1').wait_for()
        await page.locator('#scan').click()
        snapshot = dict(organisation='verified-org', account=ACCOUNT, pagination='Showing items 1–2 of 2 items', rows=[
            dict(suffix=FIRST, date='19 Nov 2026', direction='Received', amount='13,800.00', summary=['TEST Received reference']),
            dict(suffix=SECOND, date='19 Nov 2026', direction='Spent', amount='3,700.00', summary=['TEST Spent reference']),
        ])
        await page.evaluate('value => __emitSnapshot(value)', snapshot)
        await page.locator('#currency').fill('HKD')
        await page.locator('#save-mapping').click()
        await page.locator('#lines > li').first.locator('button').click()
        await page.locator('.suggestions').filter(has_text='TEST-INV').wait_for()
        assert await page.locator('img#unsafe').count() == 0
        assert '<script>unsafe()</script>' in await page.locator('.suggestions').inner_text()
        assert requests[0]['statement'] == dict(id_suffix=FIRST,date='2026-11-19',direction='received',currency='HKD',amount_minor=1380000)
        output = ROOT/'artifacts/xero-side-panel'
        output.mkdir(parents=True, exist_ok=True)
        await page.screenshot(path=str(output/'synthetic-suggestions.png'), full_page=True)

        # A removed neighbour must not transfer its result/button to another row.
        reduced = {**snapshot, 'rows': snapshot['rows'][1:]}
        await page.evaluate('value => __emitSnapshot(value)', reduced)
        assert await page.locator('#lines > li').first.locator('button').is_disabled()
        assert await page.locator('.suggestions').count() == 0
        await page.evaluate('value => __emitSnapshot(value)', snapshot)

        # A delayed result for an old amount must be discarded.
        hold_next = True
        await page.locator('#lines > li').first.locator('button').click()
        await asyncio.wait_for(started.wait(), timeout=5)
        changed = json.loads(json.dumps(snapshot))
        changed['rows'][0]['amount'] = '14,000.00'
        await page.evaluate('value => __emitSnapshot(value)', changed)
        release.set()
        await page.wait_for_timeout(250)
        assert await page.locator('.suggestions').count() == 0
        await page.locator('#lines > li').first.locator('button').click()
        await page.locator('.suggestions').filter(has_text='TEST-INV').wait_for()
        assert requests[-1]['statement']['amount_minor'] == 1400000
        saved = await page.evaluate('JSON.stringify(__stored)')
        assert 'SYNTHETIC-TEST-COOKIE' not in saved and '__s_t' not in saved
        assert 'HKD' in saved
        await page.evaluate('__activate({tabId:90,windowId:1})')
        assert await page.locator('#lines > li').count() == 0
        assert errors == [], errors
        await browser.close()
        print('PASS: account setup, same-origin staff lookup, exact identity, text-only evidence, no copied credentials')
        print('PASS: removed rows and stale responses discarded; switching tabs clears the review queue')


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Quiet, directory=str(HELPER)))
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        asyncio.run(run(server.server_port))
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
