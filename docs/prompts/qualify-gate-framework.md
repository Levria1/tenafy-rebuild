# "Qualify Before Showing" — Option B framework

Status: **implemented** in the Tenafy internal chatbot.
- Gate + resolver: `backend/src/services/chatTools.js` (`search_available_units`, `resolve_unit`)
- Flow guidance: `backend/src/routes/chat.js` (`defaultSystemPrompt`)

## The qualifiers
Before showing any unit (details or alternatives) the bot needs three things:
1. Move-in date
2. Target area / district
3. Monthly budget

## The one hard rule — gate the DATA, not just the prompt
A prompt rule that says "ask first" loses to pre-fetched units + a "present them"
instruction — the model goes with the data in front of it. So the qualification
check sits **before** the unit/alternatives lookup. If unqualified → return
nothing to show + an instruction to ask. The model then physically cannot dump
units.

In Tenafy this is enforced inside the `search_available_units` tool: when called
without move-in date + area + budget it returns `{ needs_qualification: true,
missing: [...], units: [] }` instead of any units. A named property
(`property_id`) short-circuits — area + rent are inferable, so only the move-in
date is required.

## The flow
```
Customer message
   │
   ├─ Named a specific unit?  ───────────────┐
   │     • Resolve it (resolve_unit)         │
   │     • Resolved?                         │
   │         YES → area = unit's district    │
   │               budget ≈ unit's rent      │
   │               missing = {move-in date}  │
   │         NO  → ask to clarify (candidates / no_match — never guess)
   │                                          │
   ├─ Gave search criteria directly? ────────┤
   │     • missing = whichever of            │
   │       {date, area, budget} not stated   │
   │                                          ▼
   └────────────► Any qualifier missing?
                     YES → ASK for it (one short question per message).
                           For a named unit, confirm the inferred area + budget
                           in the same message and ask the date.
                     NO  → NOW search / show the unit / offer alternatives.
```

## The named-unit short-circuit
When someone names a unit, resolve it and read its area + price from the data —
don't ask for area/budget you can infer. Only ask what's genuinely unknown (the
move-in date), while confirming the rest.

Reply template:
> "Hi [name], great choice — [Unit] in [area], around HK$[price]/month. To
> confirm, you're looking around [area] with a budget around HK$[price]? When
> were you hoping to move in?"

## Resolution must match how people refer to units
A prospect names a unit by property name, street address, district/area, or unit
identifier ("Studio D" → 7D) — often partial or with typos. `resolve_unit`
matches the reference against all of these (property name + full address +
district + city + unit name/type), tolerates typos, and returns **candidates or
no_match on weak/ambiguous signal** rather than guessing. (Known limitation:
bare unit-letter references like "Studio D" return the address's candidates to
disambiguate rather than auto-mapping to 7D.)

## Once qualified
Proceed normally. If the named unit is unavailable, alternatives use the
qualified inputs: same area, within ~20% of budget, ranked by availability
closest to the move-in date (the shared `unitSearch` engine handles this).

---
_Note: this is the orchestration/flow layer (Tenafy's system prompt + tool
gating), not the shared `chat_knowledge` rulebook. The rulebook holds business
facts/policy; this governs when the bot may show units. TaneChat implements the
same framework on its side._
