# Handoff: automating the Facebook posting run

**For:** an agent picking up the browser-automation half of Tenafy's advertising system.
**Status of the other half:** done and deployed. The API, the schedule, the rules and a Python
client all exist and work. You are building only the part that puts a post into Facebook.

---

## 1. What the job is

Every day, Tenafy decides which vacant/expiring units should be advertised, into which Facebook
group, from which of six accounts. Your job is to carry that out: log in as an account, open the
group, upload that unit's photos, paste the prepared text, post, move on.

**You are not deciding what to post.** Tenafy already decided. Read the plan and execute it.

---

## 2. Getting the plan

### The easy way — the client already exists

`scripts/tenafy_posting_plan.py` (repo root). Stdlib only, nothing to install.

```bash
export TENAFY_API_KEY='pk_...'                  # ASK THE OPERATOR. A read-only key is enough.
export TENAFY_PHOTO_ROOT='/path/to/photos'      # local folder holding unit photos

python3 tenafy_posting_plan.py                  # today, human-readable
python3 tenafy_posting_plan.py --json           # machine-readable — USE THIS
python3 tenafy_posting_plan.py 2026-08-13       # a specific date
python3 tenafy_posting_plan.py --check-photos   # verify folders before you start
```

### The API directly

```
GET https://platform.tenafy.com/api/public/posting-plan?date=YYYY-MM-DD
Header: X-API-Key: <key>
```

`date` is optional and defaults to today in **Hong Kong** time. A read-only key works for this;
you do **not** need a write key.

### The `--json` shape you'll consume

```json
{
  "date": "2026-08-12",
  "day_name": "Wed",
  "slot_count": 7,
  "tier_counts": { "vacant": 0, "nr": 3, "other": 4 },
  "instructions": [
    {
      "slot": "Prop 1",
      "position": 1,
      "tier": 2,
      "tier_name": "NR",
      "extra": false,
      "property": "Fuk Lo Tsun",
      "units": ["1F"],
      "group_name": "Find A Room In Hong Kong",
      "group_url": "https://www.facebook.com/groups/834480980283746/",
      "post_as": "tane.joanne@gmail.com",
      "owned_group": true,
      "post_text": "Fuk Lo Tsun Road Kowloon City Serviced Studios - $5,000 HKD and Up\n\n…",
      "photo_folders": [
        { "image_hint": "Fuk Lo Tsun/1F", "folder": "/path/to/photos/Fuk Lo Tsun/1F" }
      ]
    }
  ]
}
```

- **`post_text` is final.** It is already rendered from the unit's template with price,
  availability date, amenities and the operator's contact footer. Post it verbatim. Do not
  rewrite, summarise, translate or "improve" it.
- **`photo_folders`** is a list because one posting can cover several units (e.g. "Gilman 4B/5B").
  Upload from every folder listed.
- **`post_as`** is which account to be logged in as. Not optional — group membership is per
  account, and an account that isn't a member cannot post there.

---

## 3. Photo folders

Layout is `PHOTO_ROOT / <Property> / <Unit>`:

```
/photos/Fuk Lo Tsun/1F/
/photos/Gilman's Bazaar/5B/
```

`image_hint` gives the `Property/Unit` part. Note property names contain spaces and apostrophes
(`Gilman's Bazaar`) — quote paths properly.

Run with `--check-photos` first. It flags a missing folder or an empty one **before** you start a
posting run, which is much better than discovering it half way through.

---

## 4. Group the run by account, not by property

Six accounts, and switching account means a full logout/login. The client already groups its output
by `post_as` for this reason. Do all of one account's posts, then switch.

**Accounts:** `tane.joanne@gmail.com`, `parcellesignature@gmail.com`, `taneresidence6@gmail.com`,
`taneresidence4@gmail.com`, `acjairbnb@gmail.com`, `bookings@taneresidence.com`.

---

## 5. Owned vs external groups — this changes the risk

Of eleven groups, **the operator administers three**:

| Group | |
|---|---|
| Hong Kong Apartments – NO FEE RENTALS | **owned** |
| Hong Kong Apartments – Short term Rentals | **owned** |
| Find A Room In Hong Kong | **owned** |

The other eight belong to other people. `owned_group` in the JSON tells you which is which.

Volume into an owned group costs nothing — No Fee Rental deliberately takes ~15 posts a week from
several accounts, and that is fine. **The eight external groups are where a restriction actually
hurts**, because they are distribution the operator does not control. The busiest external group is
*Hong Kong Apartment For Rent & Sale* at ~7 posts/week.

