# Design v2 — renewal ask over the EXISTING renewal flow

**Status: design for review. Nothing built to this shape yet.** Supersedes
`docs/renewal-ping-design-2026-08-19.md`, which assumed we were starting from nothing.
Date: 2026-08-19. Operator: Tane Residence (`8300127259922432`).

## The finding that changed the design

We already contact tenants about renewals — though far less often than the raw row count suggests.

| | |
|---|---:|
| Current/future leases with `tenant_renewal = 1` | **126 of 149** |
| Leases with `tenant_renewal_days` set | 149 |
| `Renewal-Tenant` rows in `email_log` | 1,086 |
| …of those, **actually sent** | **127** (last 15 Aug 2026) |
| …**blocked by the send whitelist** | 954 (last 4 May 2026) |
| …failed | 5 (last 16 Jul 2026) |

**Correction, 2026-08-19:** an earlier version of this document read the 1,086 row count as 1,086
emails sent. Only 127 were. The premise survives — 126 leases are opted in and the job runs daily —
but the outreach is an order of magnitude smaller than stated, and the 954 whitelist-blocked rows mean
most opted-in tenants have never actually received one. Worth knowing before calling this a
replacement for something already working at scale.

`sendRenewalEmailsForOrg` (scheduler Job 7) emails the tenant `tenant_renewal_days`
before the lease ends, opted in per lease from the lease create/edit form.

So v1's premise was wrong twice over. We do not need a new trigger — the schedule, the
per-lease opt-in and the timing already exist. And a parallel WhatsApp ask would have
**double-contacted tenants**, who would get the existing email and a new message about
the same question.

**What is actually missing is the reply.** We ask and nobody captures the answer
structurally, which is why 101 leases still sit as "may renew" with 4 of them past
their decision date. This design adds a channel and a reply path to the trigger that
already runs.

## Shape

Extend Job 7 rather than add a sibling job.

1. **Delivery becomes WhatsApp-first, email as fallback.** Same opt-in flag and the
   same daily job — but NOT, as first drafted, the same lease selection. Job 7 and this
   feature disagree in four ways that have to be reconciled deliberately rather than
   assumed away:

   | Job 7 selects on | Renewal ask needs |
   |---|---|
   | `lease_state = 'active'`, `status = 1` | same, fine |
   | tenant **email present** | phone-only tenants must not be skipped |
   | `tenant_renewal_days` (per lease, can exceed 60) | the notice window |
   | any lease | the unit's **latest** lease, with nothing following it |
   | any `contract_type` | only undecided (MR / UC) |

   Left as-is, Job 7 would ask tenants who have already decided, skip phone-only
   tenants entirely, and fire at a date unrelated to the notice period. The selection
   must be narrowed for the ask even though the schedule is shared.
2. **The message becomes a template with three buttons** — Extend / Leaving / Unsure —
   so the answer arrives structured rather than parsed.
3. **The reply updates availability**, which is the part that does not exist today.

### Channel order and coverage

WhatsApp first where the tenant has a phone; email otherwise, and email again if the
WhatsApp send fails. Coverage is not lopsided and the UI must not imply it is:

| | count |
|---|---:|
| Tenants with a phone | 1,472 |
| Tenants with an email | 2,013 |
| Total tenants | 2,019 |

Roughly a quarter are email-only. Email is a route, not an edge case.

### Templates live in Tenafy

`whatsapp_template`, alongside the `Viewing-*` types, with code fallbacks in the same
pattern as `viewingNegotiation.js` FALLBACKS. Two types:

- `Renewal-Ask-1` — neutral. Does not mention that anyone is interested.
- `Renewal-Ask-2` — escalation, sent only if a prospect asks about the unit after
  ask 1 went unanswered. May say that someone is interested.

WhatsApp requires an approved template for a business-initiated message outside a
24-hour window, which a renewal ask always is. Free text cannot be used here.

Buttons carry fixed payloads: `RENEWAL_EXTEND`, `RENEWAL_LEAVING`, `RENEWAL_UNSURE`.

### Two asks, at most

| Ask | Trigger | Wording |
|---|---|---|
| 1 | Job 7's existing schedule | Neutral |
| 2 | A prospect asks about the unit, and ask 1 is unanswered | May mention interest |

**Minimum 24 hours between them** — a tenant must never be messaged twice in a day.
(Operator's phrasing was "at most within 24 hours of one another"; read here as a floor,
not a ceiling. Confirm.)

## Reply handling — the asymmetry is unchanged

| Reply | Effect |
|---|---|
| **Extend** | Unit is withdrawn from customer-facing feeds **immediately and automatically**, and flagged on the Vacancy page for the lease extension. Reversible in one click. |
| **Leaving** | Recorded. **Nothing changes for customers** until staff confirm. |
| **Unsure** | Recorded. Nothing changes. |

Automatic in the withdrawing direction only: the cost of being wrong is a listing we
restore, whereas auto-marking a unit firmly available off a button press risks promising
a customer a home the tenant never vacates.

The already-built code uses `staying`; rename to `extend` throughout to match the button.

### Undoing an automatic withdrawal

Three routes, and the first is one click:

1. **Undo on the Vacancy page**, next to the flag — clears the reply, unit back on offer.
2. **Extending the lease** — the end date moves out and the unit leaves the list anyway.
3. A later, contrary reply.

Reversibility is what makes automatic withdrawal safe; it must ship with the feature,
not after it.

