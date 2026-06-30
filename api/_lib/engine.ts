// The personalization engine - grounded generate → verify → revise.
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
// calibrating, one draft, interactive); `bulk` allows a single revise pass (N
// drafts/mission, thin margin). A revise is spent on a hard `block` violation OR
// a soft quality signal - a voice/constraint warning or a sub-threshold voice
// match - so "fine but generic" drafts get one improvement pass instead of
// shipping as-is. Cost stays bounded by maxRevisions either way.
//
// This module is deliberately free of DB/HTTP concerns: the caller (the draft
// agent) loads + retrieves and hands in a fully `AssembledContext`. That keeps
// the grounding + verification logic pure and unit-testable without Vertex.

import { generateJson, MODEL, MODEL_PRO } from './llm';
import { checkDeliverability } from '../../shared/deliverability';
import { DEFAULT_TEMPLATE_STRICTNESS } from '../../shared/schemas';
import type { StyleProfile } from '../../shared/schemas';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EngineTier = 'onboarding' | 'bulk';

/** A single thing the email is allowed to assert. The model cites these by id. */
export interface AllowedFact {
  id: string;
  claim: string;
  source: string; // 'context_fact' | 'evidence' - provenance for the judge
  /** Evidence-only: the signal type (funding/hiring/launch…) so the writer can
   *  prefer high-value signals when choosing what to lead on. */
  signal?: string;
  /** Evidence-only: freeform recency ("2 weeks ago") so freshness is visible. */
  recency?: string;
  /** Sender-fact only: the user pinned this fact on the mission, so the writer
   *  must feature it (assemble.ts always includes pinned facts, bypassing caps). */
  emphasized?: boolean;
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
  /**
   * The recipient. `headline`/`location` come from their LinkedIn/public profile
   * and are background for relevance + tone only - NOT citable facts (the writer
   * may still assert only `allowedFacts`).
   */
  recipient: { name: string; role: string; company: string; headline?: string | null; location?: string | null };
  /**
   * The sender's identity - used to guarantee a real sign-off on every email.
   * `headline` is their LinkedIn one-liner (background positioning, not a claim).
   */
  sender?: { name: string | null; role?: string | null; organization?: string | null; headline?: string | null };
  missionGoal: string;
  audience: string;
  whyNow?: string;
  /** Free-text standing instructions the user set on the mission - honored on
   *  every draft. null/absent = none. NOT a citable fact. */
  directive?: string | null;
  /** The grounding universe - ONLY these may be asserted. */
  allowedFacts: AllowedFact[];
  /** The persona's gold emails - few-shot voice anchors. */
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
// Structured-output schemas (flat - Gemini responseJsonSchema, no recursion)
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
// can be Vertex-cached later - all volatile data goes in the user message).
// ---------------------------------------------------------------------------

const DRAFT_SYSTEM = `You are the drafting engine for OutreachOS. You write one cold outreach email in the SENDER'S voice.

Non-negotiable rules:
- GROUNDING: You may only assert facts listed under SIGNALS or YOUR PROOF. Every factual claim in the email MUST be listed in "claims" with the exact id of the fact that supports it. If you cannot support a statement with a listed fact, do not write it. Never invent metrics, names, dates, or events.
- TARGET FOCUS: This email is for ONE specific person. Open on the single strongest, freshest signal about the recipient or their company (from SIGNALS) and make it the spine of the email. The first sentence must reference something true and particular about THEM - a reader must not be able to swap in a different name or company without the email falling apart. If no SIGNALS are given, lead on why the offer is specifically relevant to their role; still never a generic opener.
- BEST EVIDENCE, NOT ALL: Choose the 1-2 signals that most justify reaching out to THIS person; ignore the rest. Prefer recent, high-value signals (funding, launches, hiring, partnerships, leadership moves) over generic ones. Do not list facts - weave the chosen one into a reason to talk. YOUR PROOF is for credibility only, used sparingly, never as the opener.
- VOICE: Match the sender's exemplars and style profile - imitate their rhythm, structure, and register. Do NOT regress to generic "professional email" voice.
- SUBJECT: If the style profile specifies a SUBJECT-LINE STYLE, the subject MUST follow it exactly (length, casing, punctuation, pattern). Otherwise mirror the subject style of the sender's exemplars. Never default to a generic "Quick question" style subject.
- NO SLOP: No "I hope this finds you well", no "I came across your company", no filler, no hedging, no flattery. Respect the sender's banned-phrase list absolutely.
- PUNCTUATION: Never use em dashes or en dashes. Write with commas, periods, colons, or parentheses instead. A real person typing this email would not reach for a long dash.
- ANGLE: "angle" is one sentence naming the specific signal you lead with and how it connects to the offer (e.g. "They just raised a Series B → scaling support, which my offer speeds up"). The body must deliver exactly that angle, not a kitchen-sink of every fact.
- FORMAT: Initial email under the word target. Plain text. One specific, low-friction, time-boxed CTA.
- SIGN-OFF: Always end the body with a short closing line (e.g. "Best,") followed by the sender's name on the next line. Use the SENDER name provided verbatim - NEVER leave a placeholder like "[Your Name]", "[Name]", or "{{name}}". The sign-off is part of the body, not the subject.

Output JSON only, matching the schema.`;

const CRITIQUE_SYSTEM = `You are the critique judge for OutreachOS. You score a cold email draft against hard criteria and return structured violations. Be specific; cite the offending span.

Check:
- fabrication: any claim whose attributed fact does not actually support it, or any factual statement with no backing fact. severity 'block'.
- banned_phrase: any phrase on the sender's banned list, or generic slop ("hope this finds you well", "came across", "circle back", "synergy", reflexive flattery). severity 'block'.
- voice_mismatch: the draft does not sound like the sender's exemplars/style. severity 'warn'.
- constraint: violates length/structure/CTA rules, OR the opener is generic - it could be sent to any recipient with no change because it does not reference a specific signal about them or their company, even though signals were provided. severity 'warn'.
Set voiceMatchScore 0..1 (1 = indistinguishable from the exemplars). pass=true only if there are no 'block' violations.

Output JSON only, matching the schema.`;

// ---------------------------------------------------------------------------
// Pure builders + verifier (unit-tested in engine.test.ts - no LLM/DB)
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
    sp.subjectStyle?.trim() ? `SUBJECT-LINE STYLE (the subject MUST follow this):\n${sp.subjectStyle.trim()}` : '',
    dims ? `STYLE DIMENSIONS:\n${dims}` : '',
    rules ? `RULES (hard do/don'ts):\n${rules}` : '',
    sp.bannedPhrases?.length ? `BANNED PHRASES (never use):\n  - ${sp.bannedPhrases.join('\n  - ')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Translate the 0–100 template-strictness slider into an explicit drafting
 * directive. Low = the exemplars are loose voice inspiration; high = treat the
 * closest exemplar as a template to follow structurally, almost verbatim.
 */
export function templateStrictnessDirective(strictness: number, hasExemplars: boolean): string {
  if (!hasExemplars) return '';
  const s = Math.max(0, Math.min(100, Math.round(strictness)));
  let guidance: string;
  if (s <= 20) {
    guidance =
      'Use the exemplars ONLY as loose voice inspiration - match the sender\'s tone and rhythm, but write a fresh structure tailored to this recipient. Do not reuse the exemplars\' opening lines, structure, or phrasing.';
  } else if (s <= 45) {
    guidance =
      'Lean on the exemplars for voice and general shape, but adapt freely to this recipient. Borrow phrasing only where it fits naturally.';
  } else if (s <= 70) {
    guidance =
      'Treat the closest exemplar as a strong template: follow its overall structure, paragraph flow, and CTA style, swapping in details relevant to this recipient.';
  } else if (s <= 90) {
    guidance =
      'Follow the closest exemplar closely as a template: keep its structure, sentence patterns, and most phrasing, changing only the recipient-specific details and grounded facts.';
  } else {
    guidance =
      'Reproduce the closest exemplar as a near-verbatim template: preserve its structure, opening, sentence patterns, and wording, changing ONLY the recipient-specific details and grounded facts. Stay as close to the original as the facts allow.';
  }
  return `TEMPLATE STRICTNESS: ${s}/100. ${guidance}`;
}

/** Render one allowed fact, surfacing evidence signal/recency so the writer can
 *  weigh freshness + signal strength when choosing what to lead on. */
function renderFact(f: AllowedFact): string {
  const meta = [f.signal, f.recency].filter((x) => x && x.trim()).join(' · ');
  return `  [${f.id}]${meta ? ` (${meta})` : ''} ${f.claim}`;
}

/** Build the volatile user-message prompt (everything not in the frozen system). */
export function buildDraftUserPrompt(ctx: AssembledContext): string {
  // Split the grounding universe so the recipient's signals (what to LEAD on)
  // are visually distinct from the sender's proof (credibility only). A flat,
  // undifferentiated list is a big reason drafts read same-y and unfocused.
  const recipientFacts = ctx.allowedFacts.filter((f) => f.source === 'evidence');
  const senderFacts = ctx.allowedFacts.filter((f) => f.source !== 'evidence');
  // Pinned ("emphasized") sender facts the user wants featured vs the rest, which
  // stay background credibility. Splitting them is what makes a pin actually bite.
  const featuredFacts = senderFacts.filter((f) => f.emphasized);
  const otherFacts = senderFacts.filter((f) => !f.emphasized);
  const signalsBlock = recipientFacts.length
    ? recipientFacts.map(renderFact).join('\n')
    : '  (none found - lead on why the offer is specifically relevant to their role; do NOT invent a signal)';
  const proofBlock = otherFacts.length ? otherFacts.map(renderFact).join('\n') : '  (none)';
  const featuredBlock = featuredFacts.length ? featuredFacts.map(renderFact).join('\n') : '';
  const exemplars = ctx.exemplars.length
    ? ctx.exemplars
        .map((e, i) => `--- Exemplar ${i + 1} ---\n${e.subject ? `Subject: ${e.subject}\n` : ''}${e.body}`)
        .join('\n\n')
    : '(no exemplars yet - lean on the style profile)';
  const strictness = templateStrictnessDirective(
    ctx.styleProfile.templateStrictness ?? DEFAULT_TEMPLATE_STRICTNESS,
    ctx.exemplars.length > 0
  );

  const senderName = ctx.sender?.name?.trim();
  const senderHeadline = ctx.sender?.headline?.trim();
  const senderLine = senderName
    ? `SENDER (sign off as this person)\nName: ${senderName}${ctx.sender?.role ? `\nRole: ${ctx.sender.role}` : ''}${ctx.sender?.organization ? `\nOrganization: ${ctx.sender.organization}` : ''}${senderHeadline ? `\nLinkedIn headline: ${senderHeadline}` : ''}`
    : 'SENDER: name unknown - end with a closing line ("Best,") and leave the name line blank (do NOT write a placeholder).';

  // Recipient background (headline/location) helps the writer tailor relevance
  // and tone, but it is NOT in ALLOWED FACTS, so flag it as non-citable.
  const recipHeadline = ctx.recipient.headline?.trim();
  const recipLocation = ctx.recipient.location?.trim();
  const recipBackground =
    recipHeadline || recipLocation
      ? `\nBackground (for relevance + tone only, NOT a citable fact):${recipHeadline ? `\n- LinkedIn headline: ${recipHeadline}` : ''}${recipLocation ? `\n- Location: ${recipLocation}` : ''}`
      : '';

  const directive = ctx.directive?.trim();

  return [
    `MODE: ${ctx.mode}`,
    '',
    `RECIPIENT\nName: ${ctx.recipient.name}\nRole: ${ctx.recipient.role}\nCompany: ${ctx.recipient.company}${recipBackground}`,
    '',
    senderLine,
    '',
    `MISSION\nGoal / offer: ${ctx.missionGoal}\nAudience: ${ctx.audience}${ctx.whyNow ? `\nWhy now: ${ctx.whyNow}` : ''}`,
    ...(directive
      ? ['', `STANDING INSTRUCTIONS (the sender set these for every email in this mission - always honor them):\n${directive}`]
      : []),
    '',
    'GROUNDING CONTRACT: cite the id of every factual claim in "claims". You may assert ONLY the facts listed below - nothing else.',
    '',
    `SIGNALS ABOUT ${ctx.recipient.company || 'THE RECIPIENT'} (their world - LEAD with the single strongest, freshest one; ignore the rest):\n${signalsBlock}`,
    ...(featuredBlock
      ? [
          '',
          `FEATURE THESE ABOUT THE SENDER (the sender pinned these - work at least one in naturally and prominently; if several drafts go out, vary which one you lead with so emails don't read identically):\n${featuredBlock}`,
        ]
      : []),
    '',
    `YOUR PROOF (the sender's other facts - credibility only, used sparingly, never the opener; rotate which you draw on across emails):\n${proofBlock}`,
    '',
    `SENDER STYLE PROFILE\n${styleProfileBlock(ctx.styleProfile)}`,
    '',
    `SENDER EXEMPLARS (imitate the voice, not the specifics):\n${exemplars}`,
    ...(strictness ? ['', strictness] : []),
    '',
    `Word target: ${ctx.minWords ?? DEFAULT_MIN_WORDS}–${ctx.maxWords ?? DEFAULT_MAX_WORDS} words.`,
    'Output JSON only.',
  ].join('\n');
}

