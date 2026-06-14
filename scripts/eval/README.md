# Eval harness

Makes "is it slop?" measurable. Runs the real personalization engine
(`api/_lib/engine.ts`) over hand-authored fixtures and scores each draft.

```bash
npm run eval                      # score fixtures, diff aggregate vs baseline.json
npm run eval -- --update-baseline # write current aggregate as the new baseline
```

**Needs live Vertex (Gemini) credentials** - the engine makes real generate +
critique calls. Without creds it fails fast with guidance.

## What it measures (pure scorers in `api/_lib/eval-scorers.ts`, unit-tested)

- **groundingRate** - fraction of claims attributed to a real allowed fact. The
  anti-fabrication signal. Anything < 1 means the model asserted something it
  couldn't support.
- **slopFlags** - count of `banned_phrase` / `slop` / `voice_mismatch` violations.
- **constraintPass** - body within the fixture's word bounds.
- **voiceMatchScore** - the judge's 0–1 voice match vs the exemplars.
- **pass** - no blocking violations.

`scorecard.latest.json` is written each run (git-ignored). `baseline.json` is
committed; the run exits non-zero if any aggregate metric regresses past the
epsilon in `diffAggregate`.

## Adding fixtures

Edit `fixtures.ts`. Each fixture is a fully-assembled `AssembledContext` + tier.
Cover the failure modes you care about: rich facts (grounding), strong voice
(imitation), banned-phrase traps, and thin-facts (does it avoid fabricating?).
