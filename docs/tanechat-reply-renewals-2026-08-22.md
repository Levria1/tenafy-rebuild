# To TaneChat — the renewal relay has not run, and a classifier fix

**Draft for Chris to review and send. Not sent.**

**Deploy the classifier change before sending** — the note describes it as live.

---

Hi team,

Something is not running on the relay, and I would rather ask than guess. Five tenants
answered a renewal question and none of the answers reached us.

## What happened

We sent nine renewal asks — eight on 21 August at 10:00, one on the 20th. Checking the
WhatsApp threads afterwards, five tenants had replied. All five sat in our system as
unanswered, because `POST /renewal-ask/:id/reply` was never called for any of them.

```
Gilman's Bazaar 2A   "please extend my stay"                     -> not relayed
Poplar 3D            "Yes please another month"                  -> not relayed
Poplar 4A            "Yes please" ... "3 months please"           -> not relayed
Mong Kok 1C          "yes we will continue"                       -> not relayed
Hollywood 1B         "possible to pause the lease ... and then
                      continue it until December?"                -> not relayed
```

The endpoint is live and we have since recorded all four definite answers by hand, so
nothing is lost. But two things follow from a relay that does not run, and the second is
the one that would have hurt:

- The asks stayed open, so those tenants were queued to be **asked the same question
  again** after already answering.
- If nobody reads the inbox, a tenant confirms and we never act on it.

**Could you check whether the relay is deployed, and whether it is erroring?** If it is
running and something on our side is rejecting it, we would like to see the response you
get — the endpoint returns a body on every path, including refusals, and that will say why.

We are not assuming this is your bug. It may be that we never agreed the trigger clearly,
in which case the fault is ours and we should fix the contract rather than the code.

## A classifier fix, prompted by the fifth message

Hollywood 1B wrote:

> "Would it be possible to pause the lease for 25th Sep to 7th Oct and then continue it
> until December?"

Our classifier read that as **extend**, because "continue" is on the yes list. It is not a
confirmation — it is a question about restructuring, from a tenant who was separately
asking us about a different studio.

That was a real defect and it is fixed. Affirmative signals are now counted only outside
interrogative clauses, so a yes existing solely inside a question no longer decides
anything:

```
before        after
extend    ->  unsure     "can I extend?"
extend    ->  unsure     "how much to extend?"
extend    ->  unsure     "Any chance of another month?"
extend    ->  unsure     "is it possible to extend"      (no question mark — chat often omits it)
```

Plain answers are unchanged, including when a question is attached: "Yes please. How much
is it?" is still `extend`. Only the case where the enquiry IS the whole message moves.

It matters because `extend` is the only intent that acts automatically — it withdraws the
unit from customer-facing feeds. Acting on a question would have taken a home off the
market because someone asked the price of staying.

**This is an argument for sending `intent` rather than `text` where you can.** If your side
has already understood the tenant, tell us the intent directly; classification is our
fallback for raw relay, and it is deliberately conservative rather than clever. Anything
ambiguous becomes `unsure`, which is recorded, changes nothing, and can be superseded by
the real answer later.

## One thing about what "confirmed" means

Worth stating plainly, because it affects what you should say to a tenant. Recording
`extend` does **not** extend the lease. It records the intention and takes the unit off the
market. The end date is unchanged and the paperwork is a separate, human step.

So please do not tell a tenant their lease is extended. Something like "I have let the team
know — they will be in touch with the new agreement" is accurate. A tenant who believes it
is done, when nothing is signed, is the version of this that ends badly.

## For attribution

`GET /renewal-asks/open` lists what is outstanding and who with. A tenant only ever has one
open ask at a time, so a bare "yes" cannot be misfiled — but the id still has to come from
somewhere, and that is the endpoint.

Thanks — and if the relay simply is not built yet, say so and we will stop looking for a
bug.

Chris

---

## Notes for Chris (not part of the message)

- **Deploy first.** The classifier change is committed but the note reads as though it is
  live. 982 backend tests pass; the fix is mutation-tested both ways (remove the
  interrogative filter, and drop the no-question-mark case — each fails).
- **The four recordings came back `applied: false — lease_end_changed`**, because you had
  already extended all four leases by hand on the 21st, matching each tenant's request
  exactly (1 month, 1 month, 3 months, 1 month). Nothing was double-applied. The value of
  recording them was closing the ask so those tenants are not chased again.
- **I told you earlier those four units were live on the customer feed. That was wrong** —
  I inferred it from the missing `renewal_reply` without checking the leases. Your manual
  extensions had already taken them off. Corrected before this note went anywhere.
- **Hollywood 1B is still open and needs you**, not the relay. He wants a two-week gap
  mid-tenancy and has asked about another studio; that is a conversation, not an intent.
- **Not mentioned to them:** four tenants have still not replied at all — Fuk Lo Tsun 3/F
  Unit 1 (Eugene Choi), Hillier 2A (Clement Deschamps), Nam Pak Hong 7D (Ruby Chiu), Tai
  Yuen 25/F (Marco Tang). They will be asked again by the normal sequence.