Be more careful in external groups: slower, and stop at the first sign of trouble.

---

## 6. Hard constraints

1. **Post `post_text` verbatim.** See above.
2. **Never post to a group the plan didn't name for that unit.** The schedule encodes which group
   is allowed on which day. Improvising defeats it.
3. **One posting per instruction.** Do not retry a post because you're unsure it worked — see §7.
4. **Human-paced.** Do not fire seven posts in ninety seconds from one account. Space them out
   (minutes, irregular), and vary the order within an account if you can. Bursts are exactly what
   automated-behaviour detection looks for.
5. **Stop the whole run on the first failure.** Do not continue to the next account.
6. **Never post to a group as an account that isn't a member.** The plan won't ask you to; if it
   seems to, something is wrong — stop and report.

---

## 7. Failure modes, and the one that matters most

**A silent block looks identical to a success.** Facebook may accept a submission, show no error,
and simply not publish — or publish only to the author. This is the failure mode to design for.

So: after submitting, **verify the post exists** before treating it as done. Reload the group or
check the account's activity. If you cannot verify, record it as *unverified*, not as posted, and
stop the run.

Other cases:

| Symptom | Do this |
|---|---|
| Login challenge / 2FA / checkpoint | Stop the run. Report which account. Never attempt to bypass. |
| "You're posting too fast" / temporary block | Stop the run entirely, don't switch accounts and continue. |
| Group requires admin approval | Fine — record as *pending*, continue. |
| Photo upload fails | Stop that posting, record it, continue to the next only if the failure was clearly local (e.g. corrupt file). |
| Post box layout unrecognised | Stop. Do not guess at selectors and click blindly. |

**Report at the end**: for every instruction, one of `posted` / `pending-approval` /
`unverified` / `failed` / `skipped`, with the reason. The operator needs to know what actually
went out, and "probably fine" is not an answer.

---

## 8. Optional: telling Tenafy what you posted

```
POST https://platform.tenafy.com/api/public/posting-plan/mark
Header: X-API-Key: <a WRITE-capable key>
```

This writes an audit record of what went out. **It is genuinely optional** — nothing in the plan
depends on it, and the read-only key cannot call it (the API rejects writes from read-only keys
with 403).

Only use it if the operator asks. If they do, they'll need to issue a write-capable key. Otherwise
keep your own local log — that satisfies the "don't post twice in one day" need without needing
write access at all.

---

## 9. Why a unit might be absent from the plan (don't "fix" this)

Absences are usually deliberate. Tenafy applies these rules, all configurable in
**Advertising → Settings**:

- **Vacant** units rank top and get the most postings — but only if they're free for at least
  **40 days**. A flat with a new tenant moving in next week is *effectively taken* and is
  intentionally excluded.
- **NR** (Not Renewing) leases start being advertised **60 days** before expiry.
- **MR / MTM / UC** leases start **45 days** before expiry.
- A unit outside its window is not advertisable *yet*.

If the plan looks short, that's usually correct. The client's empty-plan message distinguishes the
four real causes (no slots scheduled, more properties than slots, missing templates, or the rules
excluding everything) — read it rather than assuming a bug.

Two other fields worth understanding:

- **`extra: true`** — a second posting for a property that day, filling a slot that would otherwise
  be idle. Treat it exactly like any other posting.
- **`tier`** — 1 vacant, 2 NR, 3 MR/other. Informational; if you must truncate a run, drop tier 3
  first.

---

## 10. Do not

- Do not modify anything in the Tenafy repo or database. Your job is browser-side only.
- Do not create, join, or leave Facebook groups.
- Do not message anyone, reply to comments, or handle inquiries. Inquiries arrive through a
  separate WhatsApp/email pipeline.
- Do not store the API key in a file you commit. Environment variable only.
- Do not attempt to defeat a login challenge, CAPTCHA or checkpoint. Stop and report.

---

## 11. Sanity check before your first real run

```bash
python3 tenafy_posting_plan.py --check-photos     # folders present, images present?
python3 tenafy_posting_plan.py --json | head -40  # shape as expected?
```

Then do **one** posting, manually verified end to end, into an **owned** group (No Fee Rental,
Short term Rentals, or Find A Room) — those are the operator's own, so a mistake is recoverable.
Only automate the full run once one posting has demonstrably worked.
