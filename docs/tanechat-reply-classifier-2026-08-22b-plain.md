# The TaneChat letter, in plain English

**SUPERSEDED** — describes the 22 August letter. Current: `tanechat-price-and-numbers-2026-08-24-plain.md`.

**For Chris, before sending.** This explains what the letter
`tanechat-reply-classifier-2026-08-22b.md` actually says. It is not the letter and is not
for them — read this, then send that.

---

## The situation in one paragraph

Tenants reply to renewal questions on WhatsApp. TaneChat owns WhatsApp; we own the leases. When a
tenant says "yes, I'll stay", somebody has to decide that the sentence means "extend" — and then
somebody has to act on it. The letter settles who does which, confirms the things we built for
them, and disagrees with them about one judgement call.

---

## 1. Who decides what a tenant's message means — us

**We keep the job of reading a tenant's sentence and turning it into a decision.** They send us the
raw words and no opinion.

Their argument, which was better than ours: the decision should be made once, in the place where it
has consequences. Our system is the one that extends the lease and pulls the flat off the market,
so our system should be the one that decides. Two systems both deciding, each assuming the other is
the safety net, is how a tenant gets a lease extended by accident.

**The condition we accepted in writing:** we stay cautious. Anything that isn't a clear yes or no
gets filed as "not sure", which records the message and does nothing else. If we ever want to
loosen that, we tell them first.

## 2. We now tell them what we couldn't find

If a customer writes "is Mong Kok 6A available?" and there is no 6A, we used to just answer about
whatever else we recognised and say nothing about the 6A. That reads as though we weren't
listening.

Now we tell them exactly which words looked like a flat but matched nothing — **and which flats
that floor does have.** So instead of "I can't find a 5E", the bot can say "there's no 5E, that
floor has 5A to 5D."

We were careful that it doesn't cry wolf: "400 sqft", "25k", "6pm", "12 months" and "September"
all stay quiet. It only speaks up when something genuinely looks like one of our own unit names.

## 3. Group chats — we think they're being too careful

A tenant answered a renewal question in a group chat. TaneChat's rule was to withhold anything said
in a group and route it to a human, so the answer never reached us.

**We disagree, and the letter says so.** Their worry was that a group can't prove who is speaking.
But their own code already identifies the individual sender, and their own letter admits it. What
actually stayed uncertain was the wording — "extend my stay" could mean a few more nights. That's a
question about the *words*, not about the *group*, and the same words in a one-to-one chat get
passed through without anyone pausing.

The specific message they withheld was not ambiguous. Three minutes earlier the same tenant wrote
"I would like to confirm the apt for the following month". That's a month, not a few nights. We
read it that way, extended her lease by hand, and she then stayed queued to be asked whether she
was renewing — having already said yes twice.

**The asymmetry we point out:** if we wrongly think a tenant is staying, we lose a day's listing.
If we wrongly think a tenant is leaving, we could market an occupied home. So the cautious answer
isn't "withhold everything" — it's "be careful in the expensive direction". Withholding a
confirmation applies the expensive standard to the cheap decision.

**What we gave them anyway:** a way to send a message marked "we're not certain this is an answer".
It records the words, pauses the reminder sequence for a week, and flags it for a person. It
changes nothing about the lease. The pause expires on purpose — an indefinite one would quietly
drop a tenant out of the sequence forever, which is worse than the nagging it prevents.

## 4. Two bugs we found in our own system and reported unprompted

Nobody asked us about these. They were live and they were worse than anything TaneChat reported.

**A budget was being read as a flat number.** "Tai Yuen, my budget is 25k" — our system saw the
"25" inside "25k" and confidently answered about **flat 25/F**. Not a guess, not a question. A
confident wrong answer. It did this on 16 of 55 realistic ways of phrasing a budget.

