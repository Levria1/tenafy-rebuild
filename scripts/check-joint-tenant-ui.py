"""Smoke-test a local production frontend with synthetic API responses only.

Start Next on 127.0.0.1:4067 first. Requires Python playwright + Chromium.
Every API request is intercepted; no request reaches a Tenafy backend.
"""
import json
import re
from pathlib import Path
import subprocess
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
ARTIFACTS=ROOT/'artifacts/joint-tenant-preview'
fixture=json.loads((ROOT/'backend/test-support/joint-tenant-preview/base-template.json').read_text())
tenants=[{'tenant_id':'1','signer_name':'Alice Wong','signer_email':'alice@example.invalid','role':'tenant'},
         {'tenant_id':'2','signer_name':'Bob Chan','signer_email':'bob@example.invalid','role':'tenant'}]
lease={'id':'100','lease_no':'SYNTHETIC','start_date':'2026-11-01','end_date':'2027-10-31',
       'allowed_template_ids':[],'signing_tenants':tenants,
       'paperwork':{'uncovered':{'from':'2026-11-01','to':'2027-10-31'}}}
seen={'send':[],'preview_counts':[],'save':[]}
pdf=(ARTIFACTS/'proposed-two-tenants.pdf').read_bytes()
headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Authorization, Content-Type',
         'Access-Control-Allow-Methods':'GET, POST, PUT, OPTIONS','Access-Control-Expose-Headers':'X-Tenant-Template-Ready, X-Document-Snapshot'}

def intercept(route):
    req=route.request;u=urlsplit(req.url)
    if '/api/' not in u.path:
        if u.hostname not in ('127.0.0.1','localhost'):
            return route.abort()
        return route.continue_()
    if req.method=='OPTIONS':
        return route.fulfill(status=204,headers=headers)
    payload=req.post_data_json if req.post_data else None
    result=[];status=200
    if u.path=='/api/user/profile':
        result={'id':'7','name':'Synthetic staff','orgType':6,'permissions':['*']}
    elif u.path=='/api/leasing/100':
        result=lease
    elif u.path=='/api/lease-template/list':
        result=[{'id':'1','name':'Test contract','is_default':1}]
    elif u.path=='/api/signature/landlord-signatures':
        result=[{'id':'11','label':'Sample landlord','is_default':1}]
    elif u.path=='/api/pdf/lease/100':
        return route.fulfill(status=200,headers={**headers,'Content-Type':'application/pdf','X-Tenant-Template-Ready':'true','X-Document-Snapshot':'synthetic-preview-hash'},body=pdf)
    elif u.path=='/api/signature/request':
        seen['send'].append(payload)
        # Keep the screen open after inspecting the DTO; never create/send a request.
        return route.fulfill(status=400,headers=headers,json={'code':400,'message':'Synthetic transport check: no request created.'})
    elif u.path=='/api/lease-template/1' and req.method=='GET':
        result={**fixture,'id':'1','name':'Synthetic template','version':3,'tenant_layout':None,'property_ids':[]}
    elif u.path=='/api/lease-template/tenant-upgrade':
        script="const fs=require('fs');const b=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(require('./backend/src/services/tenantTemplateBlocks').upgradeTemplate(b.body_html)));"
        result=json.loads(subprocess.check_output(['node','-e',script],input=json.dumps(payload).encode(),cwd=ROOT))
    elif u.path=='/api/lease-template/preview':
        seen['preview_counts'].append(payload['tenant_count'])
        return route.fulfill(status=200,headers={**headers,'Content-Type':'application/pdf'},body=pdf)
    elif u.path=='/api/lease-template/1' and req.method=='PUT':
        seen['save'].append(payload)
        return route.fulfill(status=409,headers=headers,json={'code':409,'message':'Synthetic transport check: no template saved.'})
    return route.fulfill(status=status,headers=headers,json={'code':200,'data':result})

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    try:
        context=browser.new_context(viewport={'width':1500,'height':1100})
        context.add_cookies([{'name':'__s_t','value':'synthetic-not-a-real-token','domain':'127.0.0.1','path':'/'}])
        context.route('**/*',intercept)
        page=context.new_page()
        page.goto('http://127.0.0.1:4067/leasing/100/review-and-send')
        names=page.get_by_placeholder('Full name',exact=True)
        expect(names).to_have_count(2)
        assert names.nth(0).input_value()=='Alice Wong' and names.nth(1).input_value()=='Bob Chan'
        assert names.nth(0).get_attribute('readonly') is not None
        assert page.get_by_placeholder('email@example.com',exact=True).nth(0).get_attribute('readonly') is not None
        expect(page.get_by_role('button',name='Remove signer')).to_have_count(0)
        page.get_by_role('button',name='Add non-tenant signer').click()
        expect(names).to_have_count(3)
        send=page.get_by_role('button',name=re.compile(r'Send for E-Signature$'))
        send.click()
        expect(page.get_by_text('Every signer needs a full name and email. No tenant can be omitted.')).to_be_visible()
        assert not seen['send']
        page.locator('button.ant-btn-dangerous').last.click()
        expect(names).to_have_count(2)
        page.screenshot(path=str(ARTIFACTS/'ui-required-signers.png'),full_page=True)
        send.click()
        expect(page.get_by_text('Synthetic transport check: no request created.')).to_be_visible()
        assert [t['tenant_id'] for t in seen['send'][0]['parties']]==['1','2']
        assert seen['send'][0]['document_snapshot']=='synthetic-preview-hash'
        print('PASS: both required tenants prefilled; blank extra cannot be silently dropped; send DTO has both IDs')

        page.goto('http://127.0.0.1:4067/settings/lease-templates/1/edit')
        expect(page.locator('.ql-editor')).to_be_visible()
        page.get_by_role('button',name='Preview tenant-block upgrade').click()
        expect(page.get_by_role('dialog')).to_be_visible(timeout=20000)
        assert seen['preview_counts']==[1,2]
        page.screenshot(path=str(ARTIFACTS/'ui-template-upgrade-comparison.png'),full_page=True)
        page.get_by_role('button',name='Use this upgrade in the editor').click()
        expect(page.locator('.ql-editor')).to_contain_text('{{TENANT_PARTIES}}')
        expect(page.locator('.ql-editor')).to_contain_text('{{TENANT_SIGNATURES}}')
        page.get_by_role('button',name=re.compile(r'Save changes$')).click()
        expect(page.get_by_text('Synthetic transport check: no template saved.')).to_be_visible()
        saved=seen['save'][0]
        assert saved['expected_version']==3 and saved['tenant_layout']['version']==1
        print('PASS: Quill-normalised source converts; both previews shown; staged upgrade saves recipe and expected version')
    except Exception:
        page.screenshot(path=str(ARTIFACTS/'ui-smoke-failure.png'),full_page=True)
        raise
    finally:
        browser.close()
