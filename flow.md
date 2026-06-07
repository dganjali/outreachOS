# OutreachOS — User Flow & Screen States

The definitive map of every screen and every state we put in front of a user. Built to fix three problems with the current app: the **dashboard is a wall of zeros**, the **"running" experience is an opaque multi-minute spinner that feels forced**, and **progress is invisible**. This doc is the spec; build to it.

---

## Design principles (the north star)

1. **Mission in → pipeline out.** The whole product is one motion: say who you want to reach → watch the agent research and draft → review and send. Every screen serves that motion.
2. **Never a dead spinner.** If the system is working, the user sees *what* it's doing, *how far along* it is, and *what they'll get*. Opaque "Loading…" is banned anywhere work takes >1s.
3. **Stream partial results.** The user should be reading and approving finished targets while the rest are still cooking. Never make them wait for the whole batch.
4. **The user is never trapped.** Long work runs server-side; they can leave, close the tab, come back, and it's still going (or done). No work lives only in a browser tab.
5. **Honest, specific microcopy.** "Reading 3 sources on Acme's Series B" beats "Processing…". Real verbs, real nouns.
6. **Every state is designed.** Loading, empty, partial, error, rate-limited, success — each is a deliberate screen, not an afterthought.

---

## The journey (happy path)

```
 Landing ──▶ Sign up ──▶ (verify email) ──▶ Onboarding (4 steps) ──▶ Dashboard (first-run)
                                                                          │
                                                          "Start your first mission"
                                                                          ▼
                                                                   New Mission form
                                                                          │
                                                                   "Launch pipeline"
                                                                          ▼
                                          ┌──────────────  MISSION RUN (live progress)  ──────────────┐
                                          │  targets stream in → each researches → drafts appear live  │
                                          └───────────────────────────┬───────────────────────────────┘
                                                                       ▼
                                                       Mission Workspace (review & send)
                                                                       │
                                                  approve targets · edit drafts · Send / Save draft
                                                                       ▼
                                                                Gmail (sent) ──▶ Inbox (replies polled)
                                                                       │
                                                            classify reply · send follow-up
                                                                       ▼
                                                            Dashboard (now "active")
```

Side routes available from the left nav at all times: **Dashboard · Missions · Inbox · Me · Settings.**

---

## Global states & shared components

These appear across many screens — design once, reuse.

| Component | When | Behavior |
|---|---|---|
| **Skeleton loaders** | Any data fetch >300ms | Gray shimmer blocks in the shape of the content (cards, rows) — never a centered spinner on a blank page. |
| **Empty state** | A list/section has no data yet | Illustration + one-line explanation + the single next action. Never show a populated layout full of zeros. |
| **Agent-working chip** | A single agent run is in flight (evidence/contacts/draft) | Inline shimmer + live step label on the exact element being worked on (e.g. on the target card), not a global blocker. |
| **Toast** | Action result (save, send, error, copy) | Bottom-right, 3–4s, success/info/error variants. Already implemented (`ToastContext`). |
| **Error banner** | A fetch or action fails | Inline, red, with the human message + a **Retry** button. Never a silent failure. |
| **Rate-limit banner** | User hits 5/min or 50/day agent cap | Amber, shows remaining budget + when it resets + "Upgrade" CTA. (Currently invisible — see Mission Run.) |
| **Reconnect toast** | SSE stream drops mid-run | "Reconnecting…" → silently resumes; the run keeps going server-side regardless. |

---

## 1. Landing  `/`

**Purpose:** sell the outcome, get the click.

| State | What shows |
|---|---|
| Default (logged out) | Hero: "Cold outreach pipeline in one click." One real before/after example (mission → drafted email). Primary CTA **Get started** → Sign up. Secondary: Sign in. |
| Logged in | Auto-redirect to `/dashboard` (already handled by `PublicOnlyRoute`). |

---

## 2. Auth  `/sign-up` · `/sign-in` · `/forgot-password` · `/check-email`

| Screen | States |
|---|---|
| **Sign up** | default · submitting · field errors (weak password, email taken) · success → `/check-email` |
| **Sign in** | default · submitting · invalid creds error · "verify your email first" notice |
| **Forgot password** | default · submitting · "reset link sent" confirmation |
| **Check email** | "We sent a verification link to {email}" · **Resend** (with cooldown) · "I've verified → continue" |

