// The personalization engine — grounded generate → verify → revise.
//
// This is the anti-slop core. "Slop" has three sources and each is attacked
// directly:
//   1. Fabrication        → a GROUNDING CONTRACT. The caller assembles an
//                           `allowedFacts` set; the generator must attribute
//                           every factual claim to a fact id; a deterministic
//                           verifier rejects any claim that isn't attributed to
//                           a real allowed fact. No "confident genericness".
//   2. Generic voice      → voice carried by EXEMPLARS (few-shot), not
//                           adjectives. The model imitates the user's real
//                           emails far better than it follows "be direct".
//   3. Unverified output  → a separate LLM-as-judge pass (Gemini flash) on top
//                           of deterministic checks, then a targeted revise loop.
//
// Tiering (cost vs quality): `onboarding` allows up to 2 revise loops (we're
// calibrating, one draft, interactive); `bulk` does a single critique pass and
// revises once only if a `block` violation fires (N drafts/mission, thin margin).
//
// This module is deliberately free of DB/HTTP concerns: the caller (the draft
// agent) loads + retrieves and hands in a fully `AssembledContext`. That keeps
// the grounding + verification logic pure and unit-testable without Vertex.

import { generateJson, MODEL, MODEL_PRO } from './llm';
import { checkDeliverability } from '../../shared/deliverability';
import type { StyleProfile } from '../../shared/schemas';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EngineTier = 'onboarding' | 'bulk';

/** A single thing the email is allowed to assert. The model cites these by id. */
export interface AllowedFact {
  id: string;
  claim: string;
  source: string; // 'context_fact' | 'evidence' — provenance for the judge
}

export interface DraftClaim {
  text: string;
  factId: string; // must resolve to an AllowedFact.id; '' / 'none' ⇒ fabrication
}

export interface DraftOutput {
  angle: string;
  subject: string;
  body: string;
  claims: DraftClaim[];
}

export type ViolationType =
  | 'fabrication'
  | 'banned_phrase'
  | 'slop'
  | 'voice_mismatch'
  | 'constraint';

export interface Violation {
  type: ViolationType;
  span: string;
  detail: string;
  severity: 'block' | 'warn';
}

export interface CritiqueOutput {
  pass: boolean;
  voiceMatchScore: number; // 0..1
  violations: Violation[];
}

export interface AssembledContext {
  mode: string;
  recipient: { name: string; role: string; company: string };
  missionGoal: string;
  audience: string;
  whyNow?: string;
  /** The grounding universe — ONLY these may be asserted. */
  allowedFacts: AllowedFact[];
  /** The persona's gold emails — few-shot voice anchors. */
  exemplars: Array<{ subject: string | null; body: string }>;
  styleProfile: StyleProfile;
  /** Word-count target for the initial email (defaults applied if unset). */
  maxWords?: number;
  minWords?: number;
}

export interface EngineResult {
  draft: DraftOutput;
  violations: Violation[];
  voiceMatchScore: number;
  revisions: number;
  pass: boolean;
}

// ---------------------------------------------------------------------------
// Structured-output schemas (flat — Gemini responseJsonSchema, no recursion)
// ---------------------------------------------------------------------------

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    angle: { type: 'string' },
    subject: { type: 'string' },
    body: { type: 'string' },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          factId: { type: 'string' },
        },
        required: ['text', 'factId'],
      },
    },
  },
  required: ['angle', 'subject', 'body', 'claims'],
} as const;

const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    voiceMatchScore: { type: 'number' },
    violations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['fabrication', 'banned_phrase', 'slop', 'voice_mismatch', 'constraint'],
          },
          span: { type: 'string' },
          detail: { type: 'string' },
          severity: { type: 'string', enum: ['block', 'warn'] },
        },
        required: ['type', 'span', 'detail', 'severity'],
      },
    },
  },
  required: ['pass', 'voiceMatchScore', 'violations'],
} as const;

// ---------------------------------------------------------------------------
// Prompts (kept with the schemas they shape; the system prompt is frozen so it
// can be Vertex-cached later — all volatile data goes in the user message).
// ---------------------------------------------------------------------------

