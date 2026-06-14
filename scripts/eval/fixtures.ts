// Eval fixtures — persona × mission × contact × evidence, fully assembled into
// engine contexts. These are hand-authored "golden" scenarios; the harness runs
// the real engine on them and scores grounding/slop/voice/constraints.
//
// Add fixtures that stress the anti-slop core: rich allowed-facts (can it stay
// grounded?), a strong voice (does it imitate the exemplar?), a banned-phrase
// trap, and a thin-facts case (does it avoid fabricating?).

import type { AssembledContext, EngineTier } from '../../api/_lib/engine';

export interface Fixture {
  name: string;
  tier: EngineTier;
  ctx: AssembledContext;
}

export const FIXTURES: Fixture[] = [
  {
    name: 'sponsorship-strong-voice',
    tier: 'bulk',
    ctx: {
      mode: 'sponsorship',
      recipient: { name: 'Dana Lee', role: 'Head of Developer Marketing', company: 'Acme' },
      missionGoal: 'Get Acme to sponsor our developer conference',
      audience: 'B2B dev-tool companies marketing to engineers',
      whyNow: 'Acme just launched an API product and is hiring DevRel',
      allowedFacts: [
        { id: 'p1', claim: 'I organize a 1,400-person developer conference (DevConf)', source: 'context_fact' },
        { id: 'p2', claim: 'Last year 62% of attendees were senior+ engineers', source: 'context_fact' },
        { id: 'e1', claim: 'Acme launched a public API product last month', source: 'evidence' },
        { id: 'e2', claim: 'Acme posted two DevRel roles in the last 30 days', source: 'evidence' },
      ],
      exemplars: [
        {
          subject: 'sponsor slot for DevConf?',
          body: 'Hey — I run DevConf, 1,400 engineers, most of them senior. You just shipped an API and are hiring DevRel, so the timing lines up. Want me to send the prospectus? Takes you 5 minutes to skim.',
        },
      ],
      styleProfile: {
        dimensions: { formality: { value: 0.3, confidence: 0.8, source: 'onboarding' } },
        rules: [{ rule: 'No corporate filler; lead with the concrete number', source: 'onboarding', confidence: 0.9 }],
        bannedPhrases: ['I hope this finds you well', 'circle back', 'synergy'],
        voiceSummary: 'Direct, lowercase-casual, numbers-first, no flattery.',
      },
      minWords: 20,
      maxWords: 110,
    },
  },
  {
    name: 'sales-thin-facts',
    tier: 'bulk',
    ctx: {
      mode: 'sales',
      recipient: { name: 'Sam Ortiz', role: 'VP Engineering', company: 'Globex' },
      missionGoal: 'Book a demo of our CI optimization tool',
      audience: 'Mid-market engineering orgs with slow CI',
      allowedFacts: [
        { id: 'p1', claim: 'Our tool cut one customer’s CI time from 40 to 12 minutes', source: 'context_fact' },
      ],
      exemplars: [],
      styleProfile: {
        dimensions: {},
        rules: [],
        bannedPhrases: ['game-changer', 'revolutionary'],
        voiceSummary: 'Plain and specific. One claim, one ask.',
      },
      minWords: 20,
      maxWords: 100,
    },
  },
];
