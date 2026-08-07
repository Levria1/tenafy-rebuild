# Lease extension paperwork — per-period signed documents

**Date:** 2026-08-07
**Status:** approved, not yet implemented

## The problem

When a tenancy is extended, the lease record is simply edited — the end date is pushed
out — and that works correctly today. What's missing is the **paperwork**: a document,
signed for the new period, recording the new dates.

Two gaps make this impossible right now:

1. **The lease carries only one signature.** `leasing.signature_status`,
   `signed_file_id` and `signed_at` are single-valued, so a second signed document has
   nowhere to live as a first-class record.
2. **A lease signed on paper cannot be recorded at all.** The only available action is
   "Cancel Request", which resets `signature_status` to `'none'`
   (`backend/src/routes/signature.js:446`) — making an ink-signed lease
   indistinguishable from one nobody ever sent, with no scan stored anywhere.

## Decisions taken

| Question | Decision |
|---|---|
| Record model | **Extending stays an edit to the existing lease row.** No new lease rows, no renewal chain. |
| Document | The **same contract template**, rendered with the new period's dates. |
| Period boundary | The new period starts the **day after** the previous one ends — covered to 19 Aug, extended a month → the contract runs **20 Aug – 19 Sep**. |
| When paperwork is required | Only when the uncovered stretch reaches **a month or more**, measured from the last signed period. |
| Where documents live | **`signature_request`**, which is already one-row-per-signing-event with a non-unique `lease_id`. |
| What the document prints | **Only its own period.** An extension contract shows 20 Aug – 19 Sep and makes no reference to the term before it. |
| Paper signing | First-class: upload the scan and record the period. |
| Raising the gap | **Prompt immediately after saving a later end date**, plus a persistent banner / calendar marker / filter. |

### Why `signature_request` rather than a new table

It is already the ledger this feature needs — one row per signing event, `lease_id`
non-unique, carrying `template_id`, `template_version`, `original_file_id`,
`signed_file_id`, `completed_at` and a full `signature_event` audit trail. A separate
`lease_document` table would mean two places to look for "the signed PDF for this
lease", a UI that merges both lists, and an e-sign flow writing to both — surface area
that will drift.

The public signing URL resolves by **party** token, not request token
(`resolveTokenContext` joins on `sp.party_token`), so a paper-record row carrying no
`signature_party` rows is inert: there is no URL that can reach it and nothing to sign.

### Why the chained-lease-row alternative was rejected

Giving each period its own `leasing` row was considered and rejected. It reuses more
existing machinery, but it forces boundary-suppression work across unrelated
subsystems: skip the auto-generated deposit invoice, suppress the `tenant_checkout`
email on the old row and `tenant_checkin` on the new one, carry meters and settlement
across the chain, and get `first_invoice_date` exactly right so the boundary month is
billed once. Each is a place for a silent billing or email bug. An extension is not a
new tenancy — it is the same tenancy with more paperwork — so the smaller change
matches the business reality and carries far less risk.

## Data model

Migration `033_signature_request_term.sql` — per-org, idempotent via
`information_schema` PREPARE/EXECUTE guards, applied with `npm run migrate:orgs`.
**No changes to the `leasing` table.**

| Column | Type | Purpose |
|---|---|---|
| `term_start` | `DATE NULL` | first day of the period this document covers |
| `term_end` | `DATE NULL` | last day of that period |
| `signature_method` | `VARCHAR(16) NOT NULL DEFAULT 'esign'` | `'esign'` or `'paper'` |
| `term_stamp_end` | `DATE NULL` | stamped Term of Tenancy for this period; `NULL` = the period's own end date |

Index: `(lease_id, status, term_end)` for the gap query.

**No backfill.** Existing rows keep `term_start`/`term_end` as `NULL` and display as
"period not recorded". Backfilling from the lease's current dates would assert that an
old signed document covers a term it may never have covered — a lease already extended
by editing would get a wrong, official-looking period. There were only a handful of
leases with signature requests as of 2026-08-05; the period can be set by hand.

## Rendering a document for a period

`renderFromTemplate` in `backend/src/services/leasePdfRenderer.js` gains an optional
`term` argument. Applied immediately after `loadLeaseContext`:

```js
if (term && term.start_date && term.end_date) {
  ctx.lease = {
    ...ctx.lease,
    start_date: term.start_date,
    end_date: term.end_date,
    // Explicitly null, never inherited — see below.
    stamp_end_date: term.stamp_end_date || null,
  };
}
```

**`stamp_end_date` must be overridden explicitly, not left to fall through.**
`effectiveStampEndDate` returns `ymd(lease.stamp_end_date) || ymd(lease.end_date)`
(`leaseTemplateVariables.js:103`), so the **stored** value wins. Overriding only
`start_date`/`end_date` on a lease that had "Stamp for a longer term" ticked for its
original term would print that original stamped date as the extension's Term of Tenancy
— a silently wrong date on a legal document. Forcing it to the period's own value unless
a stamped term is supplied for *this* period closes that off.

