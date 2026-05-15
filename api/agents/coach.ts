import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { adminClient } from '../_lib/supabase';
import { MODEL, createMessageWithRetry, extractJson } from '../_lib/anthropic';
import { COACH_SYSTEM } from '../_lib/prompts';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';

type CoachField =
  | 'bio'
  | 'proof_points'
  | 'achievements'
  | 'metrics'
  | 'writing_tone'
  | 'example_emails';

const COACHABLE_FIELDS: ReadonlySet<CoachField> = new Set([
  'bio',
  'proof_points',
  'achievements',
  'metrics',
  'writing_tone',
  'example_emails',
]);

const FIELD_LABEL: Record<CoachField, string> = {
  bio: 'Bio (positioning paragraph)',
  proof_points: 'Proof points (credibility anchors)',
  achievements: 'Achievements',
  metrics: 'Metrics (concrete outcomes)',
  writing_tone: 'Preferred writing tone (1 short phrase)',
  example_emails: 'Example emails (style reference)',
};

interface CoachOutput {
  suggestions: Array<{ title: string; rewrite: string; why: string }>;
  gaps: string[];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;

  const { field, current_value } = (req.body ?? {}) as {
    field?: string;
    current_value?: string;
  };

  if (!field || !COACHABLE_FIELDS.has(field as CoachField)) {
    return res.status(400).json({ error: 'invalid_field' });
  }
  const f = field as CoachField;

  const db = adminClient();
  if (!(await checkRateLimit(db, res, user.id))) return;

  const { data: profile, error: pErr } = await db
    .from('profiles')
    .select(
      'name, role, organization, bio, proof_points, achievements, metrics, writing_tone, example_emails, linkedin_url, website, portfolio_links'
    )
    .eq('user_id', user.id)
    .single();
  if (pErr || !profile) return res.status(404).json({ error: 'profile_not_found' });

  const currentValue = (current_value ?? '').toString().slice(0, 4000);

  // Outcome stats for THIS field across all of this user's sent messages.
  // Used both to inform the prompt and to surface in the drawer UI.
  const { data: sentRows } = await db
    .from('sent_messages')
    .select('id, profile_refs')
    .eq('user_id', user.id)
    .limit(1000);

  let fieldSentCount = 0;
  const sentIdsForField = new Set<string>();
  for (const row of (sentRows ?? []) as Array<{ id: string; profile_refs: Array<{ field?: string }> | null }>) {
    if (!Array.isArray(row.profile_refs)) continue;
    if (row.profile_refs.some((r) => r?.field === f)) {
      fieldSentCount += 1;
      sentIdsForField.add(row.id);
    }
  }
  let fieldReplyCount = 0;
  if (sentIdsForField.size > 0) {
    const { data: replyRows } = await db
      .from('replies')
      .select('id, sent_message_id, classification')
      .in('sent_message_id', Array.from(sentIdsForField));
    fieldReplyCount = (replyRows ?? []).filter(
      (r: { classification: string | null }) => r.classification !== 'oof' && r.classification !== 'unsubscribe'
    ).length;
  }
  const outcomes = {
    sent_count: fieldSentCount,
    reply_count: fieldReplyCount,
    reply_rate: fieldSentCount > 0 ? Math.round((fieldReplyCount / fieldSentCount) * 1000) / 10 : 0,
  };

  const run = await startRun(db, {
    user_id: user.id,
    agent_type: 'coach',
    input: { field: f, length: currentValue.length, ...outcomes },
  });

  try {
    const userPrompt = buildPrompt(f, currentValue, profile, outcomes);
    const message = await createMessageWithRetry({
      model: MODEL(),
      max_tokens: 1500,
      system: COACH_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const parsed = extractJson<CoachOutput>(message);
    if (!parsed.ok || !parsed.data) {
      await failRun(db, run.id, 'parse_failed');
      return res.status(502).json({ error: 'parse_failed' });
    }

    const cleaned: CoachOutput = {
      suggestions: (parsed.data.suggestions ?? [])
        .filter((s) => s && typeof s.rewrite === 'string' && s.rewrite.trim().length > 0)
        .slice(0, 3)
        .map((s) => ({
          title: (s.title ?? 'Suggestion').toString().slice(0, 60),
          rewrite: s.rewrite.toString().slice(0, 4000),
          why: (s.why ?? '').toString().slice(0, 300),
        })),
      gaps: (parsed.data.gaps ?? [])
        .filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
        .slice(0, 6)
        .map((g) => g.slice(0, 200)),
    };

    await completeRun(db, run.id, {
      field: f,
      suggestion_count: cleaned.suggestions.length,
      gap_count: cleaned.gaps.length,
    });
    return res.status(200).json({ run_id: run.id, field: f, ...cleaned, outcomes });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(db, run.id, msg);
    return res.status(500).json({ error: 'agent_failed', detail: msg });
  }
}

function buildPrompt(
  field: CoachField,
  currentValue: string,
  profile: {
    name: string | null;
    role: string | null;
    organization: string | null;
    bio: string | null;
    proof_points: string | null;
    achievements: string | null;
    metrics: string | null;
    writing_tone: string | null;
    example_emails: string | null;
    linkedin_url: string | null;
    website: string | null;
    portfolio_links: string[] | null;
  },
  outcomes: { sent_count: number; reply_count: number; reply_rate: number }
): string {
  const ctxLines = [
    'PROFILE CONTEXT (other fields of the same user — use as ground truth, never invent beyond this):',
    profile.name ? `Name: ${profile.name}` : '',
    profile.role ? `Role: ${profile.role}` : '',
    profile.organization ? `Org: ${profile.organization}` : '',
    profile.linkedin_url ? `LinkedIn: ${profile.linkedin_url}` : '',
    profile.website ? `Website: ${profile.website}` : '',
    profile.portfolio_links?.length ? `Portfolio: ${profile.portfolio_links.join(', ')}` : '',
    field !== 'bio' && profile.bio ? `Bio: ${profile.bio}` : '',
    field !== 'proof_points' && profile.proof_points ? `Proof points: ${profile.proof_points}` : '',
    field !== 'achievements' && profile.achievements ? `Achievements: ${profile.achievements}` : '',
    field !== 'metrics' && profile.metrics ? `Metrics: ${profile.metrics}` : '',
    field !== 'writing_tone' && profile.writing_tone ? `Tone: ${profile.writing_tone}` : '',
  ].filter(Boolean);

  const outcomesBlock =
    outcomes.sent_count === 0
      ? 'OUTCOMES: this field has not shipped in any sent message yet.'
      : `OUTCOMES: this field has been cited in ${outcomes.sent_count} sent message${outcomes.sent_count === 1 ? '' : 's'}, producing ${outcomes.reply_count} reply${outcomes.reply_count === 1 ? '' : 'ies'} (${outcomes.reply_rate}% reply rate). ${
          outcomes.sent_count >= 5 && outcomes.reply_count === 0
            ? "It's underperforming — be willing to take a structurally different angle, not a polish pass."
            : outcomes.reply_count > 0
              ? 'Preserve what is working; sharpen rather than rebuild.'
              : ''
        }`.trim();

  return [
    `FIELD TO COACH: ${FIELD_LABEL[field]}`,
    '',
    'CURRENT VALUE:',
    currentValue.trim() || '(empty — propose a strong starting point grounded in PROFILE CONTEXT)',
    '',
    outcomesBlock,
    '',
    ctxLines.join('\n'),
    '',
    'Return JSON only.',
  ].join('\n');
}
