// Eval harness - runs the real engine over the fixtures and scores the output,
// so "is it slop?" is measured, not vibed. Emits a scorecard JSON and diffs the
// aggregate against the committed baseline to catch regressions when prompts or
// the pipeline change.
//
// Run with:  npm run eval                    (score + diff vs baseline)
//            npm run eval -- --update-baseline   (write current as the new baseline)
//
// Requires live Vertex (Gemini) creds - the engine makes real generate/critique
// calls. Without creds it fails fast with guidance.

/* eslint-disable no-console */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runDraftEngine } from '../../api/_lib/engine';
import { scoreDraft, aggregate, diffAggregate, type Scorecard, type Aggregate } from '../../api/_lib/eval-scorers';
import { FIXTURES } from './fixtures';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, 'baseline.json');
const LATEST_PATH = join(HERE, 'scorecard.latest.json');
const UPDATE_BASELINE = process.argv.includes('--update-baseline');

const DEFAULT_MIN = 20;
const DEFAULT_MAX = 120;

async function main() {
  const rows: Array<{ name: string } & Scorecard> = [];

  for (const fx of FIXTURES) {
    process.stdout.write(`· ${fx.name} … `);
    const result = await runDraftEngine(fx.ctx, fx.tier);
    const bodyWordCount = result.draft.body.trim().split(/\s+/).filter(Boolean).length;
    const card = scoreDraft({
      allowedFactIds: fx.ctx.allowedFacts.map((f) => f.id),
      claims: result.draft.claims,
      violations: result.violations,
      voiceMatchScore: result.voiceMatchScore,
      bodyWordCount,
      minWords: fx.ctx.minWords ?? DEFAULT_MIN,
      maxWords: fx.ctx.maxWords ?? DEFAULT_MAX,
      pass: result.pass,
    });
    rows.push({ name: fx.name, ...card });
    console.log(
      `grounding ${(card.groundingRate * 100).toFixed(0)}% · slop ${card.slopFlags} · voice ${card.voiceMatchScore.toFixed(2)} · ${card.pass ? 'PASS' : 'FAIL'}`
    );
  }

  const agg = aggregate(rows);
  const scorecard = { generatedAt: new Date().toISOString(), aggregate: agg, fixtures: rows };
  writeFileSync(LATEST_PATH, JSON.stringify(scorecard, null, 2));
  console.log(`\nAggregate:`, agg);

  if (UPDATE_BASELINE) {
    writeFileSync(BASELINE_PATH, JSON.stringify({ aggregate: agg }, null, 2));
    console.log(`\nBaseline updated → ${BASELINE_PATH}`);
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.log(`\nNo baseline yet. Run \`npm run eval -- --update-baseline\` to commit one.`);
    return;
  }

  const baseline: Aggregate = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).aggregate;
  const regressions = diffAggregate(baseline, agg);
  if (regressions.length === 0) {
    console.log('\n✓ No regressions vs baseline.');
  } else {
    console.error('\n✗ Regressions vs baseline:');
    for (const r of regressions) console.error(`  - ${r}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nEval failed to run.');
  console.error(err instanceof Error ? err.message : err);
  console.error('\nThe engine needs live Vertex (Gemini) credentials. Set up GCP auth and re-run.');
  process.exit(1);
});