/**
 * Deterministic verification - cheap, reliable, runs before the LLM judge.
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

  // 1. Grounding contract - every claim must resolve to an allowed fact.
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

  // 2. Banned phrases - the sender's personal slop list (case-insensitive).
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

  // 3. Length constraint (warn - the judge weighs voice more heavily).
  const words = draft.body.trim().split(/\s+/).filter(Boolean).length;
  const maxW = opts.maxWords ?? DEFAULT_MAX_WORDS;
  const minW = opts.minWords ?? DEFAULT_MIN_WORDS;
  if (words > maxW) {
    violations.push({ type: 'constraint', span: '', detail: `Body is ${words} words (target ≤ ${maxW}).`, severity: 'warn' });
  } else if (words < minW) {
    violations.push({ type: 'constraint', span: '', detail: `Body is ${words} words (target ≥ ${minW}).`, severity: 'warn' });
  }

  // 4. Deliverability heuristics (shared with the pre-send UI) - spam words,
  // excess links, ALL-CAPS, exclamation pileups, subject issues. Word-count
  // warnings are dropped here because the engine owns the authoritative bounds
  // above. All map to warn-level constraints (the LLM judge weighs voice more).
  for (const w of checkDeliverability(draft.subject, draft.body).warnings) {
    if (/\bwords\b/.test(w)) continue;
    violations.push({ type: 'constraint', span: '', detail: w, severity: 'warn' });
  }

  // 5. CTA presence - a cold email with no ask reads as aimless. Warn (the
  // sender may intentionally open a soft thread).
  if (!hasCta(draft.body)) {
    violations.push({ type: 'constraint', span: '', detail: 'No clear call-to-action detected.', severity: 'warn' });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Sign-off guarantee. The prompt asks for a sign-off, but we never *rely* on the
// model: this deterministic pass (a) swaps any leftover placeholder for the real
// name and (b) appends a closing if none is present, so EVERY email ends signed.
// ---------------------------------------------------------------------------

// Closing words that mark a sign-off line ("Best,", "Thanks!", "Warm regards").
const SIGNOFF_LINE =
  /^(best|best regards|thanks|thank you|thanks so much|cheers|regards|warm regards|warmly|sincerely|talk soon|speak soon|all the best|looking forward|appreciate it|with thanks|kind regards|yours)\b/i;

// Placeholder name tokens a model sometimes emits instead of the real name.
const NAME_PLACEHOLDER =
  /\[\s*(your name|name|sender(?:'s)? name|sender|my name|full name)\s*\]|\{\{\s*(name|sender|sender_name|first_name|full_name)\s*\}\}/gi;

export function ensureSignOff(body: string, senderName: string | null | undefined): string {
  const name = (senderName ?? '').trim();
  const firstName = name.split(/\s+/)[0] || name;

  // (a) Replace placeholders with the real name (or strip them when unknown).
  let text = (body ?? '').replace(NAME_PLACEHOLDER, name).replace(/[ \t]+\n/g, '\n').trimEnd();

  // (b) Detect an existing sign-off in the last few non-empty lines.
  const nonEmpty = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const tail = nonEmpty.slice(-3);
  const nameLower = name.toLowerCase();
  const firstLower = firstName.toLowerCase();
  const hasSignoff = tail.some(
    (l) =>
      SIGNOFF_LINE.test(l) ||
      (!!name && (l.toLowerCase() === nameLower || l.toLowerCase() === firstLower))
  );
  if (hasSignoff) return text;

  // (c) None present - append one. Use the sender's name when we know it.
  const closing = name ? `Best,\n${firstName}` : 'Best,';
  return `${text}\n\n${closing}`;
}

// ---------------------------------------------------------------------------
// Punctuation cleanup. Em/en dashes are a recognizable "AI wrote this" tell, so
// every generated email is scrubbed of them deterministically (the prompt asks
// the model to avoid them, but we never rely on the model). Numeric ranges
// (9-5, 10-20) collapse to a hyphen; dashes used as punctuation become a comma.
// ---------------------------------------------------------------------------
export function stripDashes(text: string): string {
  if (!text) return text;
  return text
    // 9–5, 10—20 → keep it a numeric range with a plain hyphen
    .replace(/(\d)\s*[—–]\s*(\d)/g, '$1-$2')
    // dash used as a clause break → comma
    .replace(/\s*[—–]\s*/g, ', ')
    // tidy any doubled comma the swap may have produced
    .replace(/,\s*,/g, ',');
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

