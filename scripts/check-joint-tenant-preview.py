"""Visual prototype verification. Requires pymupdf; no network or database use."""
from pathlib import Path
import json
import pymupdf as fitz

root=Path(__file__).resolve().parents[1]/'artifacts/joint-tenant-preview'
baseline=fitz.open(root/'baseline-one-tenant.pdf')
single=fitz.open(root/'proposed-one-tenant.pdf')
assert len(baseline)==len(single)==11
assert all(a.get_pixmap().samples==b.get_pixmap().samples for a,b in zip(baseline,single))
results={'single_tenant_pixel_identical_pages':11,'cases':[]}
for name,names in [
 ('proposed-one-tenant',['Alice Wong']),
 ('proposed-two-tenants',['Alice Wong','Bob Chan']),
 ('proposed-two-long-names',['Alexandra Catherine Wong Robertson','Benjamin Christopher Chan Montgomery']),
]:
 d=fitz.open(root/(name+'.pdf'))
 signed=fitz.open(root/(name+'-simulated-signatures.pdf'))
 assert len(d)==11 and len(signed)==12
 for p in [2,3]:
  for tenant in names:
   assert len(d[p].search_for(tenant))>=1,(name,p,tenant)
  for identifier in ['TEST-P10001']+(['TEST-P10002'] if len(names)>1 else []):
   assert len(d[p].search_for(identifier))==1
 assert all(d[i].get_pixmap().samples==single[i].get_pixmap().samples for i in range(11) if i not in (2,3))
 # Every simulated signature must be anchored on the intended page, with no
 # extra fallback Signatures page. The normal completion certificate adds one.
 images=signed[3].get_image_info()
 assert len(images)==len(names),(name,len(images))
 for im in images:
  assert fitz.Rect(im['bbox']) in signed[3].rect
 if len(names)==1:
  assert 'TEST-P10002' not in ''.join(p.get_text() for p in d)
 for p in [2,3]:
  signed[p].get_pixmap(matrix=fitz.Matrix(1.4,1.4)).save(str(root/(name+f'-page-{p+1}.png')))
 results['cases'].append({'case':name,'contract_pages':len(d),'with_completion_certificate':len(signed),'anchored_signatures_on_page_4':len(images),'unchanged_other_pages':9})
(root/'validation.json').write_text(json.dumps(results,indent=2)+'\n')

review=fitz.open()
cover=review.new_page()
cover.insert_textbox(fitz.Rect(45,45,550,790),
 '''TENAFY: JOINT-TENANT FORMATTING REVIEW

19 November 2026 — PREVIEW ONLY / SYNTHETIC DATA

Base: Tane Residence Contract Template, version 22.
No live template, lease, signing request or customer record was changed.
This prototype does not implement the new production signing workflow.

Pages 2–3: ONE tenant — Schedule I and signature page.
Pages 4–5: TWO tenants — Schedule I and signature page.
Pages 6–7: TWO tenants with longer names and email — same pages.

The signature images say TEST and are generated samples, not real signatures.
Landlord contact/registration and bank account digits are masked in every case.
The red test header is added to every page.

CHECKED
• Proposed one-tenant layout is pixel-identical to the baseline on all 11 pages.
• Two-tenant and long-name contracts also remain 11 pages.
• Only Schedule I and the signature page change; the other 9 pages match.
• Names and sample IDs appear for both tenants in both relevant sections.
• Simulated signatures land on page 4; the normal completion page makes 12.

PLEASE REVIEW
Name/ID spacing in Schedule I; signature size and spacing; long names and
emails; and whether side-by-side tenant signatures are the preferred layout.

SCOPE
Formatting approval does not mean the production feature is implemented.
Automatic tenant loading, signer setup/validation, template conversion and
live acceptance remain part of the proposed code change.
No deployment, migration or actual signature emails were performed.
''',fontsize=11,fontname='helv')
for name in ['proposed-one-tenant','proposed-two-tenants','proposed-two-long-names']:
 d=fitz.open(root/(name+'-simulated-signatures.pdf'))
 review.insert_pdf(d,from_page=2,to_page=3)
review.save(root/'Tenafy-Joint-Tenant-Formatting-Review.pdf')
print(json.dumps(results,indent=2))
