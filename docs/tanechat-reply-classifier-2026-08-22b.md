# To TaneChat — classifier ownership, the hold, and two fixes

**Draft for Chris to review and send. Not sent.**

Answers their 22 August reply. Supersedes `tanechat-open-questions-2026-08-22.md`, which was
written before theirs arrived and asks a question they have now answered.

⚠️ **NOT DEPLOYED.** Commit `4e3cc7a`. Migration `migrations-org/075` must run BEFORE the code.
Everything in §1 and §5 is described as live; deploy first or change the tense.

---

Hi team,

That was a good letter. Your question 1 is the right one and we are answering it directly, and
your question 3 has an answer in code. One disagreement, on where you set the threshold rather
than on the principle.

---

# Your questions

## 1. Who holds the classifier — we do, and we accept the condition

**Option 1. We keep it, you keep sending raw text.** Your reasoning is better than ours: turning
a tenant's sentence into a lease decision should happen once, and it should happen where the
consequence lives.

We also accept the condition you attached, explicitly rather than by implication: **we stay
conservative.** Anything not an unambiguous yes or no becomes `unsure`, which records and acts
on nothing. If we ever loosen that, we tell you before we ship it, not after.

And your closing line is the part we would underline:

> What should never happen is both of us classifying independently and each assuming the other
> is the safety net.

Agreed, and stated plainly so neither of us can drift into it: **you do not classify. We do.**
If you ever want that to change, it changes by agreement, not by one side quietly starting.

## 2. Telling you what we could NOT match — yes, and it is the right ask

**NOT BUILT YET.** We are going to add it; we would rather say that than have you read a promise
as a shipment.

You are right that we already tokenise, and right that silence is the wrong answer. The shape
we have in mind on `/units/resolve`:

```json
{ "status": "confident", "match": { ... }, "unmatched": ["6a"] }
```

Populated when the query contains unit-like tokens that resolved to nothing. That lets you say
"here is 5A, and I cannot find a 6A" instead of answering half the question in silence.

One thing we want to get right before shipping: "unit-like" has to be tight, or every stray word
lands in `unmatched` and you end up apologising for tokens the customer never meant as a unit.
We will send you the rule before it goes out.

## 3. Yes — and please use it less than you are planning to

Built. `POST /renewal-ask/:id/reply` now takes `verified: false`:

```
{ "text": "please extend my stay", "verified": false }
```

It records the words, **holds the ask sequence for 7 days**, changes nothing about the lease, and
raises it on our Vacancy page and in our weekly renewal email. Response carries `acted: false`,
`held: true`, `needs_staff: true`.

The hold **expires** on purpose. Indefinite, a message misread as a possible answer would drop a
tenant out of the sequence permanently — worse than the nagging it prevents, because nothing
would ever surface it again. Seven days is set to match our weekly digest: long enough for the
email that reports it to reach a person, short enough that a forgotten hold heals itself.

Anything other than an explicit `false` takes the normal path, so a malformed flag can never
silently swallow a real answer. A definite answer already on record wins — a later uncertain
message returns `already_replied` and holds nothing.

### But the specific message you withheld should have been relayed

We disagree with the threshold, not the caution, and we would rather say so than let you
calibrate against our silence.

You withheld this:

```
02:01  "hello, I would like to confirm the apt for the following month"
02:04  "please extend my stay"
```

Your letter says the ambiguity is that "extend my stay" can mean a few more nights. The message
three minutes earlier resolves it: **"for the following month"** is not a few more nights. And
your own letter settles attribution — *"the sender's phone is the phone on your ask."* Identity
confirmed, period named, against a question we had asked her.

We read it the same way, recorded it as `extend` by hand, and had already extended her lease by
exactly one month before your letter arrived.

**The asymmetry runs the other way from your caution.** `extend` withdraws a unit from the
market. If it is wrong we put it back — a listing restored, a day lost. `leaving` is the
expensive error, which is exactly why it never acts automatically. Our own rule is that evidence
good enough to stop us selling is not good enough to let us sell; withholding a confirmation
applies the `leaving` standard to an `extend` decision.

The cost of withholding was not zero either. She stayed in the sequence and was queued to be
asked "are you renewing?" having just said yes twice.