const DRAFT_SYSTEM = `You are the drafting engine for OutreachOS. You write one cold outreach email in the SENDER'S voice.

Non-negotiable rules:
- GROUNDING: You may only assert facts that appear in ALLOWED FACTS. Every factual claim in the email MUST be listed in "claims" with the exact id of the fact that supports it. If you cannot support a statement with an allowed fact, do not write it. Never invent metrics, names, dates, or events.
- VOICE: Match the sender's exemplars and style profile — imitate their rhythm, structure, and register. Do NOT regress to generic "professional email" voice.
- NO SLOP: No "I hope this finds you well", no "I came across your company", no filler, no hedging, no flattery. Respect the sender's banned-phrase list absolutely.
- FORMAT: Initial email under the word target. Plain text. One specific, low-friction, time-boxed CTA.

Output JSON only, matching the schema.`;

const CRITIQUE_SYSTEM = `You are the critique judge for OutreachOS. You score a cold email draft against hard criteria and return structured violations. Be specific; cite the offending span.

Check:
- fabrication: any claim whose attributed fact does not actually support it, or any factual statement with no backing fact. severity 'block'.
- banned_phrase: any phrase on the sender's banned list, or generic slop ("hope this finds you well", "came across", "circle back", "synergy", reflexive flattery). severity 'block'.
- voice_mismatch: the draft does not sound like the sender's exemplars/style. severity 'warn'.
- constraint: violates length/structure/CTA rules. severity 'warn'.
Set voiceMatchScore 0..1 (1 = indistinguishable from the exemplars). pass=true only if there are no 'block' violations.

Output JSON only, matching the schema.`;

// ---------------------------------------------------------------------------
// Pure builders + verifier (unit-tested in engine.test.ts — no LLM/DB)
// ---------------------------------------------------------------------------

const DEFAULT_MAX_WORDS = 120;
const DEFAULT_MIN_WORDS = 20;

