# Reply to TaneChat — your two blocking questions

**Draft for Chris to review and send. Not sent.**

---

Hi team,

Both answers are yes-and-no in ways that matter, so here they are precisely. Q1 was our
documentation's fault, not a misreading on your part.

## Q1 — `/pending` did claim the ask. You were right, and our note contradicted itself.

Reading that list stamped `claimed_at` and the row was never re-offered. So polling it
while we did the sending would have done exactly what you described: consumed the ask,
sent nothing, and left the tenant unasked with a slot spent. Worse than not integrating,
as you put it.

Our note told you both things fifteen lines apart — a "send loop" built around
`/pending`, and then "you do not need to build sending". The first was left over from an
earlier design in which you were the sender. There was no way to resolve that from
outside, and you were right to stop rather than guess.

**Settled: we send. All of it.** The nightly job and the demand trigger both dispatch
inline, over your `/send`, or by email where the tenant has no phone. Three changes went
out with this note:

- `POST /renewal-ask` now **sends** the ask before it answers you. Previously it created
  the row and handed the text back — the hole you found from the other side.
- `GET /renewal-asks/pending` no longer claims anything. It is a read. Polling it is
  harmless, and it will normally be empty, because rows only linger there when a send
  failed.
- **The rendered message is no longer in any response.** This is the part worth
  underlining: we removed your ability to send, deliberately, so that no future engineer
  on either side can wire up a second sender by accident. There is nothing left to
  transmit.
- `POST /:id/sent` still answers 200 so your existing code does not break, but it writes
  nothing. It could only ever have marked an ask delivered on the word of a system that
  did not deliver it.

Your other suggestion — put the ask id in what we post to `/send` — is the one we would
like to do, and it removes polling entirely. Our `/send` payload is currently
`{ phone, message }` only; we do not send `connectionId` either, despite it being in your
signature. If you tell us the field name you want and confirm you can persist it against
the thread, we will add it. That would also let a reply be attributed without your side
having to correlate on phone number.

## Q2 — one reply only. Now: a vague answer can be corrected, a real one cannot.

You could reply once. The second POST returned a cheerful 200 and discarded the answer.

Your scenario was real and the consequence was worse than you argued. "ok thanks" filed
as `unsure` did three things at once: it ended the ask sequence, it suppressed the
escalation that would have flagged the tenant to our staff, and it recorded an answer the
tenant never gave. The lease then simply went quiet in our records — no further asks, no
hand-off, nobody chasing.

Two changes, both live:

**A vague answer may be superseded.** Post again when the real answer arrives. An `unsure`
on record is replaced by `extend` or `leaving`, and the response carries
`superseded: "unsure"`. We keep the earlier text rather than overwrite it — the tenant
sent it, and staff reading the row later need to see what we originally filed.

A definite answer can never be overwritten, in either direction. The asymmetry is
deliberate: the dangerous move is the one that puts a home back on the market, and a
stray later message must not undo a tenant's "we're staying".

**`unsure` no longer ends the sequence.** It is not an answer, and it is also where
anything ambiguous lands — so treating it as one let an unrelated message close a tenant's
sequence. The remaining asks now go out as normal, and three vague replies still escalate
to a human.

One correction on the mechanism you proposed: "reply repeatedly until the ask leaves
`/pending`" is not a usable boundary. `/pending` only ever lists asks we have not sent, so
by the time any reply can arrive the ask has left it. The rule above needs no boundary —
post whenever you have something, and a definite answer wins.

We agree with your reasoning for not classifying intent yourselves. Our parser stays
conservative for the same reason.

## While we were in there — one of ours, on an endpoint you read

`GET /viewing-negotiation/active` compares the agreed time against the database clock,
which runs UTC, while the stored value is Hong Kong wall clock. A confirmed negotiation
therefore stays listed as active for about eight hours after the viewing has finished.

Telling you now because it is adjacent to what you asked for: `confirmed_slot` reads off
that same row, so shipping it against the current window would have handed you the time of
a viewing that already happened — the inverse of the bug we have both been chasing. We are
fixing the window first, then adding the field as Hong Kong wall clock with an explicit
`timezone`, per your proposal.

Thanks — both questions found real defects, and Q1 found one in our own writing.

Chris

---

## Notes for Chris (not part of the message)

- **Nothing here is optional on their side.** Their relay can stay switched off until they
  confirm they have stopped polling `/pending`; the message removal means an old poller now
  reads a list with nothing sendable in it, which fails safe rather than silently.
- **The `/send` ask-id field is the only open ask.** Worth chasing, because until it exists
  they must correlate replies by phone number, and a tenant with two live asks (two
  tenancies) cannot be disambiguated that way.
- Migration 069 adds the three `prior_reply_*` columns. Deploy needs `npm run migrate:orgs`.
- `renewal_ask_enabled` is still 0 everywhere, and ask 3's wording is still unwritten.
  Neither should change until you have read asks 1 and 2 and written the third.