**One shared word in an address named the wrong building.** Fuk Lo Tsun's address ends "Kowloon
City". The word "city" in "pearl city" was enough to match it. Combined with the bug above,
**"pearl city, my budget is 30k" confidently returned a Fuk Lo Tsun flat** — wrong building, wrong
flat, from a message that named neither.

Both fixed. And correct answers to ordinary questions went **up**, not down, because the sloppy
rule had been creating fake rival matches that pushed real answers into "not sure".

## 5. Their bug report about pricing — they were right, the cause was worse

They said a normal price filter was deleting flats. It was. But not for the reason they thought.

We were filtering on the raw stored price while *displaying* a corrected one. `Poplar 2B` is stored
as 34,434 — the total for an 86-day let, not a monthly rent. So we'd tell them the flat costs
13,000 a month and then hide it under a 14,000 ceiling. Fixed: both now use the same number.

---

## What changed since you last saw this draft

**The relay is now actually working, and we can prove it.** This is the biggest change, and it's
good news.

Their fix went in and the very ask that had been refused came through 23 minutes later. Since then
three real tenant replies have travelled the whole way, all filed correctly:

- **Hollywood 1B** — "Thank you, I'll check when I'm back" → filed as *not sure*, held for a person
- **Tai Yuen 25/F** — "Sorry I thought i have express my intent to leave on my email" → *leaving*
- **Fuk Lo Tsun 3/F** — "yes we would like to extend til the end of the year December 31st please!"
  → *extend*, lease updated, flat pulled from the public listings, nobody in the loop

That last one is the entire system working by itself. The first one is the same system correctly
refusing to guess. Together they're the best evidence we have that the arrangement in section 1 is
sound.

**They answered our group-chat question, and the answer went against their own position.** We had
asked what share of their tenant threads are group chats, because if it were most of them their
withholding rule would send the majority of real answers back to you by hand. It's 12%, and none of
the ten tenants currently carrying a renewal question are on a group thread. I counted those ten
independently against our own records and got the same ten. The letter now thanks them for it
instead of asking again — they answered a question that could have gone badly for them, with the
number that decides it.

**One section was cut to a few lines.** We'd written a long explanation of a field they said was
missing. They worked it out themselves before we replied. Leaving our lecture in would have been
rude, so it's now one line saying there's nothing to fix.

**One of our sentences was slightly wrong and is now exact.** We'd written that a "leaving" answer
"never acts automatically". It does get recorded on the lease — what it never does is put the home
back on the market. They read carefully and correct us when we're loose, so better we correct
ourselves first.

---

## What I checked on the live system before finalising this

Everything the letter claims as a live fact, re-run against production today:

| Claim | Result |
|---|---|
| Bot is told which flats it couldn't find | Works — "mong kok 6a 5a" answers about 5A and reports no 6A |
| Floor context ("that floor has 5A–5D") | Works — returns exactly those four |
| Budget no longer read as a flat number | Fixed — "budget is 25k" no longer picks flat 25 |
| "pearl city" no longer returns a Kowloon City flat | Fixed |
| The field they thought was missing | Present, both with and without a district |
| Price filter no longer deletes Poplar 2B | Returns on a normal monthly band |
| The four extensions you did by hand | All four still correctly marked "don't replay this" |
| Ten tenants currently carrying a renewal question | Confirmed — same ten they counted |

---

## Before you send

- **The letter quotes three tenants' actual words** in a table. It's the strongest evidence in the
  letter, but if you'd rather not put tenants' messages in writing to a partner, cut the table —
  the paragraph above it still makes the point.
- **Section 3 disagrees with them in writing.** That's deliberate. If we stay silent they'll
  calibrate against our silence, and every time they withhold a clear answer it costs you manual
  work.
- **Section 5 is us confessing two of our own bugs** that nobody asked about. Worth keeping — the
  budget one would have bitten them eventually and they'd have had no way to diagnose it from
  their side.
- Nothing in the letter needs a decision from you. It's all built, deployed and re-checked.