**So: use `verified: false` for ambiguous CONTENT, not for unusual CONTEXT.** A group thread is a
signal, not a veto. When the sender is identified and the words name a period, relay it. Keep the
hold for a forwarded message, an unattributed sender, or wording that only makes sense with the
previous message in hand.

**A question, because it changes the answer:** what share of your tenant threads are groups? If it
is most of them, a group-triggers-hold rule routes the majority of real answers back to us by
hand, which is the outcome the relay exists to prevent.

## 4. Do not replay the five

All four definite answers were recorded here by hand, and all four came back `applied: false`
with `stale_reason: lease_end_changed` — because the leases had already been extended manually,
each to the term the tenant asked for. A replay would return `already_replied` and change
nothing.

The fifth, Hollywood 1B, is not settled and is not yours to close: he asked to pause the lease
for two weeks and continue to December while separately asking about another studio. That is a
conversation for a person.

---

# On what you found here

## `max_price` — you are right, and the cause is worse than you thought

Not prorating. The filter read the stored lease price **raw**, while the response published the
schedule-aware figure — so we told you a unit costs 12,000 a month and then withheld it under a
14,000 ceiling.

`Poplar 2B` stores `34,434.99` with no invoicing schedule: the total for an 86-day let. That is
the same contamination `monthly_rent_basis` exists to flag, which we fixed in the output and left
in the filter. Both bounds now compare the same figure the response reports.

Confirmed against production: `max_price=14000` excluded it, `max_price=40000` included it, and
after the fix a normal monthly band returns it. You can drop your own banding when this deploys —
though keeping it costs nothing.

## `alternatives_outside_area` — it is deployed, and here is why you see nothing

It is present on every window-mode response. Just now, live:

```
?available_between_start=…&available_between_end=…&district=Sheung Wan   ->  3 alternatives
?available_between_start=…&available_between_end=…   (no district)       ->  present, empty
```

It only fills when you send a `district` — with no preferred area there is nothing to be outside
of. It is also a **sibling of `data`, not an element of it**, so a caller reading the array
directly will not see it:

```json
{ "code": 200, "data": [ … ], "alternatives_outside_area": [ … ], "meta": { … } }
```

If you are sending `district` and reading the envelope and still see no key, tell us and we will
look properly.

## Your relay fixes — our logs agree

We can corroborate both faults from our side, which we could not before:

```
133 × GET  /renewal-asks/open                     200
  1 × POST /renewal-ask/…/reply                   403   ← the read-only key
  1 × POST /renewal-ask/0000000000000000000/reply 404   ← the placeholder id
```

The `403` is the one worth keeping an eye on. A refusal you do not notice is indistinguishable
from a failure, and your old handling turned it into a closed ask — which is the more dangerous
half of that bug, not the credentials.

Your reconcile alert — "open ask, inbound messages, zero relays" — is the right check, and
better than anything we would have thought to ask for.

---

Thanks. Question 1 is settled from our side: it is ours, we stay conservative, and neither of us
starts classifying without telling the other.

Chris

---

## Notes for Chris (not part of the message)

- **DEPLOY FIRST, and in this order:** `npm run migrate:orgs` (adds the nullable columns), then
  pull and restart. The new queries select `unverified_at`; migration-then-code is backward
  compatible and the reverse breaks the Vacancy page. Commit `4e3cc7a`, 1010 tests.
- **§2 is explicitly marked NOT BUILT.** Do not let that slip out — it is the exact trap the
  `rent_price_min` note fell into. Either build `unmatched` before sending or leave the marker in.
- **§3 disagrees with them in writing.** Worth it: they will otherwise calibrate their threshold
  against our silence, and the withholding costs you manual work every time it fires.
- **I told you their caution was better founded than my confidence. That was wrong** and the note
  now says the opposite, with the reason. Their own letter confirms the sender's phone matched the
  ask, so attribution was never the issue.
- The group-share question at the end of §3 is the one to watch for in their reply. If most
  threads are groups, the hold needs a tighter trigger than they are proposing.
- Not mentioned: their letter references our §6 and §13; our note had 12 sections and the numbers
  run one out. Harmless — the content they quote is unambiguous.
