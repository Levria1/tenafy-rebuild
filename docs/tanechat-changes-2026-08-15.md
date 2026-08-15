# Tenafy → TaneChat — what changed (15 August 2026)

**All of this is LIVE on production now.** One breaking change (§1), one new endpoint (§2), and
three things that change what you'll observe without needing code changes from you.

Items §1–§5 have not been sent to you before. §6 is a recap of what you already have, for
completeness.

---

## 1. Drafts now expire after 30 minutes — BREAKING

A draft used to sit in the drafts queue for **7 days**. It now lives for **30 minutes**, after which
`GET /viewing-negotiation/drafts` stops returning it.

**Why:** you flagged a 4-day-old *"Which unit would you like to view?"* waiting to be sent. A viewing
message should go out in minutes or not at all. The old window meant a stale message stayed one click
away from a real customer for a week.

```json
{ "drafts": [ { "event_id": "…", "body": "…", "expires_at": "2026-08-15T11:30:00", … } ],
  "count": 1, "fresh_minutes": 30, "max_age_minutes": 30 }
```

- **`fresh_minutes`** — the policy. Read it rather than hardcoding 30.
- **`max_age_minutes`** — the window actually applied to this response.
- **`expires_at`** — per draft, if you want to show a countdown.
- There is deliberately **no `expired` flag**: everything returned is fresh by definition.
- `max_age_hours` still works but can now only make the window **narrower**. `max_age_hours=0.25`
  gives 15 minutes; anything wider is capped at 30.

Everything else about the queue is unchanged — oldest first, at-least-once until you call
`draft-sent`, and drafts for cancelled negotiations or already-past viewings are still withheld.

**What this means for you:** if a draft is in your queue it is safe to send. If it has vanished, do
not go looking for it — ask for a fresh one (§2).

## 2. New: `POST /viewing-negotiation/:id/compose`

Answers **"what should we say to this person right now?"** from the conversation's current state.

```
POST /api/public/viewing-negotiation/1786670707329317780/compose
(no request body — the negotiation id is the whole input)

→ { "event_id": "…", "template_type": "Viewing-Choose-Unit", "party": "prospect",
    "to_phone": "+852…", "body": "…", "expires_at": "…", "unchanged": false }
```

Returns a normal draft in the same shape as the queue. Send it and call `draft-sent` as you do today.

- **Needs your read-write key** — it creates a draft.
- **`unchanged: true`** means the newly rendered text is byte-identical to the last draft: nothing has
  moved. Surface it as "no change since last time" rather than as a fresh answer. Calling it twice
  returns the *same* draft rather than queueing a second message.
- **`409 { reason: "nothing_to_send", state }`** when there is genuinely nothing to say — the viewing
  is confirmed or cancelled, or a human has taken the conversation over (`NEEDS_STAFF`). This is a
  normal answer, not an error. Do not retry it.
- **`404`** for an unknown negotiation.
- **It never advances the conversation** — no state change, no nudge counted, no timer started. Safe
  to call whenever you are unsure.

**What we would like you to do:** when a conversation is waiting on us (`awaiting` is `prospect` or
`tenant`) and the drafts queue has nothing for it, call `compose` and put the result in front of
staff as usual. We are deliberately not asking you to build a "regenerate" button — doing it on your
poll means an expired draft is never a dead end, and the same wiring is what full automation will use
later.

## 3. The tenant notice changed — new `event_type`, new `template_type`

The old tenant message said *"Unless you reply no or ask to reschedule by [deadline], we'll confirm
this viewing."* **That wording has been deleted.** It was never what the operator wanted: it
announces a deadline and invites a refusal.

Tenants now receive the operator's own wording, which explains that a staff member will accompany the
guest and asks for an alternative time if it does not suit.

**The behaviour is unchanged — silence still confirms the viewing.** We simply no longer say so in
the message; the timer is internal.

What you will see in drafts and events:

| Field | Old | New |
|---|---|---|
| `template_type` | `Viewing-Tenant-OptOut` | `Viewing-Tenant-Ask` |
| `event_type` | `tenant_opt_out_notice` | `tenant_silence_confirm` |

- **`tenant_opt_out_notice` is no longer emitted**, but it still exists on historical rows — keep
  rendering it, do not treat it as invalid.
- `Viewing-Tenant-Explicit` / `tenant_explicit_confirm_request` are **unchanged** and still used for
  short-notice viewings (§4).
- Send `body` verbatim, exactly as before. Nothing about the send flow changes.

## 4. You will see more "please reply yes" tenant messages than before

When a viewing starts sooner than the tenant response window, silence cannot be consent — the tenant
may not have read the message yet. Those viewings ask for an explicit yes instead
(`Viewing-Tenant-Explicit`).

That rule already existed but was **miscalculating by 8 hours** (§5), so it almost never fired. Now
it fires correctly, which means **a genuine increase in explicit-confirmation drafts for near-term
viewings**. This is a bug fix, not a policy change. No action needed — just do not report it as a
regression.

The window is now operator-configurable (default 4 hours), so this threshold can move.

## 5. Times are Hong Kong wall clock — a real bug is fixed

Our server runs UTC while the operator works in Hong Kong (UTC+8), and some time comparisons were
being made against the server clock. Two consequences, both now fixed:

- A viewing **one hour away** was measured as nine hours away, so it skipped the short-notice rule
  above (§4).
- Quiet hours (11:00–19:00) were being applied to UTC, i.e. 19:00–03:00 Hong Kong — inverted.

**Every time we send you or accept from you is Hong Kong local time, with no timezone suffix.** That
has always been the intent; it is now true throughout. If you are converting timestamps anywhere,
treat them as Asia/Hong_Kong, not UTC.

## 6. Already live — recap only, nothing new here

- **`free_on` no longer dead-ends.** When it filters everything out, units that free up *later* come
  back in **`next_available`** with **`phrasing.later`**. `partner_forward.applies` is `false` while
  that list is non-empty. Check `next_available` before telling anyone we have nothing.
- **`POST /units/resolve`** — read-only unit lookup from `unit_id`, `listing_url` or free text. Works
  with your read-only key. Only `status: "confident"` is safe to act on.

---

## Checklist

- [ ] Stop assuming a draft will still be there later — it lives 30 minutes
- [ ] Read `fresh_minutes` rather than hardcoding 30
- [ ] Call `compose` when a conversation awaits us and the queue has nothing for it
- [ ] Treat `409 nothing_to_send` as a normal answer, not a failure
- [ ] Surface `unchanged: true` as "no change", not as a new reply
- [ ] Accept `tenant_silence_confirm` and `Viewing-Tenant-Ask`; keep rendering historical
      `tenant_opt_out_notice` rows
- [ ] Expect more `Viewing-Tenant-Explicit` drafts on near-term viewings — not a regression
- [ ] Treat all timestamps as Asia/Hong_Kong

## Unchanged

`start`, `prospect-reply`, `tenant-reply` and `draft-sent` are untouched. The state machine, the
tenant opt-out clock, message wording rules and every availability endpoint behave as before.
