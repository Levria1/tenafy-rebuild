# Tenafy → TaneChat — drafts change

**One breaking change and one new endpoint.** Please read §1 before your next poll cycle, because it
changes what the drafts queue returns.

---

## 1. Drafts now expire after 30 minutes (breaking)

A draft used to sit in the queue for **7 days**. It now lives for **30 minutes**, after which
`GET /viewing-negotiation/drafts` simply stops returning it.

**Why:** a viewing message should go out within a few minutes or not at all. A 4-day-old
*"Which unit would you like to view?"* — the one you flagged — is worse than sending nothing. The old
7-day window meant a stale message stayed one click away from a real customer for a week.

What you'll see:

```json
{ "drafts": [ { "event_id": "…", "body": "…", "expires_at": "2026-08-14T11:30:00", … } ],
  "count": 1, "fresh_minutes": 30 }
```

- **`fresh_minutes`** — the policy, so you don't hardcode 30.
- **`expires_at`** — per draft, if you want to show a countdown.
- **There is no `expired` field.** Everything returned is fresh by definition; a flag that is always
  `false` would only invite branching on nothing.
- `max_age_hours` still works but can now only make the window **narrower**. `max_age_hours=0.25`
  gives you 15 minutes. Anything wider is capped at 30 — otherwise the change would be trivially
  undone by a parameter you already send.

**Nothing else about the queue changed.** Still oldest-first, still at-least-once until you call
`draft-sent`, still suppressing drafts for cancelled negotiations and for viewings that have already
happened.

**What this means for you:** if a draft is in your queue, it is safe to send. If it vanished, don't
go looking for it — ask for a new one, per §2.

## 2. New: `POST /viewing-negotiation/:id/compose`

Answers **"what should we say to this person right now?"** from the conversation's current state.

```
POST /api/public/viewing-negotiation/1786630671908542781/compose
(no request body — the negotiation id is the whole input)

→ { "event_id": "…", "template_type": "Viewing-Choose-Unit",
    "party": "prospect", "to_phone": "+852…",
    "body": "…", "expires_at": "…", "unchanged": false }
```

It returns a normal draft, in the same shape the queue gives you. Send it and call `draft-sent`
exactly as you do today.

- **Needs your read-write key.** It creates a draft, so a read-only key is rejected.
- **`unchanged: true`** means the newly rendered text is byte-identical to the last draft — nothing
  has moved. Show it as "no change since last time" rather than implying a fresh answer appeared.
  Calling it twice in a row returns the *same* draft rather than queueing a second message.
- **`409 { reason: "nothing_to_send", state }`** when there is genuinely nothing appropriate to say —
  the viewing is confirmed, cancelled, or a human has taken the conversation over (`NEEDS_STAFF`).
  This is a normal answer, not an error. Don't retry it.
- **`404`** for an unknown negotiation.

**It never advances the conversation.** It doesn't change state, doesn't count as a nudge, doesn't
start any timer. It only renders. So it is safe to call whenever you're unsure.

## 3. What we'd like you to do

**When a conversation is waiting on us and has no fresh draft, call `compose`.**

That's the whole ask. Concretely, on your poll: for a negotiation whose `awaiting` is `prospect` or
`tenant` and which has nothing in the drafts queue, call `compose` and put the result in front of
staff as usual.

We deliberately are **not** asking you to build a "regenerate" button. A human pressing one is just a
manual stand-in for a rule that's simple enough to run by itself — and doing it automatically means:

- an expired draft is never a dead end; the next poll produces a current one
- the message is always built from today's facts, not from whenever it was first composed
- when the operator turns on full automation later, the plumbing is already in place — only the
  approval step goes away

Staff approval doesn't change. The only thing becoming automatic is *producing* the suggestion, which
was never a human judgement in the first place.

## 4. Migration checklist

- [ ] Stop assuming a draft will still be there later — it lives 30 minutes
- [ ] Read `fresh_minutes` rather than hardcoding 30
- [ ] Don't send `max_age_hours` expecting a wider window; it's capped
- [ ] Call `compose` when a conversation awaits us and the queue has nothing for it
- [ ] Treat `409 nothing_to_send` as a normal answer, not a failure
- [ ] Surface `unchanged: true` as "no change", not as a new reply
- [ ] Use the **read-write** key for `compose`

## 5. Nothing else changed

`start`, `prospect-reply`, `tenant-reply` and `draft-sent` are untouched. The state machine, timers,
tenant opt-out clock and message wording are all exactly as they were. Availability (`/vacancies`,
`/units/resolve`, `next_available`) is unaffected.
