# Contact Discovery Engine

> How OutreachOS decides **who** to email at a target company — and how it keeps
> those people in the band that actually replies.

This document describes the contact-discovery subsystem: the problem it solves,
the architecture, the per-mode targeting model, the scoring math, and the
implementation phases. It is the canonical reference for `api/agents/contacts.ts`
and its supporting libraries (`seniority.ts`, `icp.ts`, `serper.ts`).

---

## 1. The problem

Cold outreach lives or dies on contact quality. The wrong person — too senior,
wrong function, wrong region — means no reply no matter how good the email is.

The first-generation pipeline produced an uneven mix. For a single enterprise
target it would surface, side by side:

| Surfaced contact | Verdict |
| --- | --- |
| Regional President | ❌ way too senior |
| Senior Director, Global Design & Standards | ❌ wrong function + too senior |
| Global Chief Marketing Officer | ❌ too high up |
| Director, Sponsors & Community Investment | ✅ good |
| Senior Vice President, Community | ⚠️ borderline (too senior) |
| Senior Community Investment Manager | ✅ good — the program owner |

The good ones are **program owners** (Manager–Director who run the thing and
feel the need). The bad ones are **executives** who will never reply to a cold
email and don't need to.

### Root causes (first-gen)

1. **The only mode-specific lever was a flat keyword blob.**
   `TITLE_HINTS_BY_MODE` injected `community OR marketing OR partnerships …`
   into one LinkedIn-scoped Google query. It biased *function* but did nothing
   about *level* — a "Global CMO" matches "marketing" and ranks fine.
2. **No seniority filtering existed anywhere.** The `seniority` field on
   `ContactDoc` was hardcoded `null`. Nothing could prefer a Manager over a
   President.
3. **Ranking was self-reported `confidence`** ("is this the right person"), not
   reply-likelihood. The prompt asked for *"decision-makers"*, which biases
   senior.
4. **No company-size adaptation.** At a 30-person startup the CMO *is* the right
   contact; at a 50,000-person bank you want the "Senior Community Investment
   Manager." `employeeCount` was never populated or used.
5. **Location was ignored.** `headquartersLocation` and contact `location`
   existed but were never populated or used.
6. **Identical shape for every mode** — only the keyword blob changed. There was
   no model of *who actually owns this and replies*, and nothing adapted to the
   specific mission or target.

---

## 2. The core idea: an Ideal Contact Profile (ICP-People)

The fix replaces the static keyword blob with an **adaptive, structured spec of
who to look for**, generated from the actual mission and adapted per target. It
drives all three stages: **query → filter → rank**.

```ts
ContactIcp {
  functions:           ["community investment", "corporate citizenship"]   // semantic targets
  functionKeywords:    [...expanded query synonyms...]
  seniority: {
    idealLevels:       ["manager", "senior_manager", "director"]
    maxLevel:          "director"          // hard cap (size-shifted per target)
  }
  disqualifierKeywords:["president", "chief", "global head", "vp"]          // hard excludes
  routerOk:            true                // is a gatekeeper/router acceptable?
  geo: { preferred: "Toronto, CA", scope: "country", strict: false }
  rationale:           "enterprise bank → program owners reply, execs don't"
}
```

This single object explains the bank example directly: at **enterprise** size the
band shifts down so "Senior Community Investment Manager" and "Director,
Community Investment" are *in-band*, while "Regional President" and "Global CMO"
are *above the cap* → dropped or penalized.

The ICP is:
- **Generated once per mission** by an LLM step seeded with a per-mode prior, and
  **cached on `MissionDoc.contactIcp`** so it is reused across targets.
- **Adapted per target deterministically** — the company-size tier shifts the
  seniority band, and the target HQ resolves the geo preference. No extra LLM
  call is spent where deterministic logic is correct and cheaper. (A per-target
  LLM refinement hook exists behind a flag for cases where the function set
  genuinely differs by target; it is off by default.)

---

## 3. Two deterministic primitives (`api/_lib/seniority.ts`)

Pure, no-API, fully unit-tested. This is where the "too high up" problem dies.

### 3.1 Seniority taxonomy + title parser

