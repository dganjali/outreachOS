# UI / UX Feedback — Tracking Checklist

Source: user walkthrough (2026-06-25). Ordered by priority. Check items off as completed.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## P0 — Lead complaint + trust-breaking data bugs

- [x] **1. Redesign the "AI Assist" panel.** ✅ Rebuilt dark-correct: emerald-tinted dark card (was a glaring light box from `--accent-softer`), legible emerald header (was invalid `color: var(--accent)`), clean chip pills, proper emerald "Rewrite" CTA, fixed locked-variant tokens. Verified via screenshot on `/feedback-preview`. _(src/index.css ~2209, src/pages/MissionPage.tsx)_
- [x] **2. Draft count mismatch.** ✅ Root cause: `sequence.ts` did `insertOne` with a fresh id every time and never cleared the prior draft, so re-running the pipeline/autopilot stacked duplicate `email_sequences` rows — the list/dashboard counted raw rows while the header deduped by contact. Fixed both sides: (a) sequence regenerate now replaces the prior *unsent* draft (guarded so scheduled/sent history is never deleted) — also stops autopilot double-drafting; (b) Missions list + Dashboard now count *distinct contacts*, so counts agree even on pre-existing duplicate data. Typechecks clean. _(api/agents/sequence.ts, Missions.tsx, Dashboard.tsx)_
- [x] **3. Mission header "contacts" count.** ✅ Verified already correct — header uses `totalContacts = allContacts.length` where contacts are batch-loaded for ALL target ids (MissionPage.tsx:158), not just the expanded target. The "4" the user saw was genuinely mission-wide (only Moonvalley had contacts at the time). No change needed. _(MissionPage.tsx)_

## P1 — High-friction UX bugs (everyday flows)

