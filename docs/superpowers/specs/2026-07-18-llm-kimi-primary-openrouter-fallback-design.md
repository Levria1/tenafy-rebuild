# Tenafy chatbot — Kimi K3 primary + OpenRouter GLM fallback

**Date:** 2026-07-18
**Status:** Approved
**Reference:** mirrors the live-verified TaneChat implementation
(`llmproviderfailover.md`, TaneChat `server/src/services/llm.service.js`).

## Problem

The Tenafy chatbot runs on MiniMax as primary (`llmClient.js` hardcodes it),
which the user finds underpowered. Switch the primary to **Kimi K3** (Kimi Code
coding subscription) with **OpenRouter GLM-5.2** as an automatic, per-request
failover. OCR stays on Google Vision — unrelated to this text path.

## Scope

Backend only. No DB/migration. Files touched:
- `backend/src/config/index.js` — new provider/model/fallback config (doc env names)
- `backend/src/services/kimiClient.js` — **new** Kimi Code connector
- `backend/src/services/openRouterClient.js` — GLM reasoning flag + timeout
- `backend/src/services/llmClient.js` — provider-aware primary + failover + logs
- `backend/src/routes/chat.js` — gate on the active primary's key, not MiniMax's
- `backend/test/llmClient.test.js` — **new** stubbed failover test

MiniMax stays in the tree as a dormant, opt-in legacy fallback.

## Key facts from the reference (authoritative — live-verified)

- **Kimi is "Kimi Code"** (`kimi.com/code`), NOT Moonshot Platform. Base URL
  **`https://api.kimi.com/coding/v1`**, key prefix `sk-kimi-…`. Moonshot hosts
  reject this key with 401.
- **Model `k3`** (not `kimi-k3`). It's a reasoning model: response has both
  `content` (answer) and `reasoning_content` (thinking) — we read `content`.
- **`reasoning_effort: low`** (K3 default is `max`) to conserve the coding-plan
  quota. `reasoning:{enabled:false}` is IGNORED by Kimi.
- **Generous `max_tokens` (12288)** — too low lets reasoning eat the whole budget,
  yielding empty `content`, which we treat as an error → false failover.
- **Fallback = OpenRouter `z-ai/glm-5.2`**, locked to one model (currently the
  latest GLM, released 2026-06-16). GLM is also a reasoning model, so send
  **`reasoning: { enabled: false }`** so the answer lands in `content`.
- **Fail-fast, per-request failover** on ANY primary failure (error / non-2xx /
  timeout / empty content). No aggressive primary retry — a fast fallback beats
  retrying a hung/quota-exhausted primary.
- **Fail-fast timeout** (`AI_TEXT_TIMEOUT_MS`, default 60000).

## Tenafy-specific correctness delta

The reference treats "empty content" as an error. Tenafy's bot uses
**tool-calling**, where a legitimate turn has empty `content` WITH `tool_calls`.
So the empty-content guard fires **only when there are no tool_calls either**:

```
if (!message.content?.trim() && !(message.tool_calls?.length)) throw
```

The thrown error carries `status = 502` so `shouldFallback()` treats it as a
service issue (not an auth error) and fails over.

## Env config (doc naming, adopted verbatim)

```ini
AI_TEXT_PROVIDER=kimi
AI_REPLY_MODEL=k3
KIMI_BASE_URL=https://api.kimi.com/coding/v1
KIMI_API_KEY=sk-kimi-...
KIMI_REASONING_EFFORT=low
# KIMI_MAX_TOKENS=12288          # optional, default 12288

AI_TEXT_FALLBACK_PROVIDER=openrouter
AI_TEXT_FALLBACK_MODEL=z-ai/glm-5.2
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_API_KEY=sk-or-v1-...

# AI_TEXT_TIMEOUT_MS=60000       # optional, fail-fast before failover
# AI_CLASSIFIER_MODEL=<model>    # optional; reserved, defaults to AI_REPLY_MODEL
# AI_TEXT_FALLBACK_MINIMAX=true  # legacy MiniMax fallback, off by default
```

`config.chat` shape:
- `provider` (AI_TEXT_PROVIDER, default `kimi`), `replyModel` (AI_REPLY_MODEL,
  default `k3`), `timeoutMs`, `maxToolIterations`, `enabled`.
- `fallback: { provider, model, minimax }`.
- connectors: `kimi { apiKey, baseUrl, reasoningEffort, maxTokens }`,
  `openrouter { apiKey, baseUrl, model }`, `minimax { … }` (unchanged).

## Router (`llmClient.js`)

```
primary  = providers[config.chat.provider]           // kimi
fallback = fallback.provider && != primary            // openrouter/glm-5.2
         (else legacy minimax if AI_TEXT_FALLBACK_MINIMAX and no generic fallback)

chat(messages, tools, opts):
  try primary.chat({ ...opts, model: opts.model || replyModel })
      → log  LLM answered {"provider","model","via":"primary"}
      → return { ...result, provider, via:'primary' }
  catch err:
    if !shouldFallback(err, fallback) throw err          // auth errors don't fall over
    warn "LLM failing over…"; error "LLM primary provider failed"
    try fallback.chat({ ...opts, model: opts.fallbackModel || fallback.model })
        → log LLM answered {"via":"failover"}; return
    catch fbErr: error "fallback also failed"; throw ORIGINAL err
```

`shouldFallback`: false if no fallback configured, false on 400/401/403, else true.

## Connectors

- **kimiClient.js** — new. `POST {baseUrl}/chat/completions`, Bearer auth. Body:
  `{ model, messages, temperature, max_tokens: cfg.maxTokens,
  reasoning_effort: cfg.reasoningEffort, stream:false, [tools + tool_choice] }`.
  Parse `choices[0].message`; strip `reasoning_content`; empty-content(+no-tools)
  guard → throw 502. `http.request` with `setTimeout(timeoutMs)` fail-fast.
  Single attempt (no retry — fail fast to fallback). Returns
  `{ message, finish_reason, usage, model }`.
- **openRouterClient.js** — add `reasoning: { enabled: false }`, the timeout from
  config, and the same empty-content guard. Keep `X-Title: Tenafy`, `HTTP-Referer`.
  Model from `opts.model || cfg.model`.
- **miniMaxClient.js** — unchanged (dormant legacy path).

## Verification (mirrors reference §7)

`backend/test/llmClient.test.js` (node:test, stubbed — no real HTTP/keys):
1. Healthy Kimi → returns Kimi, `via:'primary'`.
2. Kimi throws 500 → fails over → returns OpenRouter with model `z-ai/glm-5.2`,
   `via:'failover'`.
3. Both throw → `chat()` rejects with the ORIGINAL Kimi error.

Plus `node --check` on all touched files. Real end-to-end (live Kimi/GLM keys)
runs on the droplet after the `.env` is set — can't hit real Kimi locally.

## Non-goals (YAGNI)

- No per-org provider UI — this is a global infra switch.
- `AI_CLASSIFIER_MODEL` wired in config but not pointed at specific call sites yet
  (all callers use the reply model; reserved for a future cost tweak).
- MiniMax not removed — revert = `AI_TEXT_PROVIDER=minimax` (or set primary back).

## Rollback

`AI_TEXT_PROVIDER=openrouter` + `AI_REPLY_MODEL=z-ai/glm-5.2` runs GLM as primary;
`AI_TEXT_PROVIDER=minimax` restores the old behavior. Code supports all three.