Every raw title is parsed into a normalized level with an integer rank:

```
ic 1 · senior_ic 2 · lead 3 · manager 4 · senior_manager 5 · director 6
senior_director 7 · vp 8 · svp 9 · cxo 10 · founder/president 11
```

`parseSeniority(title)` returns `{ level, rank, isRouter, scope }`:
- **scope qualifiers** — "**Global** CMO", "**Regional** President",
  "International", "Worldwide" — are detected and treated as seniority/scope
  amplifiers (a global director is less reachable than a local one).
- **routers** — "coordinator", "assistant", "executive assistant",
  "associate" — flagged so they're only used when `routerOk` is set.

This is what finally populates the `seniority`, `headline`, and `location`
fields that were always `null`.

### 3.2 Company-size → band shift

The acceptable band slides with company size — the missing piece behind the
complaint:

| Size tier | Headcount | Ideal band | Hard cap |
| --- | --- | --- | --- |
| `startup` | < 50 | director–founder | founder |
| `small` | 50–250 | manager–vp | vp |
| `mid` | 250–2,000 | manager–director | senior_director |
| `large` | 2,000–10,000 | manager–director | senior_director |
| `enterprise` | > 10,000 | manager–senior_manager | director\* |
| _unknown_ | — | manager–director | vp |

