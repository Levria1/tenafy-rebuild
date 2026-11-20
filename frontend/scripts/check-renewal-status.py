"""Check the built Vacancy page with synthetic API data; no live API/credentials.

Run npm run build in frontend, then python scripts/check-renewal-status.py.
Requires Playwright/Chromium. Starts and stops its own local Next server.
"""
import asyncio
import socket
import subprocess
import tempfile
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]

async def check(port):
    origin = f'http://127.0.0.1:{port}'
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport=dict(width=1500, height=1000))
        await context.add_cookies([dict(name='__s_t', value='SYNTHETIC-NON-AUTHENTICATING-TOKEN', url=origin)])
        page = await context.new_page()
        fixture = {}
        methods = []
        async def api(route):
            request = route.request
            methods.append(request.method)
            assert request.method in ('GET', 'OPTIONS'), 'UI inspection must never write'
            headers = {'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*', 'Access-Control-Allow-Methods':'GET,OPTIONS'}
            if request.method == 'OPTIONS':
                return await route.fulfill(status=204,headers=headers)
            data = []
            if '/user/profile' in request.url:
                data = dict(name='Test staff',permissions=['*'],orgType=6)
            elif '/advertising/vacancies' in request.url:
                data = dict(vacancies=[fixture['row']],as_of='2026-11-20',lead_days=60,expiring_count=1)
            elif '/advertising/renewal-asks' in request.url:
                data = [fixture['ask']]
            await route.fulfill(json=dict(code=200,data=data),headers=headers)
        await page.route('**/api/**',api)
        base = dict(status='expiring',source='lease',lease_id='100',unit_id='10',property_name='Example property',unit_name='5A',tenant_name='Example tenant',contract_type=3,renewal_reply=2,days_left=31,end_date='2026-12-21')
        ask = dict(lease_id='100',settled=True,reply='extend',reply_applied=True,status='extend_pending_paperwork',label='Example property 5A')
        for changes, ask_changes, expected in [
            ({},{},'Leaving'),
            ({'contract_type':1,'renewal_reply':None},{},None),
            ({'contract_type':1,'renewal_reply':1},{'settled':False},'Extend · paperwork due'),
            ({'contract_type':1,'renewal_reply':None},{'settled':False},'Replied · lease changed'),
        ]:
            fixture.update(row={**base,**changes},ask={**ask,**ask_changes})
            await page.goto(origin+'/leasing/vacancy')
            row = page.locator('tbody tr').filter(has_text='Example tenant')
            await row.wait_for()
            text = await row.inner_text()
            if expected:
                assert expected in text, text
            if expected != 'Extend · paperwork due':
                assert 'Extend · paperwork due' not in text,text
            assert not any('Example property 5A' in text for text in await page.locator('.ant-alert').all_inner_texts()), 'Settled ask must not reappear as off-page work'
        await browser.close()
        print('PASS: actual Vacancy UI shows Leaving, hides completed-cycle paperwork, preserves genuine Extend and warns about stale replies; API traffic GET/OPTIONS only')

if __name__ == '__main__':
    with socket.socket() as s:
        s.bind(('127.0.0.1',0)); port = s.getsockname()[1]
    with tempfile.TemporaryFile() as log:
        server = subprocess.Popen(['node','node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',str(port)],cwd=ROOT,stdout=log,stderr=log)
        try:
            import time
            for _ in range(100):
                if server.poll() is not None:
                    raise RuntimeError('Local Next server exited')
                try:
                    with socket.create_connection(('127.0.0.1',port),timeout=.2):
                        break
                except OSError:
                    time.sleep(.1)
            asyncio.run(check(port))
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill();server.wait()
