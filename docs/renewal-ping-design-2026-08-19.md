# Design — demand-triggered renewal ask ("is the tenant staying?")

**Status: design for review. Nothing built. No message has been sent to any tenant.**
Date: 2026-08-19. Operator: Tane Residence (`8300127259922432`).

## The problem

A unit whose tenant has not decided is unsellable. We can only offer it hedged — *"the tenant may
renew, they're not sure"* — and prospects walk. TaneChat asked us for a `renewal_decision_by` date so
they could say "we'll know by the 5th" instead of an open-ended maybe.

We cannot honestly give them that date. Measured on live data, 2026-08-19:

| | count |
|---|---:|
| Undecided units (contract_type MR or UC) with a future lease end | **101** |
| …of those, with a real `notice_period_days` recorded | **0** |
| …past their decision window (using an assumed 30 days) | **4** |

Every date we could publish would be a 30-day default presented as fact. The 64 leases that *do* carry
a notice period are all on other contract types, so the data is missing precisely where it is needed.

## The idea

Do not publish a guessed date. Get the real answer, and only for units someone actually wants.

When a prospect asks about a unit whose tenant is undecided, and we are inside the decision window, ask
that tenant whether they intend to renew. Their reply updates the renewal intent TaneChat already
reads, so the unit either becomes firmly offerable or leaves the roster honestly.