- [x] **4. Editable mission brief (incl. notes field).** ✅ New `MissionBriefCard` with view/edit modes: Offer, Audience, Location, and a new private **Notes** field (e.g. "paused until August") are all editable inline via an "Edit" affordance (top-right of the brief card), saved back to the mission. Added `notes` to schema + frontend type (no migration needed — schemaless + passthrough PATCH). Typechecks clean. _(covers "Offer/Audience read-only", "no inline editing of brief", and #13 "no notes field")_ _(MissionPage.tsx, index.css, shared/schemas.ts, src/types.ts)_
- [x] **5. New-mission "Next" button.** ✅ Now stays clickable; clicking with blanks reveals inline per-field errors (danger border + message under each of name/offer/audience) and keeps you on step 1. Button reads as not-ready via `aria-disabled` styling. Verified in browser. _(MissionNew.tsx, index.css)_
- [x] **6. New-mission Cancel control.** ✅ Added an explicit "Cancel" button (footer-left on step 1) that returns to /missions; steps 2–3 keep "Back". Verified in DOM. _(MissionNew.tsx)_
- [x] **7. Draft edit mode hijacks the viewport.** ✅ Edit mode now has a **pinned top toolbar** ("Editing draft" + Cancel + emerald Save changes) that stays above the fold while the form scrolls; reduced the body textarea from 9→6 rows. Also fixed invalid `--accent` focus rings on the reply inputs (now a visible emerald ring). Verified via preview. _(MissionPage.tsx, index.css)_
- [x] **8. "Send email" / no verified address.** ✅ The amber box now has a clear label, an input + **"Save to contact"** button (persists the address so it's reused, vs. one-off send), and helper text spelling out the difference. New `onContactUpdated` refreshes the parent. Verified via preview. _(MissionPage.tsx, index.css)_
- [x] **9. Status dropdown misclick.** ✅ Added a "Status" label + a vertical divider separating the dropdown from the × remove (× now hovers danger-colored), and an **Undo toast** on every status change (key for 'rejected', which hides the target). Verified via preview. _(MissionPage.tsx, index.css)_

## P2 — Feature gaps

- [x] **10. Follow-up sequence visibility.** ✅ Closed both gaps. (a) **Async generating state**: opening a freshly-drafted card now shows a "Writing follow-ups…" spinner and **polls** the row every 4s (recency-gated to drafts <3min old, caps at ~48s) so follow-ups appear automatically — no manual reload. Updates local draft + refreshes the parent map via a new `onSequenceUpdated`. (b) **Per-follow-up skip toggle**: each follow-up has a Skip/Include control; skipped touches dim + tag "skipped" and disable Send/Schedule/Save-to-Gmail (Edit/Copy stay live), with a `disabled` flag persisted on `followups[]`. Backend `scheduleFollowups` honors it — skipped touches are never auto-queued by the cron, while remaining touches keep their original send dates (cumulative cadence still advances) and positional `touchIndex`. Typechecks + build clean; new unit tests cover the skip enforcement. _(MissionPage.tsx, index.css, api/_lib/sequencing.ts + sequencing.test.ts, shared/schemas.ts, shared/types.ts)_
- [x] **11. Contact-level activity log.** ✅ Each contact now has a collapsible **Activity** timeline synthesized from real timestamps we already store — discovery (+ source), draft written, every initial/follow-up email *sent* or *scheduled* (with subject), failures/bounces, and inbound *replies* — sorted chronologically with color-coded dots. Batched into two extra requests (`sent_messages` + `replies` for all mission contacts). Status-change events are intentionally omitted (we don't persist their timestamps); current status stays on the row. _(MissionPage.tsx `ContactActivity`, index.css)_
- [x] **12. Bulk actions on contacts.** ✅ Wired the (already-present) bulk handlers to UI: a select checkbox on every contact row (row highlights when picked) + a floating action bar showing the count with **Approve / Mark contacted / Reject / Clear**, each a single batched status update with one Undo toast restoring every prior status. _(MissionPage.tsx, index.css)_
- [x] **13. CSV import guidance.** ✅ Added a tooltip on the collapsed "Import CSV" button and a **"Download sample CSV"** link (generates a ready-to-edit template) alongside the existing column spec. _(CsvImport.tsx, index.css)_
- [x] **14. Voice rename-in-place.** ✅ Each voice card (ME → Personalization) now has a hover **rename pencil**; clicking swaps the card into a name input (Enter to save, Esc/blur to cancel) via `updatePersona`. No more diving into the Edit Voice drawer just to rename. Verified via preview. _(me/PersonaStudio.tsx, index.css)_

## P3 — Polish / nice-to-haves

- [x] **15. Dashboard skeleton loaders.** ✅ Upgraded the shared `<Skeleton>` from a faint pulse to a **shimmer sweep** (`.app-skeleton`, respects reduced-motion) and replaced the dashboard's 3 plain rects with **structured skeleton cards** that mimic a real mission card (title + status pill + progress + stat row). Verified via preview. _(ui/skeleton.tsx, Dashboard.tsx, index.css)_
- [x] **16. "N drafts to review" card names the missions.** ✅ The focus card now lists the mission names with pending drafts (e.g. "Find me a summer Internship · Q1 sponsorship") and links **straight to that mission** when only one has drafts. _(Dashboard.tsx)_
- [x] **17. Autopilot progress indicator.** ✅ Added a spinner next to the "Working on the first batch…" state and an always-on cadence line — "Last ran 12m ago · checks every 24h" (or "First run on the next cycle") — so users aren't flying blind. _(AutopilotPanel.tsx, index.css)_
- [x] **18. Confidence score tooltip.** ✅ Replaced the bare `title="Confidence"` with an explanatory tooltip: it's the estimated **reply-likelihood** (role/seniority fit + signals), per CONTACT_ENGINE.md §5. _(MissionPage.tsx)_
- [x] **19. Evidence pack tag colors.** ✅ Color-coded the signal pills by type (funding=green, hiring=blue, launch=purple, sponsorship=amber, partnership=teal, leadership=pink, press=indigo, talk=orange, …) via a `data-signal` attr; dark-correct hues. Verified via preview. _(MissionPage.tsx, index.css)_
- [x] **20. Keyboard shortcuts + `?` help overlay.** ✅ App-wide single-key shortcuts (guarded so they never fire while typing or with a modifier held): `n` new mission, `d` Dashboard, `m` Missions, `i` Inbox, plus `?` to toggle a help overlay (Esc to close) that documents them alongside the existing `/`-to-search. _(AppLayout.tsx)_
- [x] **21. Inbox unread count badge.** ✅ The Inbox nav item now shows a filled count badge (caps at "9+") when there are unhandled replies, polled every 60s + on window focus, on both desktop sidebar and mobile sheet. _(AppLayout.tsx)_

---

### Progress log
- _2026-06-25_: Created tracking doc, triaged 21 items into P0–P3.
- _2026-06-25_: Finished #10 — async follow-up "generating…" poll + per-follow-up skip toggle (UI + backend `scheduleFollowups` enforcement + unit tests).
- _2026-06-25_: Finished #11 (contact activity timeline), #12 (bulk contact actions UI), #20 (keyboard shortcuts + `?` help overlay). **All 21 items now complete.** Also shipped infra/perf nitpicks: external `/api/healthz`, gated the internal `*-preview` routes out of the prod build, and code-split Three.js/Firebase/React/Radix into separate chunks (app shell 537kB→42kB).
