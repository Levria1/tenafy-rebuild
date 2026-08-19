# Reply to TaneChat — the `/active` window, and the correlation gap our fix created

**Draft for Chris to review and send. Not sent.**

---

Hi team,

Your `/active` note was worth sending early — it changed what we built, not just when.

## The window is fixed, and the prospect side is fixed differently from the tenant side

You were right that the eight hours reached further than a delayed field. Reading your
description alongside our own code turned up something we should have seen: the grace was
never wanted for the prospect at all.

The occupant is the one with something left to say once the slot arrives — "nobody came",
"they were early, we're done". That has to reach us, and it is the only reason the window
exists. The prospect cannot reopen a booked viewing by messaging; we refuse those replies.
So a listed-but-unroutable entry was doing nothing for us while, on your side, it took the
conversation out of your hands.

Now live:

- **A confirmed viewing disappears from `/active` for the prospect the moment it starts.**
  Their "we loved it, we'd like to take it" reaches your normal handling with no negotiation
  sitting over it.
- **For the tenant it stays reachable for 12 hours past the slot** — explicitly, from a
  named constant, not from a clock comparison. The old eight hours was the difference
  between a Hong Kong wall-clock column and a UTC `NOW()`; nobody chose it, and it would
  have moved if the server's zone ever did.
- The same bug was releasing **drafts** for viewings that had already happened, for the same
  eight hours. That is bound to the operator clock now too, with no grace: once a viewing has
  started there is nothing left to confirm.

**One clarification that may matter more than the fix.** `routable: false` means "do not
relay this to us" — it does not mean "do not handle it". A non-routable entry is context,
not a claim on the conversation. If you stand your own handling down on one, the customer
gets nothing, because we will not be acting on it either. That reading may be costing you
more than the window was; it is now stated explicitly in the API reference.

## `confirmed_slot` is live, in the shape you proposed

```json
{ "negotiation_id": "...", "state": "CONFIRMED", "routable": false,
  "confirmed_slot": { "start": "2026-08-21T11:00:00",
                      "end":   "2026-08-21T11:30:00",
                      "timezone": "Asia/Hong_Kong",
                      "unit_id": "8326307481849856",
                      "unit_label": "Poplar 2B" } }
```

Hong Kong wall clock with an explicit `timezone`, no offset suffix on one field beside
zone-less ones. `null` in every state other than `CONFIRMED`/`AUTO_CONFIRMED` — a time still
being negotiated is not an agreement, and publishing it as one would be the fabricated
viewing in a different coat. Viewings are a fixed 30 minutes, the same length as the
calendar event we create.

## Q1 — you are right, and the gap is ours to close

Removing the message closed one hole and opened another, and you described it more precisely
than we would have: a sent ask never appears in `/pending`, so there is nothing left to learn
an id from. Your relay would have run, found nothing, and reported nothing.

Two things, and the first needs nothing from you:

**1. `GET /api/public/renewal-asks/open`** — one row per outstanding question. Id, unit,
tenant phone, when it went out, which ask in the sequence. No message text, so it cannot
become a send queue by accident, and reading it claims nothing. That restores correlation
today without waiting on either of us to ship a change to the other's endpoint.

Two details that matter for the flow you described. It lists the **latest** ask in a sequence,
not all three, because an earlier one is not what a reply can be about. And a question leaves
the list only on a **definite** answer — an ask with a vague reply already filed against it
stays, marked `vague_reply_on_record: true`. Otherwise relaying "ok thanks" would hide the id
and the real answer would have nothing to attach to, which is precisely the correction we
agreed to support.

**2. The origin field on `/send`.** We will take the generic shape, since it serves the
viewing relay later:

```json
{ "phone": "85212345678", "message": "...",
  "origin": { "type": "renewal_ask", "id": "..." } }
```

We will not start sending it until you confirm your endpoint accepts it — an unknown key
arriving unannounced at a live gateway is not a risk worth taking with messages that are
already working. Tell us when it is in and we will switch it on the same day.

Thank you for the `connectionId` and message-id notes; both are useful and neither changes
anything for us today.

## The tenant with two open asks

We would rather remove the case than agree a rule for it: **we will not open a second ask to
a phone that already has one outstanding.** The second lease waits until the first is
answered or its sequence ends. Since asks only start inside a lease's notice period, and the
whole sequence runs at most about a week, the delay is small — and it means an unquoted
"yes please" can only ever refer to one thing.

That seems better than either of us deciding what an ambiguous answer meant. If you would
rather have the ambiguity and handle it, say so, but we would need a reason to prefer it.

Thanks — the `/active` note in particular saved us shipping a field on top of a bug.

Chris

---

## Notes for Chris (not part of the message)

- **The `routable: false` clarification is the highest-value line in this note.** If they are
  standing down on every non-routable entry, every prospect with a confirmed upcoming viewing
  has been getting no AI drafts at all — a much larger surface than the eight-hour window.
- **Everything in this note is built, tested and deployed** — including `/renewal-asks/open`
  and the one-ask-per-conversation rule. Nothing here announces an endpoint that 404s.
- The `origin` field is the only item that is a promise rather than a delivery, and it is
  written as conditional on purpose: their endpoint has to accept it before we can send it.
- The `origin` field is deliberately promised as conditional, not scheduled. Their endpoint
  has to accept it before we can send it, and the viewing relay uses the same path.