**Why demand-triggered:** nobody needs to chase 101 tenants. Today the queue is 4 — and two of them
(Hollywood 1B, Gilman's Bazaar 2A) are units prospects asked about this week. Interest is the right
selection principle.

## What already exists — this is a new trigger, not a new channel

- We already message occupants through TaneChat for viewings (`Viewing-Tenant-Ask`,
  `Viewing-Tenant-Explicit`), so tenant messaging via the one number is built and in use.
- The renewal intent field already exists and is already read by the public feed:
  `leasing.contract_type` → 1 MR, 2 MTM, 3 NR, 4 UC.
- The decision window is derivable: `end_date - COALESCE(notice_period_days, 30)`.

## Proposed flow

1. **Candidate detection (ours).** A lease qualifies when: it is the unit's latest lease, `end_date`
   is in the future, `contract_type IN (1, 4)`, and `today >= end_date - COALESCE(notice_period_days,
   30)`.
2. **Qualification gate (ours).** Do not fire on any idle question. Require *qualified* interest — a
   viewing request, or a second inquiry naming the same unit. Configurable.
3. **Cooldown (ours).** At most one ask per lease per decision cycle. Five prospects asking about one
   flat must not produce five messages to its tenant.
4. **Send (theirs).** TaneChat sends an operator-authored message from the same number the tenant
   already hears from.
5. **Reply (theirs → ours).** TaneChat relays the reply; we classify it and update the intent.
6. **Effect.** The unit becomes `certain: true` and firmly offerable, or drops off the roster, or stays
   undecided with the ask recorded so we do not re-ask.

## ⚠️ The open question that must be settled first

**There is no "will renew" value in `contract_type`.** The four values are May Renew, Month-to-Month,
Not Renewing, Unconfirmed. A tenant answering *"yes, I'm staying"* has no state to move to — MR already
means "might", and staying put in MR loses the answer we just paid to get.

Three options, none free:

| Option | Consequence |
|---|---|
| Add a fifth value (e.g. 5 = WR, Will Renew) | Cleanest semantically, but every consumer of `contract_type` must learn it — the public feed, the vacancy page, the tier logic, TaneChat. |
| Record the answer alongside, leave `contract_type` alone | No consumer breaks, but two fields now describe renewal and can disagree. |
| Treat "yes" as the trigger to extend the lease | Most correct commercially — the unit genuinely leaves the roster — but a WhatsApp reply is not a signed extension, so it needs a human step. |

**Recommendation:** option 3, but with the two halves separated — this matters, and the obvious version
of it is wrong.

A clear "yes" must **immediately stop the unit being offered to prospects at all**, firm or hedged. It
must not merely create a task and otherwise leave things as they were: continuing to advertise a flat
whose tenant has just told us they are staying is the worst outcome of the three, and it is what
"create a task and keep hedging" would actually do.

Separately, and on a human timescale, staff extend the lease properly. So:

- **Immediately, automatic:** unit suppressed from prospect-facing availability.
- **Then, human:** paperwork, which is what genuinely resolves the lease.

A chat reply is soft evidence, so it is allowed to *withdraw* a unit — the conservative direction —
but never to flip one to firmly-available, which would risk promising a flat the tenant never signs
for. Evidence that is good enough to stop us selling is not automatically good enough to let us sell.

**Note there is no general staff-task system in this codebase** — there are notifications, not a
durable work queue. So "creates a task" means either a notification plus a dashboard queue built for
this, or a new task primitive. That is real scope and should not be waved through in a design.

**OPERATOR DECISION required.**

## Storage

New table `renewal_ask`, so we keep history and can re-ask in a later cycle:

```
id, org_id, lease_id, unit_id, asked_at, channel, state,
replied_at, reply_intent, reply_text, created_by, notes
```

`state`: `PENDING` → `SENT` → `REPLIED` / `NO_REPLY` / `CANCELLED`.

**The cooldown needs a concrete cycle key, not "per cycle" hand-waving.** Key on
`(lease_id, end_date_at_ask, decision_due_on)` and store both dates on the row. Otherwise a lease
extended by editing the same row, or a notice period corrected after the fact, leaves an old cooldown
suppressing an ask that is now legitimate — the unit goes quiet exactly when it should not.

**Late and stale replies need first-class handling.** A tenant may reply after we gave up, after the
lease was extended, or after a newer ask exists. Classification must re-read the current lease row
before changing anything, and a reply that no longer matches the lease it was asked about is recorded
but not acted on. The viewing flow already has post-confirmation reversal logic for the same reason;
this needs its equivalent.

We should also start capturing `notice_period_days` at lease creation. Zero of 101 have it, which is a
capture gap, not a reporting one — until it is fixed every window is a 30-day guess.

## API surface (mirrors the viewing flow TaneChat already polls)

- `GET /api/public/renewal-asks/pending` — tenants due to be asked, with the message to send.
- `POST /api/public/renewal-ask/:id/sent` — records dispatch, starts the cooldown.
- `POST /api/public/renewal-ask/:id/reply` — relays the tenant's answer.

Timestamps follow the house convention: Hong Kong wall clock, no offset.

**These three endpoints are thinner than the viewing flow they imitate, and probably too thin.** The
viewing relay has event rows, drafts, `draft-sent`, idempotency keys and send modes, precisely because
"we told TaneChat to send something" and "a tenant actually received it" are different facts that drift
apart under retries and failures. A renewal ask has the same exposure: a duplicate send reaches a real
tenant twice. Reuse the viewing **outbox pattern** — not the `viewing_negotiation` table itself, which
is the wrong domain — so dispatch is idempotent and auditable.

## Message

Operator-authored template, editable in settings, never hardcoded — same pattern as
`inquiry_gap_ask_phrase` and `inquiry_too_far_out_phrase`. Placeholders: `{tenant_name}`, `{unit}`,
`{end_date}`.

Draft for the operator to rewrite in their own voice:

> Hi {tenant_name}, your lease at {unit} runs to {end_date}. Are you planning to stay on? Just let us
> know either way and we'll take care of the paperwork.

Note it does **not** mention that someone else is interested. That is deliberate: it changes the
message from a routine admin question into pressure, and the tenant relationship is worth more than the
marginal urgency.

## Risks

- **A chat reply is not legal notice.** It updates intent only, never paperwork, and never
  auto-generates a lease.
- **Tenant fatigue.** Cooldown is load-bearing, not a nicety.
- **Silence is not "no".** No reply must leave the unit undecided, not mark it as leaving.
- **Asking too early.** The window gate exists for this: outside it a tenant legitimately has not
  decided, and an early "not sure" would be recorded as an answer.
- **Timing on a guessed window.** With no notice periods recorded, the gate itself runs on the 30-day
  default. That is acceptable while it stays an internal "ask now" heuristic; it stops being acceptable
  the moment the guessed date is shown to a tenant or sent to the partner as certainty. Capturing
  `notice_period_days` at lease creation is what makes the trigger real as well as the date.

## Not in scope

Publishing `renewal_decision_by` to TaneChat. If the operator later wants an estimated date sent, it
must be explicitly labelled an estimate.
