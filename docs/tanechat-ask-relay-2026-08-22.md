# To TaneChat — five renewal replies never reached us

**Draft for Chris to review and send. Not sent.**

Short and single-purpose on purpose: this asks one question. The classifier fix and the
rest are in `tanechat-reply-renewals-2026-08-22.md` and can go separately, so the ask does
not get buried.

---

Hi team,

A question rather than a bug report — we may have got the contract wrong at our end.

We sent nine renewal asks on 21 August, eight of them at 10:00. Five tenants replied on
WhatsApp. **None of the five reached us** — `POST /renewal-ask/:id/reply` was not called for
any of them, so all five sat in our system as unanswered.

```
21 Aug 02:04   Gilman's Bazaar 2A   "please extend my stay"
21 Aug 03:57   Poplar 3D            "Yes please another month"
21 Aug 02:14   Poplar 4A            "Yes please" ... "3 months please"
21 Aug 05:16   Mong Kok 1C          "yes we will continue"
21 Aug 04:48   Hollywood 1B         "possible to pause the lease ... continue until December?"
```

Nothing is lost — we read the threads and recorded them by hand. But the failure mode is
worth naming: those asks stayed open, so the sequence had queued the same question to go
out to tenants who had **already answered**. Andrea confirmed at 02:04 and was in line to
be asked again.

## What we would like to know

Three possibilities and we cannot tell them apart from our side:

1. **The relay is not built or not deployed yet.** Entirely possible, and fine — say so and
   we will stop looking for a fault.
2. **It is running and erroring.** If so, could you send us the response you get? The
   endpoint returns a body on every path including refusals, and it will say why.
3. **We never agreed the trigger.** If it was never clear when you should call us, that is
   ours to fix, and the fix is the contract rather than anyone's code.

## If it is worth a check on your side

- `POST /api/public/renewal-ask/:id/reply` with `{"intent": "extend" | "leaving" | "unsure"}`,
  or `{"text": "<what they wrote>"}` and we classify.
- `GET /renewal-asks/open` gives the id. One open ask per tenant at a time, so a bare "yes"
  cannot be misfiled — but the id still has to come from somewhere.
- A 200 with `recorded: true` is the success case. Anything else, we would like to see.

No rush on the classifier or anything else — this one just needs an answer either way, so we
know whether to expect replies to arrive on their own next cycle or to keep reading the
inbox manually.

Thanks,

Chris

---

## Notes for Chris (not part of the message)

- **Deliberately makes no accusation.** We genuinely cannot tell which of the three it is,
  and option 3 is ours. If it turns out to be unbuilt, nothing here needs walking back.
- **Sendable as-is** — nothing in this note describes unreleased work, unlike the longer
  draft, which needs the classifier deployed first.
- The next ask cycle will re-ask the four tenants who have still not replied at all (Fuk Lo
  Tsun 3/F Unit 1, Hillier 2A, Nam Pak Hong 7D, Tai Yuen 25/F). The five above will not be
  re-asked now that their replies are recorded.
