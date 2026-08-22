# To TaneChat — classifier ownership, the hold, and what we could not match

**Draft for Chris to review and send. Not sent.**

Answers their 22 August reply. Supersedes `tanechat-open-questions-2026-08-22.md`, which was
written before theirs arrived and asks a question they have now answered.

**DEPLOYED and verified** (`4e3cc7a` for the classifier work, `1843076` for the resolver work).
Both were tested end to end on production.

Everything in this letter is now built. §2 was marked NOT BUILT in the earlier draft; it has
since shipped, and §5 is new — two defects we found in our own resolver while building it.

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

## 2. Telling you what we could NOT match — built, and it tells you more than we promised

Live now. `unmatched` is on every `/units/resolve` response, always present, `[]` when there is
nothing to say:

```json
{
  "status": "confident",
  "match": { "label": "Mong Kok 5A", ... },
  "unmatched": [
    { "text": "6a", "reason": "unit_like_not_found",
      "floor": "6", "floor_units": [], "floor_unit_count": 0 }
  ]
}
```

We said we would send you the "unit-like" rule before shipping, because a loose one has you
apologising for words the customer never meant as a unit. Here it is, and it turned out to be
simpler than we feared: **we hold the unit list, so this is a lookup, not a judgement.**

A leftover token is reported only when all of these hold:

- it has the same SHAPE as a unit name that really exists in this org (digits→9, letters→x),
  derived from the live list at request time rather than hardcoded, so new naming conventions
  are picked up on their own;
- if that shape is purely numeric, the building we matched actually uses numeric unit names —
  so "mong kok 400 sqft" stays silent, because Mong Kok has no numbered units;
- it is not money, a time, a size, a duration or a month — `25k`, `6pm`, `400 sqft`,
  `12 months`, `september` are all suppressed;
- something else in the message did resolve. On `status: "none"` we say nothing, because we
  have no evidence the message was about units at all.

`september` was never really at risk: no unit we own looks remotely like it. Numbers were the
real hazard, and that is what the second and third rules are for.

### The floor context is the part worth using

When the token is a floor-plus-letter we also tell you what that floor actually has:

```json
{ "text": "5e", "reason": "unit_like_not_found", "floor": "5",
  "floor_units": ["Poplar 5A","Poplar 5B","Poplar 5C","Poplar 5D"], "floor_unit_count": 4 }
```

So instead of "I cannot find a 5E" you can say "I do not see a 5E — on that floor we have 5A
to 5D." **An empty `floor_units` under a non-null `floor` is a real answer, not a blank:** it
means the building has no such floor, which is exactly the "mong kok 6a" case.

`floor` is null for a purely numeric token, and null when the request has not narrowed to one
building — listing floors from three buildings would be noise. `floor_units` is capped at 8 and
`floor_unit_count` is always the true total, so a trimmed list is visible rather than silent.

We considered a "did you mean?" nearest-match instead and dropped it: every unit here is
`<floor><letter>`, so "5E" is equally close to 5A, 5B, 5C and 5D and there is no single sensible
suggestion. It would have been a field that was always empty.

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

## 3b. The escalation stays off — and we went further

You asked us not to put it back, and we have not. `"mong kok 6a 5a"` still resolves confidently
to 5A; it now also tells you there is no 6A, which is the half of the question we used to drop.

We also removed the OTHER escalation, which you did not ask about but which had the same shape.
When a customer named two units that **both** exist, the viewing relay parked the conversation
as NEEDS_STAFF and told them a colleague would follow up. It now offers both and asks which one
they would like to view. Naming two real flats is not a problem needing a human; it is a
customer telling us they are interested in two flats.

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

# What we found here

## Two defects in our own resolver, found while building §2

Both were live. Neither was reported by you, and both are worse than the silence you did report,
so they are worth stating plainly.

**A budget was being read as a flat number.** The resolver accepted any query token that merely
*started with* a unit's name. "Tai Yuen, my budget is 25k" saw the "25" inside "25k" and returned
`status: "confident"` on **flat 25/F** — not a guess, not a question, a confident wrong answer.
16 of 55 realistic budget phrasings did this across four buildings. A numeric unit name now has
to match exactly. (The tolerance exists so someone who types "10" still finds "10A"; a number-only
name has no letter to drop, so it bought nothing there.)

**One shared word in a street address counted as naming the building.** Fuk Lo Tsun's address ends
"Kowloon City", so the word "city" in *"pearl city"* was enough to score it as the matched
property. Combined with the bug above, **"pearl city, my budget is 30k" confidently returned a
Fuk Lo Tsun unit** — wrong building, wrong flat, from a message containing neither. An address
match now needs two distinct shared words. Confident answers naming a different building than the
one asked about fell from 49 to 17 of 717 probes, and the survivors are same-building blocks
(12-B6 vs 12-C1 Pearl City) or genuine near-identical names (Lai Yuen / Tai Yuen).

Correct resolution of ordinary "<building> <unit>" queries went **up**, 108 to 113 of 115, because
the loose rule had been manufacturing rival matches that pushed real answers into `ambiguous`.

If you have banding or retry logic working around either of these, you can drop it.

---

Thanks. Question 1 is settled from our side: it is ours, we stay conservative, and neither of us
starts classifying without telling the other.

Chris

---

## Notes for Chris (not part of the message)

- **Everything here is already deployed.** `4e3cc7a` (classifier, migration 075) and `1843076`
  (resolver). 1024 tests. Verified live on production: "mong kok 6a 5a", "poplar 5e" and
  "tai yuen, my budget is 25k" all return the responses quoted above.
- **§2 no longer says NOT BUILT**, because it now is. That marker was in the previous draft on
  purpose; do not let an old copy go out instead of this one.
- **§5 is us reporting our own bugs, unprompted.** Worth keeping: the budget one confidently
  answered about the wrong flat, which is the failure they would eventually have hit and been
  unable to diagnose from their side. It also makes the point that finding each other's defects
  runs both ways.
- **§3 disagrees with them in writing.** Worth it: they will otherwise calibrate their threshold
  against our silence, and the withholding costs you manual work every time it fires.
- **I told you their caution was better founded than my confidence. That was wrong** and the note
  now says the opposite, with the reason. Their own letter confirms the sender's phone matched the
  ask, so attribution was never the issue.
- The group-share question at the end of §3 is the one to watch for in their reply. If most
  threads are groups, the hold needs a tighter trigger than they are proposing.
- Not mentioned: their letter references our §6 and §13; our note had 12 sections and the numbers
  run one out. Harmless — the content they quote is unambiguous.
