# TaneChat → Tenafy — Message Search API (request)

What Tenafy needs from TaneChat so the internal assistant can help reconcile
bank transactions against WhatsApp history.

**Direction:** Tenafy's backend calls TaneChat (server-to-server). TaneChat
exposes read-only search over its own message history. Nothing is written back.

---

## Why — the problem being solved

Reconciliation happens in **Xero**, on the bank-rec screen. The bank statement
lines look like this (real example):

```
17 Jul 2026  /ORDP/Wise Payments (Hong Ko... HC12671737725897 ... Money Transfer   Received  13,800.00
20 Jul 2026  N71849347385(18JUL26) -838, CR TO 112-347992                          Spent      3,700.00
20 Jul 2026  /ORDP/Wise Payments (Hong Ko... HC12672044352235 ... Money Transfer   Received     284.00
```

**There is no payer name.** "Wise Payments (Hong Kong)" is the payment
processor, not the person. Same for FPS transfers. So the usual matching
signals — payer name, contact, reference — are unusable.

What's left is essentially **amount + date + direction**, and the human
explanation is very often sitting in WhatsApp:

> "ok transferred the rent 13,800 just now"
> "my wife will send the deposit tomorrow"
> "I paid 284 for the aircon guy, please reimburse"

Today the operator finds this by manually scrolling chats. We want Tenafy's
internal assistant to do that lookup: *given HK$13,800 received on 17 Jul, who
paid it, for what, and why.*

So the driving query is unusual: **we search by a number, not by a person.**
That shapes most of the requirements below.

---

## Endpoints requested

### 1. `GET /api/search/messages` — the main one

```
GET /api/search/messages
      ?amount=13800              # normalised amount search (see P1 below)
      &q=aircon                  # free-text substring search
      &from=2026-07-03           # message timestamp >= (ISO date)
      &to=2026-07-24             # message timestamp <=
      &phone=+85290001234        # optional: narrow to one contact
      &limit=50
      &cursor=<opaque>
```

`amount` and `q` are both optional but at least one is required. When both are
given, treat as AND.

**Response**

```json
{
  "results": [
    {
      "message_id": "msg_123",
      "conversation_id": "conv_456",
      "timestamp": "2026-07-17T09:12:44+08:00",
      "direction": "inbound",
      "content": "ok transferred the rent 13,800 just now",
      "contact": {
        "name": "Chan Siu Ming",
        "phone": "+85290001234",
        "channel": "whatsapp"
      },
      "deep_link": "https://tanechat.example/c/conv_456#msg_123",
      "context": [
        { "message_id": "msg_122", "timestamp": "...", "direction": "outbound",
          "content": "Rent for MK4C is due on the 15th" },
        { "message_id": "msg_124", "timestamp": "...", "direction": "outbound",
          "content": "Received, thank you" }
      ]
    }
  ],
  "next_cursor": "eyJvIjoxMDB9"
}
```

### 2. `GET /api/conversations/{id}/messages` — read around a hit

```
GET /api/conversations/conv_456/messages?around=msg_123&limit=40
```

Returns a window of the conversation. Used when the assistant needs to read
what was actually agreed rather than just the matching line.

If `context` in endpoint 1 is easy to include, this one is lower priority.

---

## Requirements, in priority order

### P1 — Normalised amount search *(the one that matters most)*

If TaneChat only implements one thing, make it this.

An amount appears in messages in many forms. A raw text search for `13800`
misses nearly all of them:

```
13800   13,800   13800.00   13,800.00   $13,800   HK$13,800   HKD 13,800   13.8k
```

**Ask:** at index time, extract number-like tokens from each message, strip
currency symbols/commas/trailing `.00`, and store them as numeric values
attached to the message. Then `?amount=13800` matches all of the above in one
call.

Without this, Tenafy has to fan out ~8 text queries per amount and will still
miss variants — which quietly makes the whole feature unreliable rather than
visibly broken. That's the bad failure mode.

Nice-to-have once it exists: `amount_min` / `amount_max`, so we can look for
near-misses (bank fees shaved off a round number) and for combined payments.

### P2 — Substring matching, not word-tokenised

`13,800` must be findable inside `"ok transferred 13,800 just now"`, and
`MK4C` inside `"the MK4C aircon"`.

