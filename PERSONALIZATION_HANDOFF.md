# Personalization Engine — Handoff

> **Purpose:** everything needed to continue this work seamlessly in a new chat —
> the vision, the approved plan, what's built & verified, what's left, and the
> refined onboarding spec. Read this top-to-bottom and you have full context.

**Branch:** `personalization-engine` (off `main`). Foundation commit: `90d8d64`.
`main` is untouched. **Stack: Gemini on Vertex AI, NOT Claude** (the skill examples
are Claude; ignore them for codegen). Models: `gemini-2.5-flash` (cheap),
`gemini-2.5-pro` (quality drafts), `gemini-embedding-001` (1024-d). MongoDB Atlas
+ Firebase auth + Cloud Run.

---

## 1. The thesis

OutreachOS's differentiation is **personalization that doesn't read as AI slop.**
Today's LLM layer does the opposite: freeform profile fields stuffed into one
prompt (the "diff prompt" we're avoiding), single-shot on the *cheapest* model,
regex-scraped JSON, one global profile, and the richest taste signal (human edits
before send) is discarded.

The fix is a **taste layer**: a structured, versioned, confidence-weighted
persona the engine *reads* at generation and the learning loop *writes* — voice
carried by **exemplars (few-shot), not adjectives** — plus a **grounded
generate→verify→revise engine** that attacks slop at its three sources:
fabrication, generic regression-to-mean, and unverified output.

## 2. Confirmed product decisions

From the planning Q&A (all four chosen as recommended):
1. **Layered persona data** — shared person-level identity/proof (entered once),
   per-persona voice/offer/exemplars on top.
2. **Tiered anti-slop** — full generate→verify→revise loop in onboarding; on the
   bulk pipeline a single critique pass that revises only if a `block` fires.
3. **Full phased build** — Phase 1 foundation → Phase 2 onboarding flow →
   Phase 3 learning loop.
4. **Exemplar + conservative rules** calibration — the confirmed draft becomes a
   gold exemplar; explicit chat instructions become rules; one draft never
   overwrites high-confidence dimensions.

Plus the **refined onboarding/ME spec** in §6 (latest, authoritative).

---

## 3. The approved plan (architecture)

```
ContextBank (atomic facts, person + persona)  ─┐
StyleProfile (structured voice/taste, versioned)├─► ENGINE: assemble → generate(grounded) → verify → revise
StyleExemplars (gold emails, retrieval)        ─┘         │
                                                          ▼
                            PERSONA (reusable voice) ◄── learning loop (edit-deltas, chat instructions, replies)
                                  ▲
                            selected/created at MissionNew (or in ME tab) → drives every draft in the mission
```

The principle that makes it "memory, not a diff prompt": the **StyleProfile is
structured + versioned + confidence-weighted**, injected as message *data after*
a cached static prefix. Engine reads it; learning loop writes it.

> **STATUS (full plan now implemented in code).** All three phases are built and
> compile clean (`server:typecheck` baseline-only noise, frontend tsc clean,
> `npm test` 105 pass / 2 env-skip, `npm run build` green). What still needs the
> **cloud** to verify at runtime (live Vertex + Atlas + the app): the LLM stages,
> the migration, the eval scores, and the onboarding/calibration UX. See §9.

### Phase 1 — LLM foundation  ✅ DONE (see §4)
- 1a Gemini adapter upgrade (structured output, model tiering, caching passthrough).
- 1b Layered persona data model + indexes.
- 1c Grounded generation engine (assemble → generate → verify → revise) — now the
  **live pipeline path** (`sequence.ts` drafts the initial email through
  `runDraftEngine`, keeps follow-ups). Deterministic verifier reuses the shared
  `deliverability.ts` checks + a CTA heuristic. Full observe-telemetry
  (`fact_ids`/`exemplar_ids`/`claims`/`violations`/`persona_version`) on `agent_runs`.
- 1d Eval harness ✅ — `npm run eval` (`scripts/eval/`), pure scorers in
  `api/_lib/eval-scorers.ts` (unit-tested), baseline diff.

### Phase 2 — Taste onboarding flow  ✅ DONE (full spec in §6)
- Agents: `api/agents/onboard-questions.ts`, `refine.ts` (span + structural),
  `extract-style.ts` (calibration → confidence-weighted StyleProfile + PersonaVersion).
- Persona **gate in `MissionNew`** (mandatory: a mission can't be created without a
  persona; `persona_id` wired). ME tab gains a **Voice** tab (`src/pages/me/PersonaStudio.tsx`):
  substance/exemplars/clarify/calibrate (write → chat-refine → confirm) + the
  "your voice" legibility surface. (Calibration here is contact-free; the same
  refine canvas is intended for reuse on real drafts in `MissionPage`.)

### Phase 3 — Runtime learning loop  ✅ DONE
- Edit-delta capture (keystone): `originalSubject`/`originalBody` on the sequence,
  `draftSubject`/`draftBody` on `sent_messages` (captured at send); `saveTouch`
  preserves the original.
- Confidence-weighted merge (`api/_lib/style-merge.ts`, unit-tested) + PersonaVersion
  snapshots in `extract-style.ts`.
- Pipeline integration done via 1c (engine is the live draft path).
- Reply→outcome stats: `api/_lib/outcomes.ts` credits per-`ContextFact.replyStats`
  + per-exemplar `outcome` using engine telemetry, wired into `reply.ts` (replied)
  and `gmail/send.ts` (sent).
- "Your voice" legibility surface — in the ME → Voice tab.
- **Not done (deliberate):** Vertex `CachedContent` *create* helper (the
  `cachedContent` passthrough exists; wiring a real cached prefix is a perf
  optimization left for when cost is measured).

---

## 4. What's built & verified (Phase 1, commit `90d8d64`)

All verified by `npm run server:typecheck` (clean except **pre-existing**
`stripe`×2 + `server/index.ts`×28 errors — not ours) and `npm test` (**85/85
pass**).

| Area | File(s) | What |
|---|---|---|
| **Adapter** | `api/_lib/llm.ts` (renamed from `anthropic.ts`; 9 importers updated, old file deleted) | `responseJsonSchema`/`responseMimeType` structured output; `MODEL()` flash / `MODEL_PRO()` pro tiers; `temperature` + `cachedContent` passthrough; `generateJson<T>()` helper; kept `createMessageWithRetry`/`extractJson`/`WEB_SEARCH_TOOL`. |
| **Env** | `api/_lib/env.ts` | Added `GEMINI_PRO_MODEL` (default `gemini-2.5-pro`). |
| **Data model** | `shared/schemas.ts` | `StyleProfile`/`StyleDimension`/`emptyStyleProfile()`, `PersonaDoc`, `PersonaVersionDoc`, `ContextFactDoc`, `StyleExemplarDoc`; `personaId` on `MissionDoc`; `INDEX_SPEC` for 4 new collections; `style_exemplar_vector_idx` + `context_fact_vector_idx` vector indexes. |
| **Collections/ownership** | `api/_lib/db.ts` | Added `personas`/`personaVersions`/`contextFacts`/`styleExemplars` to `COL` (auto-allowlisted in `api/data/router.ts`) and `OWNERSHIP` (all `userId`). |
| **Engine** | `api/_lib/engine.ts` | Grounding contract (`allowedFacts` + per-claim `factId` attribution), `DRAFT_SCHEMA`/`CRITIQUE_SCHEMA`, frozen `DRAFT_SYSTEM`/`CRITIQUE_SYSTEM`, pure `buildDraftUserPrompt` + `verifyDraftDeterministic` + `hasBlocker`, LLM stages `generateDraft`(pro)/`critiqueDraft`(flash)/revise, `runDraftEngine(ctx, tier)` tiered loop. |
| **Engine tests** | `api/_lib/engine.test.ts` | 6 tests on the deterministic verifier: grounded draft passes; unknown `factId` → fabrication block; empty/"none" `factId` → block; banned phrase → block (case-insensitive); over-length → warn not block; no-claims → no block. |

**Deliberately NOT done in Phase 1** (folded into Phase 2/3 where they're exercised):
the HTTP `draft.ts`/`critique.ts` handlers, DB assembly + vector retrieval of
exemplars/facts into an `AssembledContext`, and `runs.ts` telemetry wiring.

### Key code contracts to know
- **`AssembledContext`** (engine.ts) is the engine's input — the caller (a draft
  agent) does all DB/retrieval and hands in `{ mode, recipient, missionGoal,
  audience, whyNow?, allowedFacts[], exemplars[], styleProfile, maxWords?,
  minWords? }`. Engine stays pure of DB/HTTP → testable.
- **Grounding contract:** generation returns `claims: [{text, factId}]`; the
  deterministic verifier blocks any claim whose `factId` isn't in `allowedFacts`
  (empty/"none" too). This is the anti-fabrication core.
- **Tiering:** `runDraftEngine(ctx, 'onboarding')` ≤2 revises; `'bulk'` revises
  once only on a `block`.

---

## 5. What's left (in depth)

### Task 3 — Persona migration  ✅ WRITTEN (needs live Atlas to RUN)
`scripts/migrate-personas.ts` + `npm run migrate:personas` (supports `-- --dry-run`).
For each `profiles` doc: create a default `PersonaDoc` (voiceSummary seeded from
`writingTone`) if the user has none; convert freeform `proofPoints`/`achievements`
/`metrics` → `ContextFactDoc(scope:'person')` (one atomic claim per line, bullet/
number markers stripped); `exampleEmails` → `StyleExemplarDoc` (`source:
'user-provided'`, split on `---` lines); backfill `missions.personaId`. Idempotent
+ non-destructive: per-user guards key off "does the user already have any persona
/ fact / exemplar" so re-runs never duplicate or clobber. **Facts/exemplars are
written WITHOUT embeddings** (offline script, no Vertex) — the draft engine falls
back to recency; a later embedding-backfill enables vector retrieval. Still needs
a live Atlas to run/verify, then re-run `npm run mongo:init` on the cluster to
create the new indexes + vector indexes.

### Task 4 — Draft agent  ✅ DONE (needs live Vertex+Atlas to RUN end-to-end)
`api/agents/draft.ts` — the HTTP entry to the engine. Loads contact→target→
mission→persona, assembles `AssembledContext` (allowedFacts = relevance-ranked
context facts via `context_fact_vector_idx` + latest evidence-pack bullets, with
recency fallback; exemplars via `style_exemplar_vector_idx` with recency fallback;
styleProfile from the persona), then `runDraftEngine(ctx, tier)`. Body: `{ contact_id,
tier? }` (`tier` defaults `'bulk'`; `'onboarding'` for the interactive calibration
draft). Wired in `server/index.ts` (`POST /api/agents/draft`) + `agents.draft()` in
`src/lib/api.ts`. `'draft'` added to `AgentRunDoc.agentType`. Legacy missions with
`personaId:null` fall back to the user's default persona (or `emptyStyleProfile()`).

### Task 5 — Eval harness  (`scripts/eval/`, `npm run eval`)
Fixtures (`persona × mission × contact × evidence`) → run `runDraftEngine` →
scorers: grounding % (claims with valid supported `factId`), slop-flag count,
`voiceMatchScore` (judge + cosine of draft↔exemplar centroid), constraint pass.
Emit scorecard JSON; diff vs a committed baseline to catch regressions.
**Needs live Vertex.** This is how "is it slop" stops being vibes.

### Task 6 — Taste onboarding flow + agents  → **see §6 for the authoritative spec**
New agents (all Gemini `responseJsonSchema`): `api/agents/onboard-questions.ts`,
`api/agents/refine.ts` (span + structural rewrite), `api/agents/extract-style.ts`
(calibration → StyleProfile deltas). `api/agents/draft.ts` (the HTTP draft
handler) is **already built** — see Task 4; onboarding Stage 4 calls it with
`tier:'onboarding'`. Add the new agent endpoints to `src/lib/api.ts`. UI: persona
selector/gate in
`src/pages/MissionNew.tsx`; the ME tab (`src/pages/Me.tsx` + `me/Workshop.tsx`)
becomes the taste-onboarding home; Stage 4 canvas+chatbox component.

### Task 7 — Learning loop + pipeline integration
- **Edit-delta capture (keystone, do early):** persist the original AI draft
  immutably (`originalSubject`/`originalBody` on the sequence) + store both
  `draftBody`+`finalBody` on `sent_messages`; fix `saveTouch` in
  `src/pages/MissionPage.tsx` so it stops overwriting the original.
- Reuse the Stage-4 canvas/chat-refine on real drafts in `MissionPage`.
- `extract-style` consumes edit-deltas + chat instructions + flag accept/dismiss
  → StyleProfile deltas → **confidence-weighted merge** (never overwrite a
  high-confidence dimension with one noisy sample) → `PersonaVersionDoc` snapshot.
- Wire engine into `api/_lib/pipeline.ts` executors (persona-aware, tiered
  critique, Vertex context caching for the per-mission static prefix).
- Generalize `coach.ts`'s reply-rate join to per-`ContextFact`/per-exemplar
  (`replyStats`, `outcome:'replied'`).
- "Your voice" legibility surface (StyleProfile + exemplars + per-dim confidence
  + reply stats).

### Task 8 — Verification
Unit tests (claim-attribution already done; add banned-phrase edge cases,
confidence-merge math, migration). Commit eval baseline. Keep
`server:typecheck` + `npm test` + `npm run build` green.

---

## 6. Taste onboarding — authoritative spec (latest)

> This refines/supersedes the earlier Phase-2 outline. It is the design to build.

**ME section becomes the "Taste onboarding process."**
- Editable **any time** in the ME tab.
- The **context dump is a separate section** from the onboarding-process section.
- **Personas:** start with just the **default**; users can **add more** if they
  want — this supports different use cases (sponsorship vs recruiting vs sales).
- The taste onboarding can be filled out anytime in ME, but is **made mandatory
  in mission creation for sending emails.**

**Step-by-step onboarding process:**

1. **Frame** — choose persona / mode.
2. **Substance / who you are** — resume, links → populate **context facts**.
   - Supports **file dump, voice dump,** etc.
   - This step is **saved into the overall (person-level) profile**; within the
     step the user can **import the previous directly.**
   - Why it reappears here (vs the ME section): (1) in case they didn't fill it
     out, (2) they're using it for a different purpose — so they can **import
     from the ME section and optionally add on, or do it from scratch.**
   - This step is purely about **understanding who they are.**
3. **Ask clarifying questions** (adaptive, LLM-generated from gaps/contradictions).
4. **Style** — exemplar emails; maybe a few questions about tone, etc.
5. **Feedback (calibrate a real draft)** — the engine generates **one full draft**.
   - **Canvas UI with a chatbox on the side.**
   - The user can: **highlight a part and tell it to rewrite that specific part**,
     **generate entirely from the chatbox**, or **edit freely** themselves.
   - **All preferences/actions are tracked and learned (anti-slop).** Every
     interaction is logged as **calibration signal**; the **anti-slop verifier
     runs and surfaces flags inline.**
   - Stored in memory → **builds the "taste persona" over time.**
   - *Future:* swipe left/right (good draft / bad draft, each followed by a "why"
     for further calibration and taste profiling).
6. **Confirm and commit** —
   - Save the **gold-standard exemplar.**
   - **Derive conservative rules** from what the user put in the chatbox
     (e.g. "make it less formal").
   - The **persona is reusable in subsequent missions.**

**Mapping to the code/data model:**
- Person-level substance → `ContextFactDoc(scope:'person')` (+ resume via existing
  `parse-resume.ts`/`profile_assets`; voice dump → facts with
  `provenance:'dictation'` — **context only, not style**).
- Persona-level voice → `PersonaDoc.styleProfile` (+ persona-scoped facts).
- Exemplars → `StyleExemplarDoc` (`source:'user-provided'` then
  `'stage4-confirmed'`, later `'earned-winner'`).
- Stage-4 calibration → `refine.ts` (span/structural rewrite) + `extract-style.ts`
  (chat instructions → conservative `StyleProfile.rules`) + `PersonaVersionDoc`.
- The Stage-4 canvas reuses on real drafts in `MissionPage` (Phase 3).

---

## 7. Verification & gotchas

```bash
npm run server:typecheck   # types (server). Baseline noise: stripe x2 + server/index.ts x28 (PRE-EXISTING).
npm test                   # tsx node:test. Currently 85/85 pass.
npm run build              # vite frontend build.
npm run mongo:init         # creates collections + indexes + vector indexes (run after schema changes).
```

- **Cannot verify end-to-end in this environment** — the LLM stages, migration,
  eval, and pipeline need live **Vertex (Gemini)**, **MongoDB Atlas**, and the
  running app. Build to compile + unit-test pure logic; "it works" needs cloud creds.
- **Pre-existing typecheck errors are not ours:** `api/billing/{stripe,webhook}.ts`
  (can't resolve `stripe` types) and `server/index.ts` (duplicate `@types/express`
  in `server/node_modules`). Don't chase these.
- **Gemini structured output:** schemas must be **flat** (no recursion); use
  `responseJsonSchema` (raw JSON Schema) — confirmed supported in `@google/genai`
  2.8. Don't combine `responseJsonSchema` with `tools` (web search) — mutually
  exclusive (llm.ts enforces this).
- **Reply visibility:** Gmail is send-only scope today → the app can't see most
  replies, so the reply-based signal is weak. Lean on edit-deltas + chat
  calibration as the primary learning signal (replies are a bonus).
- **Frontend uses a Supabase-shaped shim** (`src/lib/db.ts` + the `supabase`
  import) over the Mongo `/api/data` router; camelCase↔snake_case conversion is in
  `src/lib/api.ts`. New collections are already allowlisted via `COL`.

---

## 8. Continue from here

1. `git checkout personalization-engine`
2. Recommended next slice: **Task 3 (migration) + `api/agents/draft.ts`** (assemble
   `AssembledContext` from DB + vector retrieval, call `runDraftEngine`) → makes
   the engine runnable end-to-end and unblocks both onboarding (§6) and pipeline
   wiring. Then the ME-tab taste-onboarding UI (largest chunk; verify with the app
   running).
3. Keep `server:typecheck` + `npm test` green after each step.