\* VP+ at an enterprise is only kept if `routerOk` **and** the pool would
otherwise be empty (then it's surfaced with a flag, never silently).

`employeeCount` is enriched on demand (§6) and cached on the target.

---

## 4. Discovery upgrade (`api/_lib/serper.ts`)

The single OR-blob query is replaced by **multiple ICP-driven queries per
target**, deduplicated by profile URL:

- function × seniority-keyword combinations, **with negative terms**:
  ```
  site:linkedin.com/in ("community investment" OR "corporate citizenship")
      (manager OR director) "RBC" -president -chief -CMO
  ```
- a **geo variant** when geo is set, appending the location term.

Each organic result's title/snippet is parsed by `seniority.ts` to fill
`seniority`, `headline`, and `location` *before* ranking. `buildPeopleQuery`
(singular) is kept for backwards compatibility; `buildPeopleQueries` (plural) and
`searchPeoplePool` are the new entry points.

The LLM still does the final name/role/URL extraction over the merged result
set, but now under a system prompt that knows the ICP band and is told to honor
it and extract location.

---

## 5. Ranking = reply-likelihood, not self-confidence

The candidate pool is sorted by a **composite reply-likelihood score** in both
`resolvePoolWithBudget` (the email-resolution walk) and the pipeline's `best`
pick — replacing raw LLM order / raw `confidence`.

```
score = w_func · functionMatch
      + w_band · seniorityBandFit       // 1.0 in-band, decays outside
      + w_size · sizeRelativeFit        // penalizes above-cap-for-size
      + w_geo  · geoFit
      + w_conf · llmConfidence

hard-drop if: disqualified by keyword
           OR rank > size-shifted hard cap   (unless pool would be empty)
```

`scoreContact(...)` returns the score plus a **reasons[]** decision log
(why kept / why dropped / which band) so discovery is debuggable instead of
opaque. Default weights live in `seniority.ts` and are the single tuning surface;
§9 describes learning them from reply outcomes.

---

## 6. Company-size enrichment (`api/_lib/company-enrich.ts`)

`enrichCompanySize(name, domain)` resolves a headcount when one isn't on file:
- Serper `site:linkedin.com/company "Name"` → parse "10,001+ employees" /
  "1,001-5,000 employees" out of the snippet.
- Falls back to `null` (→ the *unknown* band) rather than guessing.

The result is cached onto `TargetDoc.employeeCount` so a re-run is free.

---

## 7. Per-mode targeting model

The ICP synthesizer is seeded with a per-mode **prior** encoding *who actually
replies*. The owner/manager band is always ranked first; executives are capped
relative to company size.

| Mode | Primary target (owner band) | Hard-exclude | Notes |
| --- | --- | --- | --- |
| **Sponsorship** | Community / DevRel / brand-partnerships **manager–director**; sponsorship & events leads; program managers | CMO, President, "Global Head" | routers (event leads) OK |
| **BD / Partnerships** | Partnerships / alliances / ecosystem **manager–director**; "BD lead" | Chief Partnership Officer at large cos | |
| **Internship** | Hiring manager / team lead of the relevant team + technical recruiters + ICs on the team (warm intro) | VP+ | IC + manager bands |
| **Recruiting** | **ICs & team leads at the target company in the relevant function/level — the people you'd hire** | execs, in-house recruiters | candidate-sourcing model; see below |
| **Sales** | The **champion** who feels the pain (manager/director of the affected function); economic buyer secondary | — | size-relative |

### Recruiting — the design decision

Recruiting is defined as **candidate sourcing**: the contact is a *person you'd
hire* (IC / lead at the relevant level), found at the target companies (a
poaching model that fits the existing company → people pipeline). This makes it
genuinely distinct from Internship.

Open caveat, flagged for a later phase: the Evidence step currently builds
*company* evidence, which is the wrong anchor for emailing a candidate. A
**person-level evidence path for recruiting is Phase 3**. The prior is written so
that flipping recruiting to "sell a recruiting service to hiring managers" is a
one-line change if that's what's wanted instead.

---

## 8. The adaptive / confirmation step (`api/_lib/icp.ts`)

`synthesizeContactIcp(mission, prior)` — one LLM call per mission that turns
`mode + goal + offerDetails + targetDescription + geo` into a `ContactIcp`,
seeded by the per-mode prior. Cached on the mission. This is what makes discovery
*adapt* instead of running a frozen keyword list:

- a "women-in-tech hackathon" sponsorship pulls D&I / community leads;
- an "AI-infra conference" sponsorship pulls DevRel / ecosystem leads.

`defaultContactIcp(mode)` provides a deterministic fallback (the raw prior, no
LLM) so the pipeline never hard-depends on the synthesis call succeeding.

---

## 9. Long-term infrastructure (the compounding part)

- **Decision log per contact** — score components + the kept/dropped reason are
  persisted on the run, so a bad pick is explainable.
- **Outcome-weighted ranking** — `outcomes.ts` already tracks replies. A later
  phase learns the `w_*` weights per mode/size from who actually replied. The
  engine improves with use rather than staying frozen at hand-tuned weights.

---

## 10. Implementation phases

- **Phase 1 — kills "too high up" immediately, zero added LLM cost.**
  `seniority.ts` (parser + size-relative banding + composite scoring) +
  multi-query builder with negative terms + populate `seniority`/`headline`/
  `location` + sort the pool by score. Reuses the existing `*.test.ts` harness.
- **Phase 2 — adaptive + geo.** `icp.ts` synthesizer cached on the mission;
  per-mode priors; mission `geo` field + UI input; size enrichment.
- **Phase 3 — compounding.** Per-target LLM ICP refinement (flagged), outcome-
  driven weight learning, recruiting person-first evidence path.

### Files

| File | Change |
| --- | --- |
| `api/_lib/seniority.ts` | **new** — taxonomy, parser, banding, scoring |
| `api/_lib/icp.ts` | **new** — ICP synthesizer, per-mode priors, default |
| `api/_lib/serper.ts` | multi-query builder + dedup pool |
| `api/_lib/company-enrich.ts` | `enrichCompanySize` |
| `api/_lib/prompts.ts` | per-mode priors, ICP + serp system prompts |
| `api/agents/contacts.ts` | wire ICP → discover → parse → score → rank |
| `shared/schemas.ts` | `MissionDoc.geo`, `MissionDoc.contactIcp` |
| `shared/types.ts` | `SeniorityLevel`, `SizeTier`, `ContactIcp`, `Mission.geo` |
| `src/pages/MissionNew.tsx` | optional "Location focus" input |

### Testing

`seniority.test.ts` (parser/banding/scoring against the real bank titles),
`icp.test.ts` (priors + default + prompt build), extended `serper.test.ts`
(multi-query + dedup) and `contacts.test.ts` (scoring/filter integration). All
run under `node --test` like the existing suite.