Both email/password and Google sign-in. Keep these as-is; they work.

---

## 3. Onboarding  `/onboarding`  *(now 4 steps — templates step deleted)*

Goal: collect the *minimum* to make the first mission's drafts sound like the user, then get out of the way. Profile can always be deepened later in **Me**.

| Step | Asks | Notes |
|---|---|---|
| 1 | Name | required |
| 2 | Email (confirm) | read-only, from auth |
| 3 | Occupation / title | one line |
| 4 | LinkedIn URL + résumé URL (optional) | **Skip for now** allowed. On finish, kicks off background enrichment if a LinkedIn is present. |

**States:** per-step (entering / saving / error) · finishing (saving + optional "Enriching your profile from LinkedIn…") · done → redirect to **New Mission** (`/missions/new?welcome=1`).

**Key fix:** enrichment runs **non-blocking in the background** — the user is already on the New Mission screen while it finishes. It must resolve to a terminal state (don't leave it "running" forever — see Dashboard activity feed bug).

> Removed: the "Templates of successful emails you've drafted" step. It was friction at the worst moment (most users have nothing to paste). Example emails now live as an *optional* field in **Me → Workshop** for power users.

---

## 4. Dashboard  `/dashboard`  ⚠️ **REDESIGN**

The current dashboard shows six "0" KPIs and blank buttons to a brand-new user — it looks broken and says nothing. It has **two completely different jobs** depending on whether the user has ever run a mission. Split them.

### 4a. First-run dashboard (no missions yet)
Don't show the zero-grid. Show a focused launchpad:

```
┌────────────────────────────────────────────────────────┐
│  Welcome, Daniel 👋                                      │
│                                                          │
│   Let's land your first reply.                           │
│   Tell us who you want to reach — the agent finds the    │
│   companies, the people, the angle, and writes the       │
│   emails. You review and send.                           │
│                                                          │
│            ▸ Start your first mission                    │  ← single primary CTA
│                                                          │
│   ─ or ─                                                 │
│   • Connect Gmail (so you can send)   [setup pill]       │
│   • Sharpen your profile (Me)          [40% complete]    │
└────────────────────────────────────────────────────────┘
```
- **One** primary action. The two "or" items are setup nudges (Gmail + profile completeness) shown as small pills, not competing CTAs.
- A subtle "how it works" 3-step strip can sit below (Targets → Research → Drafts).

### 4b. Active dashboard (≥1 mission)
KPIs that drive action, not vanity zeros. Lead with what needs the user *now*:

| Tile | Meaning | Click |
|---|---|---|
| **Drafts to review** | sequences in `draft` not yet sent | → filtered mission view |
| **Replies to handle** | unhandled replies | → Inbox |
| **In flight** | targets currently being researched | → the running mission |
| **Sent** | total contacted | — |
| **Reply rate** | replied / contacted (only show once contacted > 0) | — |

Below: **Active missions** (each row = name, mode, progress bar "6/8 targets researched · 4 drafts", status) + **Recent activity** feed.

### Activity feed — fix the "stuck RUNNING" bug
The current feed shows `enrich_profile · RUNNING · 0s ago` and never updates. Rules:
- Every run row reflects a **terminal state** once done (completed/failed) — poll or stream until it resolves; never leave a phantom "running".
- Show friendly labels ("Enriched your profile", "Researched 8 targets for Q1 Sponsorship"), relative time, and status color.
- Failed runs get a **Retry**.

### Known bug to fix here
In the screenshot the **"Create Mission" / "Create your first mission" buttons render with no visible text** (solid green blocks). Likely a CSS color/contrast or missing-label issue on `.dashboard-create` — fix so the label is always visible.

---

## 5. Missions list  `/missions`

| State | Shows |
|---|---|
| Empty | Same launchpad CTA as first-run dashboard. |
| Populated | Card/row per mission: name, mode pill, progress (targets/contacts/drafts), last activity, status. **+ New mission.** |
| Loading | Skeleton rows. |

Each card → Mission Workspace. A mission mid-run shows a live "Researching… 4/8" progress chip and links into the Run view.

---

## 6. New Mission  `/missions/new`

Keep the current form (it's good — the placeholders teach users to write specific inputs). States: editing · validation errors · creating · created → **straight into Mission Run** (not back to a static page).

Fields: name · mode (5 cards) · offer · audience. On submit, create the mission and immediately **launch the pipeline + navigate to the Run view** (so "create" and "start" are one motion, not two clicks).

---

## 7. ⭐ Mission Run  `/missions/:id/run`  — **THE screen to get right**

This replaces the current "click Run full pipeline → global spinner for 10 minutes → results dump." It's the heart of the product and the thing that "feels forced" today.

### The model
A pipeline run is a sequence of phases the user can watch:
1. **Find targets** (1 agent call)
2. For each of the top N targets, in parallel-ish: **Evidence → Contacts → Draft**

Each unit has a status: `queued · running · done · failed`. The whole run has: `running · paused (rate-limit) · done · failed · canceled`.

### The screen

```
┌─────────────────────────────────────────────────────────────────────┐
│  Q1 Sponsorship Outreach                          ⏱ 2:14 · ~3 min left │
│  Researching your pipeline                         [ Run in background ]│
│  ████████████░░░░░░░░░░  9 of 18 steps                       [ Stop ]   │
├─────────────────────────────────────────────────────────────────────┤
│  ✅  Found 8 companies                                    ▾ (chips)     │
│                                                                        │
│  Acme Inc           ✅ Evidence   ⏳ Contacts   ··· Draft              │
│     └ "Reading 3 sources on Acme's Series B…"                          │
│  Globex            ✅ Evidence   ✅ Contacts   ✅ Draft   → Review     │ ← done, clickable now
│  Initech           ⏳ Evidence   ··· Contacts  ··· Draft              │
│  Umbrella          ··· queued                                          │
│  …                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  ⚠ Using 12 of your 50 daily agent runs.                               │
└─────────────────────────────────────────────────────────────────────┘
```

### Behaviors (every state)
- **Streaming:** rows update live as each step completes (SSE). Targets appear the moment targeting returns; each fills in Evidence → Contacts → Draft as they finish.
- **Results are usable immediately:** a target that reaches "Draft ✅" shows a **Review** link — the user can start reading/editing/sending finished ones while others run.
- **Run in background:** the run lives server-side. The user can navigate away or close the tab; a global "mission running" indicator (in the nav) lets them jump back. Returning re-attaches to the live stream (fetch history + tail — no lost events).
- **Per-step microcopy:** the running step shows what it's doing ("Finding decision-makers at Globex…", "Drafting with your proof points…").
- **Rate-limit (paused):** if the 5/min or 50/day cap hits mid-run, the run **pauses** with an amber banner ("Paused — you've used your 50 runs today. Resumes tomorrow, or upgrade for more."). Already-finished targets remain fully usable.
- **Partial failure:** a step that fails shows ⚠ + **Retry** on that target; the rest of the run continues. Never abort the whole run for one target.
- **Cancel (Stop):** confirms, halts queued work, keeps finished results.
- **Done:** header flips to a summary — "✅ 8 targets · 22 contacts · 8 drafts ready" + primary CTA **Review & send** → Mission Workspace. Time-elapsed shown.
- **Empty result:** if targeting finds nothing (rare), show "No strong matches for this audience — try broadening it" + edit-mission CTA.

### Loading / first paint
Skeleton of the phase list with "Starting…" — never a blank screen.

### Single-step runs (lighter variant)
When the user re-runs *one* thing from the Workspace ("Find more contacts", "Regenerate draft"), don't open the full Run view — show the **agent-working chip** inline on that card with its step label, and slot the result in when done.

> **Build dependency:** this experience requires moving pipeline orchestration **server-side with SSE** (a `POST /api/agents/pipeline` that streams progress + a `GET /api/missions/:id/run` to re-attach). Today it's client-orchestrated in `MissionPage.runFullPipeline()` and dies on tab close. The run-status model (phase + per-target step states) should persist on the mission so the feed/badges/re-attach all read from one source.

---

## 8. Mission Workspace  `/missions/:id`  (review & send)

Where the user turns research into sent emails. (This is today's MissionPage, cleaned up.)

| Region | States |
|---|---|
| **Header** | mission name, mode, live counts (targets/contacts/drafts/sent), **Run pipeline / Run more**, CSV import. If a run is active → shows the live progress chip linking to the Run view. |
| **Target list** | each target card: score, "why now", signal pills, status select (suggested/approved/rejected/contacted), evidence pack (collapsible), contacts, drafts. |
| **Target card states** | researching (chip) · researched · no-evidence (CTA "Build evidence") · approved · rejected (dimmed) · contacted. |
| **Contact row states** | found · has verified email (pill) · likely-pattern only · no email (prompt for override on send). |
| **Draft / sequence states** | none yet ("Draft email" — disabled until evidence exists, with reason tooltip) · drafting (chip) · drafted (initial + 2 follow-ups, each: copy / save as Gmail draft / send now) · sent (badge) · follow-up locked until initial sent (with reason). |
| **Send states** | idle · sending · sent ✅ · draft-created ✅ · needs-recipient-email (inline input) · gmail-not-connected (→ Settings CTA) · error (retry). |
| Empty | "No targets yet — run the pipeline." |

Improvement: add **inline draft editing** + **regenerate with a note** ("make it shorter", "lead with the metric") — today drafts are read-only.

---

## 9. Inbox  `/inbox`

| State | Shows |
|---|---|
| Loading | skeleton reply rows |
| Empty | "No replies yet. We check your sent threads every 15 min." (matches the actual cron now) |
| Populated | reply cards: sender, classification pill (interested/not-now/etc.), urgency, snippet, the original outreach (collapsible), recommended action, **suggested response** (copy / edit / send). Filters: Unhandled / All. |
| Reply states | unclassified ("Classify with AI") · classifying (chip) · classified · handled (dimmed) |
| Action states | mark handled/unhandled · copy suggested reply · (future) send reply inline |

Fix the copy: it currently says "every ~10 minutes" in one place — make it match the real cron cadence (15 min).

---

## 10. Me  `/me`  (profile workshop — already strong)

| Area | States |
|---|---|
| **Header** | completeness ring (%), subtitle. |
| **Tabs** | Workshop · History. |
| **Workshop** | per-field edit; **Coach** (AI rewrite drawer) per field: idle / generating / suggestions / applied; **enrich from LinkedIn**: idle / enriching / done; **asset upload** (résumé/portfolio): uploading / parsing (20–40s, with toast) / parsed → accept-into-profile modal / parse-error. |
| **History** | version snapshots list; restore (with confirm). Empty: "No versions yet." |
| Save states | saving · saved (toast) · error. |

Mostly keep. Just ensure every async action shows the working chip + resolves to success/error (no silent hangs).

---

## 11. Settings  `/settings`

| Section | States |
|---|---|
| **Gmail integration** | loading · not-connected (Connect Gmail) · redirecting · connected (email + status pill + Disconnect) · error (last_error shown) · flash from OAuth return (connected / failed). |
| **Account** | email (read-only). |
| **Password** | editing · mismatch error · too-short error · updating · updated (toast). |

Keep as-is; it's clean. (Once Gmail is connected, surface it as ✅ on the dashboard setup nudge.)

---

## Run / agent status model (so progress is consistent everywhere)

One source of truth, read by the Run view, the dashboard badges, the activity feed, and the mission cards:

```
agent_run / pipeline_run:
  status:  queued → running → (done | failed | paused | canceled)
  phase:   targeting | evidence | contacts | sequence
  targetId/contactId (for per-unit steps)
  progress: { completed, total }
  startedAt, completedAt, error
```

- The **activity feed** renders these and must show terminal states (fixes the stuck "RUNNING").
- The **nav** shows a global "1 mission running" pill when any run is active → click to re-attach.
- The **Run view** subscribes via SSE; on reconnect it fetches the run record + tails the stream (no lost steps).

---

## What to build first (so the flow is real, in order)

1. **Server-side pipeline + SSE** (`POST /api/agents/pipeline` streaming, persisted run-status model). Unlocks the Run view, background runs, and honest progress. *Biggest lever.*
2. **Mission Run screen** (§7) consuming that stream.
3. **Dashboard split** (§4): first-run launchpad vs active; fix blank buttons + stuck activity rows.
4. **New Mission → Run** as one motion (§6).
5. **Rate-limit surfacing** (banner + budget) everywhere agents run.
6. **Inline draft edit / regenerate** (§8) + fix Inbox cadence copy (§9).

Everything else (Me, Settings, Auth) is already in good shape — just make sure each async action shows a working state and resolves.
