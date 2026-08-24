# The new TaneChat letter, in plain English

**For Chris, before sending.** Explains `tanechat-price-and-numbers-2026-08-24.md`. Read this,
then send that. This is not for them.

---

## The short version

TaneChat found two bugs on our side. **They were right about both, and we had already told them
one of them was fixed.** Investigating the second one turned up something worse than what they
found. Both are now fixed and tested, but **not yet deployed** — the letter must not go out until
they are.

---

## Bug one: the price filter compared the wrong price

When TaneChat asks us for flats under HK$14,000, we were checking that against **what the current
tenant pays** — not what a new tenant would pay. Those are different numbers on 41 of 49 flats.

So a customer with a HK$14,000 ceiling was shown a flat we'd quote at HK$14,500, and never shown
the one we'd quote at exactly HK$14,000. Wrong in both directions at the same time.

We got the cause wrong twice. They proposed one explanation, we replied with a different one, and
neither was right. Their latest note worked it out properly and it's simpler than either: two
different prices, nothing keeping them in step.

**The embarrassing part:** our last letter told them to drop their own safety check because we'd
fixed it. They didn't — they extended it instead. If they had listened to us, real customers would
have seen wrong flats. The letter says this plainly.

**Now fixed** so that the filter and the quoted price come from the same function, which is the
part that stops it happening again.

## Bug two: a number in a sentence was being read as a flat number

They reported a mild version: a customer writing "$10-13K per month" produced a vague match on
Tai Yuen 10/F. Annoying, not dangerous — we returned a list of maybes, not an answer.

**When I went looking, it was much worse.** We have twelve flats whose names are just numbers —
3, 10, 11, 21, 22, 23, 25, 26, 59, 60, 103, 105. Any bare number in a customer's message that
happened to match one of those was read as naming that flat, **confidently**:

- "Tai Yuen, my budget is 10,000" → confidently flat 10/F
- "Fuk Lo Tsun, we are 3 people" → confidently flat 3/F
- "Fuk Lo Tsun 3 bedroom flat" → confidently flat 3/F
- "anything in Tai Yuen for a 10 month lease" → confidently flat 10/F

Nine out of ten ordinary sentences I tried. A comma in a budget, a headcount, a lease length, a
bedroom count.

This is the **second time** a budget has been read as a flat number, and the second time we
announced it fixed. The previous fix closed "25k" and left "25,000" — because it required the
number to match *exactly*, and a comma-formatted budget produces exactly the number.

**Now fixed:** a number only names a flat when the customer marks it as one — "flat 10", "unit 25",
"10/F". A bare number is treated as what it nearly always is: money, people, or months.

**One deliberate trade-off:** "Tai Yuen 10" on its own now answers "which flat?" instead of
guessing 10/F. A question beats a wrong answer.

## Bug three: our own chatbot has the same problem, and it's costing money

This one is ours alone and TaneChat couldn't have seen it.

Our own AI assistant runs on the same search engine, and it's being handed **the current tenant's
rent** as the price to quote a prospect. Not the asking price.

```
under-quoting   35 of 49 flats   average HK$1,401/month   worst HK$3,500
over-quoting     6 flats
correct          8 flats
```

TaneChat fixed this on their side the moment we published the asking price. Ours never did,
because ours was never reading it.

**Now changed, on your call** — our bot is handed the asking rent and told to quote it, the same
number TaneChat uses. So both assistants now quote the same figure for the same flat. It affects
nothing TaneChat receives; their prices were already correct.

## One place where they're wrong

Their note says every unconfirmed flat is cheaper than the cheapest confirmed one, so ignoring
unconfirmed stock was the same as saying "nothing under HK$12,500".

That's true of the nine flats they happened to sample. It isn't true generally — over a wider
window our cheapest *confirmed* flat is HK$6,950, and only 2 of 35 unconfirmed flats sit below the
cheapest confirmed one.

Their underlying fix is right and the letter says so first. I flagged it because it's the sort of
memorable line people start planning around.

## What's good news

**Their relay is working.** The ask that got refused came through 23 minutes after their fix, and
three real tenant replies have since travelled the whole way — including one that extended a lease
and pulled the flat off the market with nobody involved.

**They answered our group-chat question honestly**, with the number that decided the argument
against their own earlier position — 12%, and none of the ten tenants currently being asked.

---

## Before you send

1. **Deploy first.** The letter says "we have changed" about both fixes. They're built and tested
   (1070 tests passing) but not live yet. Sending first would repeat the exact mistake the letter
   apologises for.
2. **Section 3 is optional** — it discloses our own bot's under-quoting, now fixed. Keeping it is
   honest and answers a partner who reports things honestly. Cutting it costs them nothing.
3. Nothing else needs a decision. The rest is reporting.
