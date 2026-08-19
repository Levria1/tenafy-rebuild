# Tenafy → TaneChat — answers to your three API asks (19 August)

Hi Chris,

Thanks for the write-up, and for owning the incident so precisely — it made this quick to check from
our side.

One corroboration first: your diagnosis is right, and our data supports it. Our published viewing
window for this org is **Mon–Sat, 11:00–19:00**. The 11:00 in that draft is our opening hour, which is
exactly what a model would produce given our hours and a retired booking script but no actual
negotiation to read.

---

## 3. Read-back on propose/counter — this is already built, and it already names the unit

Good news, and possibly a live bug worth chasing together.

The read-back exists, it is switched on for this org (`read_back: 1`), and it fires exactly where you
asked — on a fresh time proposal, before we touch the calendar and before the occupant hears anything.
The message we generate is:

> "Just to confirm — a viewing of **{unit}** at **{property}** on **{proposed time}**? Reply YES to
> confirm, or send a different day and time."

So it already carries the unit, the property and the time. Nothing to add.

**Which raises the more useful question: why are you not seeing it?** Two possibilities, and the second
would matter a great deal:

1. This org runs `relay_mode: manual`, so that message is **queued as a draft for staff rather than
   auto-sent**. You would receive it through the drafts flow rather than as an automatic outbound. If
   your integration only watches auto-sent traffic, it would look absent.
2. If your drafting layer composes its own message for these turns instead of sending the draft we
   produce, our read-back never reaches the prospect — you would be generating replacement text at
   precisely the moment we had already written the safe version.

The second is worth checking properly, because it is the same shape as last week's incident: a
model-authored sentence standing in for a system-authored one. If that is what is happening, the fix on
your side is smaller and more valuable than any field we could add — send our draft for these turns
rather than composing over it.

Happy to trace a specific negotiation with you if that helps.

---

## 1. Confirmed slot on `/viewing-negotiation/active` — yes, with three caveats

Agreed, and it is smaller than you would think: `current_proposed_datetime` is already fetched by that
query and simply dropped when we build the payload.

### ⚠️ Settle the timezone question before you build anything

You wrote that you run the box in UTC and derive Hong Kong wall-clock in application code. **Our
payloads are already Hong Kong wall clock, with no offset** — `proposed_start_at` included, and that
was true before this change. If your new server applies its own "derive Hong Kong" step to a value
that is already Hong Kong, every viewing time lands **eight hours out**, and a verification check built
on it would confirm wrong times rather than catch them.

Given you have just moved servers, please confirm this independently of this ask: **is the new box
treating our timestamps as UTC?** It is the same failure class we fixed together last week, and a
server move is exactly how it comes back.

On the format: we would rather not put an offset on this one field, because a single
offset-suffixed value sitting beside zone-less ones — with nothing in the payload distinguishing them —
is precisely how the original mix-up arose. But you are right that "trust the prose" is not good enough
after the week you have had. So we propose making the object **self-describing** instead:

```json
"confirmed_slot": {
  "start_at": "2026-08-21T11:00:00",
  "end_at":   "2026-08-21T11:30:00",
  "timezone": "Asia/Hong_Kong",
  "unit_id": "8326307481849856",
  "unit_label": "Poplar 2B"
}
```

Same convention as the rest of the payload, but the zone travels with the value, so nothing has to be
inferred and no offset arithmetic is required at either end. If you would still prefer true offsets we
will do it — but as a versioned change across **every** timestamp at once, with notice, rather than one
field at a time.

### Two more things

- **`AUTO_CONFIRMED` is a separate state and also means committed.** It is what happens when the
  occupant does not reply in time. If you branch on `CONFIRMED` alone you will treat a real viewing as
  "none exists" and refuse a true statement — the opposite of the failure you are guarding against.
  Branch on both.
- **On the end time:** the negotiation itself holds only a start, but once a viewing is confirmed we
  create a booking that does carry a duration — currently 30 minutes, from a column default rather than
  a setting anyone has chosen. So we can give you `end_at` for a confirmed slot, which is the state you
  care about. Just know it is a default rather than a considered policy; if the length of a viewing
  starts mattering to you, say so and we will make it a real configurable value first.

---

## 2. Renewal-decision deadline — our concern with sending a date

Your instinct about the 45 days was reasonable, and the date *is* arithmetically derivable as lease end
minus notice period. We checked the live data before answering, and it does not support the field:

- **101** units are currently undecided (may-renew or unconfirmed) with a future lease end.
- **43 of them have a real notice period recorded** — 42 at 45 days, one at 30. The other **58 have
  none**, so any date for those would be a house default rather than anything from the lease.

So the answer splits, and we would rather split it than pick one blanket policy:

**Where the lease records a notice period, we will send you the date.** It is real — lease end minus
notice — and you can use it as you intended: *"we should know by 5 September."*

**Where it does not, we will send nothing rather than a default.** The tempting alternative is to send
a guessed date with a flag such as `basis: "default_30_days"` and let you hedge the wording. We would
rather not, for one specific reason: a draft on 18 August presented a may-renew unit as firmly available
even though `availability.certain` was `false` in the same response, and your own pre-send check caught
it. That is not a criticism — it is evidence that a qualifier sitting one hop from the text is easy for
a drafting model to drop, and a date carries far more weight with a prospect than a flag does. An absent
field cannot be misread; a flagged guess can.

So `renewal_decision_by` will be present and true, or absent. Never present and invented.

**And for the units with no date, we are going after the actual answer instead.** When a prospect asks about a unit whose tenant has not decided, and we are inside the
decision window, we will ask that tenant directly whether they intend to renew — through you, so it
still comes from the one number. Their answer updates the renewal intent you already read, which means
you stop getting "the tenant may renew" on that unit and start getting a real
`availability.certain: true` or the unit dropping off the roster honestly.

That is a better answer to the question you actually asked — *"does this resolve in days or months?"* —
because it resolves it rather than estimating it.

Two notes on scope so you can plan:

- This is a workflow on our side, not a field, so it will take longer than asks 1 and 3. We will come
  back to you with the design before anything reaches a tenant, since the messages would go through
  your channel.
- It is demand-triggered by design. Of those 101 units, only **4** are both undecided and past their
  decision window today — and two of them are units your prospects have asked about this week. We are
  not going to chase 101 tenants; we are going to chase the ones someone actually wants.

If you would still rather have an estimated date in the meantime, we can send one clearly marked as an
estimate so you can hedge the wording. Tell us and we will add it — we just do not want to hand you a
guess that reads like a fact.

---

## Summary

| Ask | Answer |
|---|---|
| 1 — confirmed slot | **Yes**, as Hong Kong wall clock with no offset. Please confirm your new server is not converting. |
| 2 — renewal deadline | **Yes where it is real** (43 of 101 leases), absent where it would be a guess. Asking the tenant for the rest. |
| 3 — read-back | **Already built, on, and it names the unit.** Worth finding out why it is not reaching you. |

Happy to take a call, particularly on the timezone question — worth five minutes now rather than a bug
later.

Thanks,
Tenafy
