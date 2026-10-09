# IRD eTAX stamping — handoff (the part Tenafy does NOT automate)

Reconstructed from the 2026-10-09 Zoom walkthrough (Dennese), frames + transcript. Worked example:
**Tai Yuen 25/F**, 12-month lease 17 Oct 2026 → 16 Oct 2027, HK$19,000/month, signed 8 Oct 2026.
Result: **total HK$570, tenant share HK$285** (exactly half).

Tenafy's job ends at handing over a pre-filled payload (`GET /stamping/:id/etax-payload`) and resumes
when the notice / certificate is posted back. Everything below happens on IRD's site, under the
operator's own eTAX login. No credentials belong in Tenafy or in this doc.

## A. Submit the tenancy agreement for stamping

1. `etax.ird.gov.hk` → **Individual Tax Portal** → log in (TIN + password).
2. **Other Services → Stamp Duty → Stamping on Property Document → Tenancy Agreement →
   single application** → Continue → Begin application form (IRD says 5–20 min).
   Steps shown: 1 Read Important Notes · 2 Enter Details · 3 Sign and Submit · 4 Make Payment.
3. **Tenancy Agreement Details**
   - **Date of Signing** — the date on the signature block of the signed PDF (8 Oct), *not* the
     lease start.
   - **No. of duplicate tenancy agreement signed** — `0` (0/1/2/3).
   - **Property Address** (Standard Format): Flat/Room, Floor, Block, Building, Estate,
     No. & Name of Street, then district. (25 / – / – / – / – / 15 Tai Yuen St, Wan Chai.)
4. **Term of Tenancy Agreement** — Start Date, End Date (dd/mm/yyyy), then ONE of:
   - **Monthly Rent** — only if ALL of: term exceeds 1 year, fixed monthly rent throughout, no rent-free period.
   - **Total Rent paid/payable over the whole term** — every other case. Tai Yuen is exactly 12 months,
     so it does NOT exceed a year → Total Rent **228,000** (12 × 19,000).
   - Amounts exclude premium.
5. **Parties** — No. of landlords `1`, No. of tenants `1` (more if joint tenants).
   - **Landlord**: English name **Parcelle Limited**, ID = **Business Registration (BR) No.**
     (printed on the signed PDF under the landlord signature).
   - **Tenant**: English name (Chinese optional — "either one or both"), ID = **HKID or passport no.**
     (the "I.D. No" on the signed PDF), address = the rented unit.
6. **Applicant** — company name; capacity **Landlord**.
7. Review page (Certain Lease Term, dates, Total Rent, landlord/tenant particulars) → Continue.
8. **The Total Amount Payable is HK$570.00** → choose **Offline** (pay by phone/Internet/ATM/post
   office/Stamp Office; certificate available within 2 working days after payment). Not "Online".
9. **Signing** — password → **Sign & Submit** → download the **Stamp Duty Payment Notice** PDF.
   It carries the **Charge Number** (e.g. `1-27-1-0405868-0`), the Shroff Account Number for
   e-payment, the amount and the **payment due date**.

→ Back to Tenafy: `POST /stamping/:id/notice` with the PDF, charge no., amount, due date.

## B. Payment (CL)

- Send the notice to **CL (Chris Lee)** — today by WhatsApp. CL pays.
- **IRD cut-off 3 pm**; a payment after 3 pm is processed the next working day.
- Sheet row is marked "Processed" at this point today.

→ Tenafy: `POST /stamping/:id/paid`.

## C. Print the stamp certificate (after payment clears)

1. eTAX → Stamp Duty → **Print Stamp Certificate** → Continue → Begin application.
2. **Enter Information for retrieval**: Instrument Reference No. **or Charge No.** (omit "-")
   **or** Transaction Reference No. — or pick from the list of recent submissions
   (Submission date/time, IRN, Transaction Ref, Charge No.). Dennese uses the charge no. from the notice.
3. Submit → **Download Stamp Certificate** (PDF).

→ Tenafy: `POST /stamping/:id/certificate`, then the tenant invoice + notification (Tenafy side).

## Duty and share — what the video actually shows

- Rate for a term **not exceeding 1 year: 0.25% of total rent**. 228,000 × 0.25% = **570**.
  (Longer terms: 0.5% of average yearly rent for 1–3 years, 1% over 3 years — not shown in the video.)
- Duplicates = 0, so no HK$5 duplicate fee on these.
- **Tenant share = half the total on the notice** (570 → 285; another email shows 86 → 43).
- The figure to use is always the **notice**, never a calculator — Tenafy's estimate is only a cross-check.

## Things an automator must not get wrong
- Signing date ≠ start date.
- Monthly vs Total Rent is decided by the 3-condition test above; exactly 12 months is "Total Rent".
- Offline payment, not Online.
- Tenant ID can be HKID **or** passport — the form field differs.
- Each submission is a legal filing under the operator's tax login; a wrong one needs an IRD amendment.