Every date variable resolves from that one object — `START_DATE`, `END_DATE`, their
`_SHORT` forms, the term-length variable and the `STAMP_END_DATE` fallback
(`leaseTemplateVariables.js:208-232`) — so all of them follow from the override with no
further changes. Omitting `term` leaves current behaviour untouched.

**`{{RENT}}` intentionally comes from the lease row**, so an extension document prints
the current (possibly increased) rent. Stored PDFs are the record of truth: "View PDF"
always serves the saved file and never re-renders, so an earlier period's document can
never be retroactively altered by a later rent change.

**`leasing.stamp_end_date` is left untouched by this feature.** It keeps meaning what the
lease form says, and is still what a whole-lease render uses; each period document carries
its own `term_stamp_end`. No write-back, so extending can never silently rewrite the
lease's stamped term.

*Known consequence:* "View Lease" renders live lease data with no term override, so on an
extended lease it prints the new end date beside the lease-level stamped term. That is
pre-existing behaviour of a live re-render — the signed PDFs remain the record.

## Flows

### Extending (unchanged)

Edit lease → change the end date → save. Nothing in this path changes.

### The prompt

The edit page already loads the lease's existing `end_date` before editing
(`frontend/src/app/leasing/[id]/edit/page.js:239`), so the comparison is entirely
client-side — no backend detection needed. After a successful save where the new end date
is **later** than the old one **and the resulting uncovered period reaches a month**
(shared threshold helper — a short extension prompts nothing):

```
Term extended by 12 months.
No signed document covers 1 Sep 2026 – 31 Aug 2027.

[Send for e-signature]  [Record signed on paper]  [Later]
```

"Later" dismisses; the banner, calendar marker and filter still surface the gap.

### Documents & Signatures section (lease detail)

One row per period, ordered by `term_start`:

```
1 Sep 2025 – 31 Aug 2026   e-signed 28 Aug 2025     [View PDF]
1 Sep 2026 – 31 Aug 2027   ⚠ no paperwork           [Send for e-sign] [Record paper]
```

Each row shows the period, the method (e-signed / signed on paper), the completion date,
and a link to the stored PDF. Rows with a `NULL` period show "period not recorded" with
an action to set it.

### Send for e-signature

The existing Review & Send page, with a period field added. Prefill:

- `term_start` = latest covered `term_end` + 1 day, falling back to `lease.start_date`
  when the lease has no documents yet
- `term_end` = `lease.end_date`
- **Term of Tenancy** — a "Stamp this period for a longer term" tick box, unticked by
  default, mirroring the lease form. Unticked, the document prints its own period end.
  Ticked, it prefills `term_start + 2 years − 1 day` (same clamped helper) and is
  editable. Stored as `term_stamp_end` on the document row, giving a per-period stamping
  history the single lease column can't hold.

`POST /api/signature/request` accepts and stores `term_start` / `term_end`.

### Record signed on paper

`POST /api/signature/record-paper` — `{ lease_id, term_start, term_end, file_id, signed_at, template_id? }`.

Creates a `signature_request` row with `signature_method='paper'`, `status=3`
(fully signed), `signed_file_id` = the uploaded scan, `completed_at` = the supplied
signing date, and no `signature_party` rows. Writes a `signature_event` of type
`completed` with metadata noting it was recorded manually, so the audit trail never
implies an e-signature took place. Org-scoped; rejects a `file_id` belonging to another
org. Cancels any in-flight request for the same period first.

## Gap detection

For a given lease:

- `covered_end` = `MAX(term_end)` over rows with `status = 3` and a non-`NULL` `term_end`
- `in_flight` = a row exists with `status IN (1, 2)` whose `term_end` is `NULL` or
  `>= lease.end_date` (a `NULL` period on an in-flight request still counts, so nothing
  nags while a document is genuinely out for signature)
- `has_documents` = any row exists for the lease

```
uncovered_start = covered_end + 1 day
long_enough    = lease.end_date >= (uncovered_start + 1 month - 1 day)

gap = has_documents AND NOT in_flight
      AND (covered_end IS NULL OR (lease.end_date > covered_end AND long_enough))
```

### The one-month threshold

**Extensions shorter than a month need no contract.** A month or more does. Worked
through, with a period covered to 19 Aug (so `uncovered_start` = 20 Aug and the
threshold date is 19 Sep):

| Lease end date | Uncovered | Result |
|---|---|---|
| 5 Sep | ~2 weeks | quiet |
| 19 Sep | exactly 1 month | **contract needed** |
| 19 Oct | 2 months | **contract needed** |

**Measured from the last signed period, not from the last edit.** Three consecutive
three-week extensions each look short in isolation, but the undocumented stretch itself
grows — 21 days stays quiet, 42 days is flagged. This is what stops repeated
month-to-month rollovers from quietly accumulating into an undocumented year.