function styleProfileBlock(sp: StyleProfile): string {
  const dims = Object.entries(sp.dimensions ?? {})
    .map(([k, d]) => `  - ${k}: ${d.value} (confidence ${d.confidence})`)
    .join('\n');
  const rules = (sp.rules ?? []).map((r) => `  - ${r.rule}`).join('\n');
  return [
    sp.voiceSummary ? `VOICE SUMMARY:\n${sp.voiceSummary}` : '',
    dims ? `STYLE DIMENSIONS:\n${dims}` : '',
    rules ? `RULES (hard do/don'ts):\n${rules}` : '',
    sp.bannedPhrases?.length ? `BANNED PHRASES (never use):\n  - ${sp.bannedPhrases.join('\n  - ')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Build the volatile user-message prompt (everything not in the frozen system). */
export function buildDraftUserPrompt(ctx: AssembledContext): string {
  const facts = ctx.allowedFacts.length
    ? ctx.allowedFacts.map((f) => `  [${f.id}] (${f.source}) ${f.claim}`).join('\n')
    : '  (none — do not assert any specific facts)';
  const exemplars = ctx.exemplars.length
    ? ctx.exemplars
        .map((e, i) => `--- Exemplar ${i + 1} ---\n${e.subject ? `Subject: ${e.subject}\n` : ''}${e.body}`)
        .join('\n\n')
    : '(no exemplars yet — lean on the style profile)';

  return [
    `MODE: ${ctx.mode}`,
    '',
    `RECIPIENT\nName: ${ctx.recipient.name}\nRole: ${ctx.recipient.role}\nCompany: ${ctx.recipient.company}`,
    '',
    `MISSION\nGoal / offer: ${ctx.missionGoal}\nAudience: ${ctx.audience}${ctx.whyNow ? `\nWhy now: ${ctx.whyNow}` : ''}`,
    '',
    `ALLOWED FACTS (cite ids in "claims"; you may assert NOTHING else):\n${facts}`,
    '',
    `SENDER STYLE PROFILE\n${styleProfileBlock(ctx.styleProfile)}`,
    '',
    `SENDER EXEMPLARS (imitate the voice, not the specifics):\n${exemplars}`,
    '',
    `Word target: ${ctx.minWords ?? DEFAULT_MIN_WORDS}–${ctx.maxWords ?? DEFAULT_MAX_WORDS} words.`,
    'Output JSON only.',
  ].join('\n');
}

/**
 * Deterministic verification — cheap, reliable, runs before the LLM judge.
 * This is the heart of the grounding contract: a claim attributed to a factId
 * that isn't in the allowed set (or to no fact at all) is a fabrication.
 */
export function verifyDraftDeterministic(
  draft: DraftOutput,
  allowed: AllowedFact[],
  opts: { bannedPhrases?: string[]; maxWords?: number; minWords?: number } = {}
): Violation[] {
  const violations: Violation[] = [];
  const allowedIds = new Set(allowed.map((f) => f.id));

  // 1. Grounding contract — every claim must resolve to an allowed fact.
  for (const c of draft.claims ?? []) {
    const fid = (c.factId ?? '').trim();
    if (!fid || fid.toLowerCase() === 'none' || !allowedIds.has(fid)) {
      violations.push({
        type: 'fabrication',
        span: c.text,
        detail: `Claim is not attributed to an allowed fact (factId="${fid}").`,
        severity: 'block',
      });
    }
  }

  // 2. Banned phrases — the sender's personal slop list (case-insensitive).
  const hay = `${draft.subject}\n${draft.body}`.toLowerCase();
  for (const p of opts.bannedPhrases ?? []) {
    const needle = p.trim().toLowerCase();
    if (needle && hay.includes(needle)) {
      violations.push({
        type: 'banned_phrase',
        span: p,
        detail: `Contains banned phrase "${p}".`,
        severity: 'block',
      });
    }
  }

  // 3. Length constraint (warn — the judge weighs voice more heavily).
  const words = draft.body.trim().split(/\s+/).filter(Boolean).length;
  const maxW = opts.maxWords ?? DEFAULT_MAX_WORDS;
  const minW = opts.minWords ?? DEFAULT_MIN_WORDS;
  if (words > maxW) {
    violations.push({ type: 'constraint', span: '', detail: `Body is ${words} words (target ≤ ${maxW}).`, severity: 'warn' });
  } else if (words < minW) {
    violations.push({ type: 'constraint', span: '', detail: `Body is ${words} words (target ≥ ${minW}).`, severity: 'warn' });
  }

  // 4. Deliverability heuristics (shared with the pre-send UI) — spam words,
  // excess links, ALL-CAPS, exclamation pileups, subject issues. Word-count
  // warnings are dropped here because the engine owns the authoritative bounds
  // above. All map to warn-level constraints (the LLM judge weighs voice more).
  for (const w of checkDeliverability(draft.subject, draft.body).warnings) {
    if (/\bwords\b/.test(w)) continue;
    violations.push({ type: 'constraint', span: '', detail: w, severity: 'warn' });
  }

  // 5. CTA presence — a cold email with no ask reads as aimless. Warn (the
  // sender may intentionally open a soft thread).
  if (!hasCta(draft.body)) {
    violations.push({ type: 'constraint', span: '', detail: 'No clear call-to-action detected.', severity: 'warn' });
  }

  return violations;
}

// Light CTA heuristic: a question, or a recognizable ask/next-step phrase.
const CTA_PATTERNS =
  /\?|\b(worth|open to|free to|grab|book|set up|hop on|jump on|chat|call|meeting|connect|reply|let me know|interested|15 min|few minutes|next week|this week)\b/i;
function hasCta(body: string): boolean {
  return CTA_PATTERNS.test(body);
}

/** True if any violation would block sending. */
export function hasBlocker(violations: Violation[]): boolean {
  return violations.some((v) => v.severity === 'block');
}

// ---------------------------------------------------------------------------
// LLM stages
// ---------------------------------------------------------------------------

async function generateDraft(ctx: AssembledContext, extra = ''): Promise<DraftOutput> {
  const user = extra ? `${buildDraftUserPrompt(ctx)}\n\n${extra}` : buildDraftUserPrompt(ctx);
  const r = await generateJson<DraftOutput>({
    model: MODEL_PRO(), // quality tier for the one call that defines the product
    max_tokens: 2048,
    temperature: 0.7, // some voice variance
    system: DRAFT_SYSTEM,
    responseJsonSchema: DRAFT_SCHEMA,
    messages: [{ role: 'user', content: user }],
  });
  if (!r.ok || !r.data?.body) throw new Error('draft_parse_failed');
  return { angle: r.data.angle ?? '', subject: r.data.subject ?? '', body: r.data.body, claims: r.data.claims ?? [] };
}

async function critiqueDraft(draft: DraftOutput, ctx: AssembledContext): Promise<CritiqueOutput> {
  const facts = ctx.allowedFacts.map((f) => `[${f.id}] ${f.claim}`).join('\n');
  const exemplars = ctx.exemplars.map((e) => e.body).join('\n---\n');
  const user = [
    `ALLOWED FACTS:\n${facts || '(none)'}`,
    `BANNED PHRASES: ${ctx.styleProfile.bannedPhrases?.join(', ') || '(none)'}`,
    `EXEMPLARS (the target voice):\n${exemplars || '(none)'}`,
    `DRAFT:\nSubject: ${draft.subject}\n\n${draft.body}`,
    `CLAIMS (text → factId):\n${(draft.claims ?? []).map((c) => `- "${c.text}" → ${c.factId || 'NONE'}`).join('\n') || '(none)'}`,
    'Output JSON only.',
  ].join('\n\n');
  const r = await generateJson<CritiqueOutput>({
    model: MODEL(), // cheap flash tier is fine for judging
    max_tokens: 1024,
    temperature: 0.2, // deterministic judging
    system: CRITIQUE_SYSTEM,
    responseJsonSchema: CRITIQUE_SCHEMA,
    messages: [{ role: 'user', content: user }],
  });
  if (!r.ok || !r.data) return { pass: true, voiceMatchScore: 0, violations: [] };
  return {
    pass: !!r.data.pass,
    voiceMatchScore: typeof r.data.voiceMatchScore === 'number' ? r.data.voiceMatchScore : 0,
    violations: Array.isArray(r.data.violations) ? r.data.violations : [],
  };
}

function reviseInstruction(violations: Violation[]): string {
  const lines = violations.map((v) => `- [${v.type}] ${v.detail}${v.span ? ` (span: "${v.span}")` : ''}`);
  return [
    'Your previous draft had these violations. Rewrite it to fix ALL of them while keeping the sender voice:',
    ...lines,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Orchestration — generate → deterministic verify → LLM judge → tiered revise
// ---------------------------------------------------------------------------

export async function runDraftEngine(ctx: AssembledContext, tier: EngineTier): Promise<EngineResult> {
  const maxRevisions = tier === 'onboarding' ? 2 : 1;
  const bannedPhrases = ctx.styleProfile.bannedPhrases ?? [];

  let draft = await generateDraft(ctx);
  let revisions = 0;
  let critique: CritiqueOutput = { pass: true, voiceMatchScore: 0, violations: [] };

  for (;;) {
    const deterministic = verifyDraftDeterministic(draft, ctx.allowedFacts, {
      bannedPhrases,
      maxWords: ctx.maxWords,
      minWords: ctx.minWords,
    });
    critique = await critiqueDraft(draft, ctx);
    const all = [...deterministic, ...critique.violations];

    // Revise only if a blocker fired and we still have budget (tiered).
    if (!hasBlocker(all) || revisions >= maxRevisions) {
      return {
        draft,
        violations: all,
        voiceMatchScore: critique.voiceMatchScore,
        revisions,
        pass: !hasBlocker(all),
      };
    }
    draft = await generateDraft(ctx, reviseInstruction(all));
    revisions += 1;
  }
}