A tokenising full-text index (MySQL `FULLTEXT`, default Elastic analyzers)
typically splits or drops punctuated numbers and alphanumeric unit codes. At
your message volume a `LIKE %...%` scan is fine and more predictable.

### P3 — Identity on every hit

`contact.phone` is the join key back to a Tenafy tenant record.
`contact.name` alone is not enough — WhatsApp display names are often
nicknames, or the payer is a spouse/company.

Also needed: `conversation_id` on every result.

### P4 — Deep link back into TaneChat

`deep_link` per message, so the assistant's answer is clickable and the
operator can verify the source in one click before reconciling in Xero.

This matters more than it looks — the operator should never have to trust the
assistant blind on something that moves money.

### P5 — Surrounding context

A bare match of `"yes sent"` is useless. Either inline `context` (±2 messages)
in the search response, or endpoint 2 above.

### P6 — Full history, no recency window

A tenant may say *"I'll pay the deposit when I move in"* months before the
money lands. Search must cover all retained history, not just recent.

### P7 — Date filtering

Filter on message timestamp. Payment date ±14 days is the high-signal window
and we'll use it to rank, so server-side filtering keeps responses small.

### P8 — Cursor pagination

Prefer an opaque cursor over offset (stable under concurrent writes).

---

## Auth

- Server-to-server only. Tenafy's **backend** calls this; it is never exposed
  to a browser, so no CORS needed.
- A static API key in a header is fine: `X-API-Key: <key>` (or
  `Authorization: Bearer <key>`).
- Scoped to the org. If TaneChat is multi-tenant, the key should imply the org
  — Tenafy will not pass an org id.
- Please allow key rotation without downtime (accept two valid keys during a
  changeover).

## Operational asks

- **Rate limit:** low volume — a handful of calls per reconciliation, maybe a
  few hundred a day at peak. Whatever's convenient; just tell us the limit and
  return `429` with `Retry-After` rather than silently truncating.
- **Latency:** these run inside a chat tool-calling loop with an overall
  timeout. Under ~2s per call is comfortable; over ~10s will break the flow.
- **Errors:** normal HTTP status codes + a JSON `{ "error": "..." }` body.
- **Empty result** is a `200` with `results: []`, not a `404`.

## Explicitly NOT needed

To keep scope small — Tenafy does not need any of these:

- Writing, sending, or modifying messages
- Webhooks or push/streaming
- Media/attachment contents (a flag that a message *had* media is plenty)
- Semantic/vector search — literal matching is what this job needs
- Any change to how TaneChat mirrors sessions into Tenafy today; this API is
  additive and independent of that

---

## Open questions for TaneChat

1. **Is message history retained indefinitely?** If it's trimmed at some age,
   what's the cutoff? This bounds how far back reconciliation can look.
2. **Is the phone number stored in a consistent format** (E.164, `+852...`)?
   If it varies, Tenafy will normalise on its side — just tell us what to
   expect.
3. **Are group chats in scope**, and if so does a message carry the individual
   sender as well as the group?
4. **Is there an existing search index** we'd be extending, or is this new?
   That decides whether P1 is cheap or a real piece of work.
5. **Does TaneChat already store any structured extraction** per conversation
   (amounts, dates, intents)? If so, exposing that may be a better primitive
   than raw message search.

---

## How Tenafy will use it

For reference — this is the shape of the calls to expect.

```
Operator pastes a Xero row (or types an amount) into Tenafy's internal chat.

Tenafy then, in parallel:
  • queries its own DB for invoices / leases / past accounting entries
    matching HK$13,800
  • calls TaneChat:
      GET /api/search/messages?amount=13800&from=2026-07-03&to=2026-07-24
  • if a candidate tenant is identified, calls again narrowed by phone:
      GET /api/search/messages?phone=+85290001234&from=...&to=...

and returns a ranked answer with the evidence and deep links attached:

  HK$13,800 received, 17 Jul — likely Unit MK4C, tenant Chan Siu Ming
    • Invoice TRIV0001234, due 15 Jul, HK$13,800 open — exact amount
    • Lease MK4C monthly rent is HK$13,800
    • WhatsApp 17 Jul: "transferred the rent this morning"  [open chat]
    ⚠ Also matches: Unit HW2B rent is also HK$13,800
```

Nothing is auto-committed anywhere. The output is advice; the operator
reconciles in Xero themselves.