// A draft scoring below this against the sender's exemplars reads off-voice
// enough to be worth one revise pass (when budget remains). The judge returns 0
// when its call fails, so a 0 is treated as "no signal", not "worst possible".
export const QUALITY_MIN_VOICE = 0.65;

/** A soft quality signal: the judge flagged off-voice / generic-opener / format,
 *  or scored the voice match below threshold. These are warnings (still
 *  sendable), but on a cold email "sendable but generic" is the thing to fix. */
export function isWeakDraft(violations: Violation[], voiceMatchScore: number): boolean {
  const qualityWarn = violations.some(
    (v) => v.severity === 'warn' && (v.type === 'voice_mismatch' || v.type === 'constraint')
  );
  const weakVoice = voiceMatchScore > 0 && voiceMatchScore < QUALITY_MIN_VOICE;
  return qualityWarn || weakVoice;
}

/** Decide whether to spend a revise pass: on a hard blocker or a soft quality
 *  signal, as long as the tier's revise budget remains. Pure, so the policy is
 *  unit-tested without an LLM. */
export function shouldRevise(
  violations: Violation[],
  voiceMatchScore: number,
  revisions: number,
  maxRevisions: number
): boolean {
  if (revisions >= maxRevisions) return false;
  return hasBlocker(violations) || isWeakDraft(violations, voiceMatchScore);
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
  const signals = ctx.allowedFacts.filter((f) => f.source === 'evidence').map((f) => `- ${f.claim}`).join('\n');
  const exemplars = ctx.exemplars.map((e) => e.body).join('\n---\n');
  const user = [
    `RECIPIENT: ${ctx.recipient.name}, ${ctx.recipient.role} at ${ctx.recipient.company}`,
    `SIGNALS AVAILABLE ABOUT THE RECIPIENT (the opener should reference one of these if any exist):\n${signals || '(none - a role-relevant opener is acceptable)'}`,
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

function reviseInstruction(violations: Violation[], weakVoiceScore?: number): string {
  const parts: string[] = [];
  if (violations.length) {
    const lines = violations.map((v) => `- [${v.type}] ${v.detail}${v.span ? ` (span: "${v.span}")` : ''}`);
    parts.push('Your previous draft had these issues. Rewrite it to fix ALL of them while keeping the sender voice:', ...lines);
  }
  // When the judge scored the voice low (but listed nothing concrete to fix),
  // give the rewrite a direction: sound like the sender, and earn the send by
  // opening on something true and specific to THIS recipient.
  if (typeof weakVoiceScore === 'number') {
    parts.push(
      `This draft is sendable but not good enough yet (voice match ${weakVoiceScore.toFixed(2)}/1.0). Rewrite it to:`,
      "- Match the sender's exemplars far more closely: their rhythm, sentence length, vocabulary, and register. Do not regress to generic professional-email voice.",
      '- Open on a specific, true signal about THIS recipient or their company so the first sentence could not be swapped onto anyone else. Stay grounded in the allowed facts.'
    );
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Orchestration - generate → deterministic verify → LLM judge → tiered revise
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

    // Revise on a blocker OR a soft quality signal, while budget remains.
    if (!shouldRevise(all, critique.voiceMatchScore, revisions, maxRevisions)) {
      // Guarantee a real sign-off on the final body (placeholders swapped,
      // closing appended if missing). Done after verification so the appended
      // closing is never itself flagged. Strip em/en dashes from the final text
      // (subject + body) so no AI-tell punctuation survives to the recipient.
      const signed = {
        ...draft,
        subject: stripDashes(draft.subject),
        body: stripDashes(ensureSignOff(draft.body, ctx.sender?.name)),
      };
      return {
        draft: signed,
        violations: all,
        voiceMatchScore: critique.voiceMatchScore,
        revisions,
        pass: !hasBlocker(all),
      };
    }
    // Pass the voice score into the revise prompt only when it's the weak signal
    // driving the rewrite (not a hard blocker), so the nudge has a direction.
    const weakVoice = !hasBlocker(all) && critique.voiceMatchScore > 0 && critique.voiceMatchScore < QUALITY_MIN_VOICE;
    draft = await generateDraft(ctx, reviseInstruction(all, weakVoice ? critique.voiceMatchScore : undefined));
    revisions += 1;
  }
}
