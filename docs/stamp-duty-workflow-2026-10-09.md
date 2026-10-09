# Stamp duty workflow — as walked through by Dennese, 2026-10-09

Source: Zoom recording `2026-10-09 14.23.34 Alex T's Zoom Meeting` (23 min, screen share).
Transcript (Whisper, English) + frames sampled every 30 s. Examples used: **Tai Yuen 25/F**
(HK$19,000, 17 Oct 2026 → 16 Oct 2027, 12 months) and **PCM 26 / LEA3398**
(HK$11,000, 6 Nov 2026 → 5 Feb 2027, 3 months).

## Steps today (all manual)

| # | Where | What |
|---|---|---|
| 1 | Slack `#new-tenant` | Read the latest new-tenant post (unit, tenant, price, term). |
| 2 | Google Sheet "Stamped Contracts for 2 years" | Copy into the month tab (10/2026, 09/2026…) under "New Tenants": unit, tenant, start, end. Sheet also has a "Stamp Tracking" tab. |
| 3 | Tenafy → Leasing → search tenant → lease | Documents & Signatures → **View signed**. Check it is signed; screenshot Schedule I. |
| 4 | Claude chat ("pls calculate") | Paste Schedule I; get a duty estimate (a cross-check only — the IRD notice is the real figure). |
| 5 | IRD eTAX → Individual portal (Alex's TIN login) | Other Services → **Stamp Duty** → Tenancy Agreement → single application. |
| 6 | eTAX form | Date of signing = date on the signature block (8 Oct). Duplicates = 0. Premises address. Start/end date. **Monthly rent if term > 1 year** (fixed rent, no rent-free); **otherwise Total Rent** (228,000 shown). 1 tenant / 1 landlord. Tenant English name, **passport/HKID no.**, tenant address = the unit. Landlord = **Parcelle Limited** + BR no. Applicant capacity = Landlord. |
| 7 | eTAX | Sign & Submit (password) → download **Stamp Duty Payment Notice** (Tai Yuen: HK$570). |
| 8 | WhatsApp → CL (Chris Lee) | Ask CL to pay. **IRD cut-off 3 pm**; later payments process next day. |
| 9 | Sheet | Mark the row **"Processed"**. |
| 10 | Email/message to tenant | Notepad template: "stamp duty fee is shared equally… Your share: HK$xx… settle today or include with your upcoming rent". |
| 11 | eTAX → **Print Stamp Certificate** (after payment) | Retrieve by **charge no.** (e.g. 1-27-1-0405868-0) or pick from the list → download certificate. |
| 12 | Slack `#tane_payments` | Post amount, the stamp share, and the certificate copy. |
| 13 | Tenant | Message that the certificate is received, remind about payment, attach the certificate. |
| 14 | Tenafy → tenant profile → Accounting | **Create invoice** for the tenant's share, description like `Stamp Certificate (31 Oct 2026 to 30 Nov 2026)`, e.g. HK$20. |

Landlord pays the full duty first; the tenant's share is **half the total on the IRD notice**
(Tai Yuen: total HK$570 → tenant HK$285), recovered by invoice. eTAX detail: `docs/etax-stamping-handoff.md`.

## What this means for the Signing & Stamp Tracking page

This is the operator's spec for the placeholder **Stamp Status** column. The natural states, in order:

`not stamped` (signed, no notice) → `notice issued / awaiting payment` (step 7) → `paid` (step 9, "Processed")
→ `certificate received` (step 11) → `tenant invoiced` (step 14).

Data each period would need: stamp-duty amount, tenant share, charge no., notice PDF, certificate PDF,
invoice id. Several steps are pure retyping of data Tenafy already holds (duty calc, every eTAX field,
the tenant email, the share invoice). eTAX submission itself stays manual (government login + signing).

## Open questions for the operator
- Should "Processed" mean *notice issued* or *paid by CL*? The narration sets it before payment.
- Keep the Google Sheet, or let the tracking page replace it?