## Where intent is tracked — the Vacancy page, on the column that already exists

No new screen and no parallel field. `contract_type` (MR / MTM / NR / UC) is already the
renewal intent and is already a column there. The tenant's answer becomes a proposed
change to it.

| Situation | Row shows | Action |
|---|---|---|
| Asked, no reply | `MR · asked 3d ago` | — |
| Tenant chose Extend | `MR → extend` | **Extend lease** · Undo |
| Tenant chose Leaving | `MR → leaving` | **Confirm NR** |
| Free-text reply | their actual words | staff set the intent |

⚠️ **The "they will already be on the page" assumption is false**, and the review
caught it. The page's expiring rows require the lease to have started, to be within the
60-day window, and to have no replacement lease behind it (`advertising.js:197-200`).
Job 7 fires on `tenant_renewal_days`, which can exceed 60. So a lease with 90 days'
notice would be asked and never appear for review, and a unit already re-let would be
asked but excluded from the page.

Two consequences: the ask must be gated on the notice window rather than
`tenant_renewal_days`, and the review queue cannot rely on the Vacancy page alone.

The Vacancy row must also carry the review state itself — today the page can only see
`renewal_reply === 1` and has no way to show "asked, awaiting reply". That means
`renewal_ask` state has to reach the vacancy response, not just the answer.

**A second home is needed.** A unit whose tenant wants to stay is the opposite of a
vacancy, and some asked leases will never qualify for that page at all (above). Add a
small renewal-response queue — its own view or a dashboard block — and mirror the flag
onto Vacancy rows when the lease also belongs there.

**"Extend" is deliberately NOT a fifth `contract_type` value.** It is not a renewal
intent, it is a prompt to do the paperwork; once the lease is extended the end date moves
and the unit leaves the list on its own. Adding a fifth value would force every consumer
of `contract_type` — public feed, tier logic, TaneChat — to learn it for no gain.

## Lease create and edit

`tenant_renewal` / `tenant_renewal_days` already exist on both forms
(`leasing/create/page.js:946`, `leasing/[id]/edit/page.js`). Relabel so the channel is
visible: **"Renewal reminder — WhatsApp first, email if we cannot reach them"**, with the
days field beside it. Given a quarter of tenants are email-only, the wording must not
imply email is rare.

## What this changes in the code already committed

- Rename `staying` → `extend` (`renewalAsk.js`, routes, tests, migration comment).
- Keep `POST /renewal-ask` as the ask-2 trigger; it is no longer the primary path.
- **Delete nothing else yet** — the claim/cooldown/stale machinery is all still needed.
- Add the scheduler work to Job 7 rather than a new job.
- `renewal_ask` gains `ask_number` (1 or 2) and `channel` (whatsapp|email).

## Risks

- **Double contact — and the existing code actively works against us here.**
  `sendTemplateEmail` already fires a best-effort WhatsApp for the same template type
  when one exists (`emailService.js:826`). So routing the "email fallback" through the
  existing helper would send BOTH. The either/or decision cannot live inside either
  sender; it needs a dedicated renewal dispatch that picks one channel, records the
  outcome atomically, and calls the low-level senders directly. Marking WhatsApp sent
  before the gateway confirms would also block the email fallback on a failure, so the
  record must distinguish *attempted* from *delivered*.
- **Template approval latency.** Meta approval is not instant; the feature cannot go live
  the day it is built.
- **A button press is still not legal notice.** It updates intent and triggers paperwork;
  it never generates a lease.
- **Silence is not "leaving".** No reply leaves the lease exactly as it was.
- **Ask 2 mentions interest** at the operator's instruction. It can prompt a renewal or
  make a tenant feel pushed out; worth reviewing after the first few.

## Button delivery is NEW infrastructure, not existing

`whatsapp_template` is a local content table and `sendTemplateWhatsApp` posts plain
`{ phone, message }` text (`whatsappService.js:197,245`). There is no support today for
Meta-approved templates with interactive buttons or fixed payloads. The `Viewing-*`
fallback pattern is a good model for content, and the viewing outbox is a good model for
delivery, but the buttons themselves have to be built and approved. Plan for that
latency rather than discovering it late.

## Resolved questions

1. **The 24-hour rule is a floor.** Never send ask 2 within 24 hours of ask 1, and cap
   the cycle at two asks total.
2. **Ask 2 goes to email-only tenants too**, by email, under the same cooldown and audit
   rules. A quarter of tenants have no phone; giving them a materially different process
   is not defensible.
3. **`email_log` keeps meaning email.** `renewal_ask` becomes the single source of truth
   for "who has been asked, by which channel, and what they said". Writing a fake email
   row for a WhatsApp send would corrupt an audit other things rely on.

## Still to specify before building

Scheduled outbound messaging fails in predictable ways, and none of these are covered
above yet:

- delivery idempotency, and what happens when WhatsApp fails *after* the ask is claimed
- email fallback that cannot re-enter the WhatsApp path
- tenants with neither a phone nor an email, and any opt-out
- template versioning and re-approval
- an inbound reply that arrives with no ask id, or two taps of the same button
- staff notification and an expectation for how quickly a pending Extend is actioned
- undo that clears the customer-facing suppression without erasing the audit history

## Note for the lease form

`notice_period_days` on the create form is currently labelled "Notice the tenant must
give to renew" (`leasing/create/page.js:552`). That reads as notice to renew rather than
notice to leave, and this feature makes the field load-bearing — worth correcting the
wording at the same time.
