# Tenafy → TaneChat — what's new (August 2026)

**Status: LIVE as of 14 August 2026.** Nothing here breaks what you have today — every change is
additive, every new parameter is optional, and existing fields keep their meaning.

Full reference stays `tanechat-integration-guide.md`. This note is just the delta.

---

## 1. You can filter by area now — `district` and `city`

You asked for this. Every vacancy now carries both:

```json
{ "label": "Mercer 5B", "property_name": "Mercer",
  "district": "Sheung Wan", "city": "Hong Kong" }
```

**Use `district` for "I want to live in X", not `property_name`.** Property names do not reliably
encode the area — *Nam Pak Hong* and *Po Thai* are in Sheung Wan, *Jardine* is in Causeway Bay, and
none of them say so. Districts in use today: Sheung Wan, Causeway Bay, Central, Mong Kok, Wan Chai,
Prince Edward, Kowloon City.

`city` is "Hong Kong" almost everywhere, so it carries no discriminating information. Filter and group
on `district`.

Both are `null` when unset. Two live properties have no district — one is an office, so you will not
see it in a normal availability answer.

## 2. Resolve a unit from the listing link — `listing_url`

This is the fix for the "pick a unit from a list of one" problem you reported.

**Every vacancy now returns `listing_url`**, and **`POST /viewing-negotiation/start` now accepts it**:

```json
POST /viewing-negotiation/start
{ "listing_url": "https://taneresidence.com/product/bonham-strand-west-studio-a-2/",
  "prospect": { "name": "Alex", "phone": "+852…" } }
```

That skips fuzzy matching entirely and goes straight to asking for a day.

- Precedence: **`unit_id` → `listing_url` → `unit_text`**.
- We compare after stripping scheme, `www.`, query string, fragment and trailing slash — so an
  **`?fbclid=…` ad link works unchanged**. Verified against every live unit.
- `listing_url` is `null` for roughly a third of units, so treat it as a fast path, not a guarantee.
- If the URL doesn't resolve and you sent `unit_text` too, we fall back to it. If you didn't, you get
  `available: false` with `listing_url_not_found` or `listing_url_ambiguous`. **We never guess** when a
  URL matches more than one unit.

**New: `resolved_by`** on a successful start — `"unit_id"`, `"listing_url"` or `"unit_text"`. Check it.
It is how you tell an exact start from a silent fall back to fuzzy matching.

## 3. Text matching now understands street names

Your `"7A Bonham Strand West"` used to resolve as *ambiguous*, because the property is named
*Nam Pak Hong* and we only matched on property name, district and city. We now match the street too.

That exact phrase, and `"Studio 7A, Bonham Strand West"`, now resolve **confident** — a yes/no
confirmation instead of a numbered list. Same for `"tung choi 5a"` (Mong Kok) and `"russell 105"`
(Lai Yuen). We verified no existing phrase changed behaviour.

Street *numbers* are deliberately ignored — "8 Cleverly Street" will not read `8` as a unit — and
generic words (street, road, building) match nothing on their own.

**Still prefer `listing_url` or `unit_id`.** If you must send text, unit + district
(`"7A Sheung Wan"`) beats unit + street.

## 4. A hard availability filter — `free_on`

```
GET /vacancies?free_on=2026-10-15
```

Returns only units that are available by that date **and** have nobody already moving in on or before
it.

**This is different from `target_date`, and you can send both:**

| Param | What it does |
|---|---|
| `target_date` | **ranks** and warns by gap. Does not exclude on availability. |
| `free_on` | **filters**. A unit that fails it is not returned. |

Use `free_on` when the customer has a firm date. Removed rows are counted in `hidden_by_free_on`, so a
short list is explainable. A malformed value is a `400`, same as `target_date`.

## 5. You can now see an incoming tenant — `availability.next_move_in_date`

Previously invisible. A unit could be empty today with a new tenant arriving in 60 days and be
reported simply as "available now".

```json
"availability": { "status": "now", "available_from": null,
                  "next_move_in_date": "2026-10-15", "days_until": 0, "certain": true }
```

`null` means nobody is booked. When it is set, **the unit is only free until that date** — worth
knowing before you offer it for a 12-month let. `free_on` applies this automatically.

## 6. New in the payload: `source`, and a third phrasing line

Every vacancy now carries **`source`**: `"lease"` (normal — derived from real lease data) or
`"manual"`.

`"manual"` means an operator has flagged a unit as *possibly* becoming available because the current
tenant said they might move out early. **The lease has not ended and nothing is confirmed.**

These always come back with `certain: false`, and there is a new template for them:

| Situation | Use |
|---|---|
| `certain: true` | state it plainly |
| `certain: false`, `source: "lease"` | `phrasing.uncertain` — the tenant **may renew** |
| `certain: false`, `source: "manual"` | `phrasing.manual` — the tenant **may leave early** |

Those are two different kinds of uncertainty and read differently to a customer, so please don't
collapse them. Branch on `source` only after checking `certain` — `certain` remains the primary signal.

**Do not say why the unit might free up.** `phrasing.manual` deliberately says only "not confirmed
yet". The occupant has not committed to leaving and may well stay — their intention is not a
prospect's business. Use the template as written and don't add an explanation.

### Viewings on a manual unit — nothing changes for you

**Treat it exactly like any other occupied unit.** It has a live lease and someone living in it, so a
viewing goes down the same path you already implement: you start the negotiation, the occupant is
asked, silence counts as agreement, and the states, timers and endpoints are all identical. There is
no new call and no special case. Please don't build one.

**If the request is withdrawn or expires mid-conversation**, the unit simply stops appearing in
`/vacancies`, and a *new* viewing request for it will come back as `NEEDS_STAFF` with
`needs_staff_reason: "off_window"` — a human picks it up from there. A negotiation already in flight
carries on unaffected. This is normal, not an error, and not worth reporting as a bug.

**Never present a manual unit as held, reserved or promised.** Nothing is committed. If a customer
pushes for certainty, the honest answer is that we'll know shortly and can tell them either way.

---

## Nothing you must change

Every field above is additive and every new parameter is optional. If you change nothing, you keep
today's behaviour.

If you do one thing, make it **sending `listing_url` on start** — it removes the unit-selection step
for prospects arriving from a listing link, which is the case you raised.

## Quick checklist

- [ ] Filter/group on `district` instead of guessing from `property_name`
- [ ] Send `listing_url` at `/viewing-negotiation/start` when the prospect came from a listing
- [ ] Read `resolved_by` and log it — it tells you when you silently fell back to fuzzy matching
- [ ] Send `free_on` when the customer has a firm move-in date
- [ ] Check `availability.next_move_in_date` before offering a long let
- [ ] Add `phrasing.manual` handling, branching on `source`
- [ ] If you send text, prefer unit + district over unit + street