Calendar-month arithmetic, clamped the same way as `defaultStampEndDate` (31 Jan + 1
month → 28 Feb), and computed **only on the server**. `PUT /api/leasing/:id` returns the
recomputed `paperwork` state and the edit page prompts from that — no date arithmetic on
the client, so the prompt and the banner cannot drift apart. (The spec originally called
for a shared client/server helper; duplicating the clamped maths across two packages is
how they diverge, so the server is authoritative instead.)

A sub-month uncovered period is not silence in the UI: the Documents section shows it as
a plain grey line, `20 Aug – 5 Sep · no paperwork required (under a month)`, with no
warning colour. **"Add document" stays available at all times**, so a short extension can
still be papered when a particular tenant warrants it.

**`has_documents` is what keeps this quiet on legacy data.** 110 of 113 live leases have
`signature_status = 'none'` because they predate e-signature; keying the highlight off
`'none'` would flag nearly all of them — the same trap that was caught on the
`unconfirmed` calendar badge. Requiring at least one document makes the nagging opt-in
from the moment a lease is first documented, and removes any need for a
`requires_signature` column on `leasing`.

A lease whose only signed document has a `NULL` period counts as a gap and reads
"period not recorded" — correct, and it affects only the few pre-existing requests.

Surfaced as:

- `GET /api/leasing/:id` → a `documents` array plus a `paperwork_gap` object
  (`{ from, to }`) for the banner
- `GET /api/leasing/calendar` → a per-lease `paperwork_gap` boolean, rendered as a
  marker alongside the existing `*PENDING*` / `*UNCONFIRMED*` / `*DEPOSIT DUE*`
- The Lease Status filter gains **"Paperwork gap"**

## Bug fixed along the way

Cancelling a request hardcodes `signature_status = 'none'`
(`backend/src/routes/signature.js:446`), which would erase "signed" from a lease whose
earlier period genuinely is signed. It must instead recompute from the ledger: `'signed'`
when any `status = 3` row exists, otherwise `'pending'` when one is in flight, otherwise
`'none'`.

## Tests

- **Renderer override:** `START_DATE` and `END_DATE` reflect the supplied term, not the
  lease row; omitting `term` leaves output unchanged (regression guard)
- **Stamped term isolation (the bug this spec caught):** a lease with
  `stamp_end_date` set, rendered with a term override and no `term_stamp_end`, prints the
  **period's own end** as `STAMP_END_DATE` — never the lease's stored stamped date. With
  `term_stamp_end` supplied, that value prints instead
- **Gap rule:** no documents → no gap · signed document covering the end date → no gap ·
  signed document ending short by a month or more → gap · in-flight request covering the
  end date → in-flight, not gap · signed document with `NULL` period → gap
- **One-month threshold:** covered to 19 Aug → end 5 Sep quiet · end 19 Sep flagged ·
  end 20 Sep flagged; accumulation (three ×3-week extensions) quiet at 21 days, flagged
  at 42; month-end clamping (covered to 31 Jan → threshold 28 Feb in a non-leap year);
  and the client and server helpers agree on every case in the table
- **Period prefill:** latest covered end + 1 day; falls back to `lease.start_date` with
  no documents
- **`record-paper`:** sets `status=3`, `signature_method='paper'`, `signed_file_id`,
  `completed_at`; org-scopes the `file_id`; creates no party rows
- **Cancel:** recomputes `signature_status` from the ledger instead of forcing `'none'`

## Separate follow-up — unit lease history

Not part of this feature, but identified alongside it and approved as its own change.

Historic leases are reachable today from `/leasing` (which applies **no default status
filter** — set Lease Status → Inactive for expired ones, per `COMPUTED_STATUS_SQL`) and
from the tenant detail Leases tab. **Unit detail is the gap:**
`GET /api/property/unit/:unit_id/current-lease` (`property.js:1210`) returns exactly one
current lease and one future one, so a unit shows no past tenancies.

Add a "Lease History" section to unit detail listing every past tenancy — tenant, dates,
rent, link — leaving the current/next panels as they are. One endpoint, one UI section.
Kept separate so it can ship independently.

## Explicitly out of scope

- Writing a period's stamped term back onto `leasing.stamp_end_date`
- **Any recital of earlier terms on an extension document.** It prints its own period and
  nothing else. Note that `substitute` is plain `{{VAR}}` replacement with no conditional
  support (`leaseTemplateVariables.js:324`), so a recital sentence added to the shared
  template would also render — with a blank date — on first contracts. Reviving this
  would need either a self-blanking single variable or a separate extension template
- A distinct "extension addendum" template — the same contract is re-issued with the new
  period, as decided
- Rent history per period (the lease carries one rent; earlier periods are evidenced by
  their stored PDFs)
- Any change to invoicing, deposits, check-in/check-out emails, calendar bars, move-out,
  settlement or meters — an extension has no lease boundary, so none of that is touched
