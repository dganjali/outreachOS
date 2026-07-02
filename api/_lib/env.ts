function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] || fallback;
}

export const env = {
  // Gemini (Vertex AI) - the agent LLM. Auth is via Application Default
  // Credentials (the Cloud Run runtime service account), so no API key here.
  // Two tiers: flash is the cheap default (research, judging, extraction); pro
  // is reserved for the quality-critical draft generation step (the one call
  // that defines the product). See api/_lib/llm.ts MODEL() vs MODEL_PRO().
  GEMINI_MODEL: () => optional('GEMINI_MODEL', 'gemini-2.5-flash'),
  GEMINI_PRO_MODEL: () => optional('GEMINI_PRO_MODEL', 'gemini-2.5-pro'),
  // Embeddings model (Vertex AI). Pinned to 1024 dims in embeddings.ts to
  // match the existing Atlas vector indexes.
  GEMINI_EMBED_MODEL: () => optional('GEMINI_EMBED_MODEL', 'gemini-embedding-001'),
  // Vertex AI region for generateContent. gemini-2.5-* live in us-central1.
  VERTEX_LOCATION: () => optional('VERTEX_LOCATION', 'us-central1'),

  // Anthropic (legacy - optional, kept so old config doesn't crash boot)
  ANTHROPIC_API_KEY: () => optional('ANTHROPIC_API_KEY'),
  ANTHROPIC_MODEL: () => optional('ANTHROPIC_MODEL', 'claude-sonnet-4-5'),

  // MongoDB
  MONGODB_URI: () => required('MONGODB_URI'),
  MONGODB_DB: () => optional('MONGODB_DB', 'outreachos'),

  // Firebase (server side via firebase-admin)
  FIREBASE_PROJECT_ID: () => required('FIREBASE_PROJECT_ID'),
  FIREBASE_SERVICE_ACCOUNT_JSON: () => optional('FIREBASE_SERVICE_ACCOUNT_JSON'),

  // Voyage AI (legacy - embeddings moved to Vertex; optional so boot won't fail)
  VOYAGE_API_KEY: () => optional('VOYAGE_API_KEY'),

  // Google Cloud
  GCP_PROJECT_ID: () => required('GCP_PROJECT_ID'),
  GCP_REGION: () => optional('GCP_REGION', 'us-central1'),
  GCS_BUCKET: () => required('GCS_BUCKET'),
  CLOUD_TASKS_QUEUE: () => optional('CLOUD_TASKS_QUEUE', 'outreach-jobs'),
  CLOUD_TASKS_TARGET_URL: () => required('CLOUD_TASKS_TARGET_URL'),
  CLOUD_TASKS_SERVICE_ACCOUNT: () => required('CLOUD_TASKS_SERVICE_ACCOUNT'),

  // Encryption + auth shared secrets
  ENCRYPTION_KEY: () => required('ENCRYPTION_KEY'),
  CRON_SECRET: () => optional('CRON_SECRET'),

  // Google OAuth (Gmail integration)
  GOOGLE_CLIENT_ID: () => required('GOOGLE_CLIENT_ID'),
  GOOGLE_CLIENT_SECRET: () => required('GOOGLE_CLIENT_SECRET'),

  // Serper (optional) - Google SERP API for person discovery. When set, the
  // contacts agent uses deterministic search results instead of the LLM's
  // built-in web_search grounding.
  SERPER_API_KEY: () => process.env.SERPER_API_KEY || null,

  // Recipient verification (api/_lib/contact-verify.ts). The per-person gate that
  // researches each contact and drops clear mismatches (wrong person, former
  // affiliation, wrong team) before drafting. On by default; set to '0'/'false'
  // to disable (skips the extra web_search + LLM call per kept contact).
  CONTACT_VERIFY_ENABLED: () => !/^(0|false|off)$/i.test(process.env.CONTACT_VERIFY_ENABLED ?? ''),

  // emailfinder.dev (optional) - SMTP-verified email resolution. When set, the
  // contacts agent resolves a real, deliverable email instead of guessing.
  EMAILFINDER_API_KEY: () => process.env.EMAILFINDER_API_KEY || null,

  // Cross-account contact-diversity penalty (api/_lib/contacted.ts). When on, a
  // platform-wide ANONYMIZED tally of how often each contact has been emailed
  // softly down-ranks the most-blasted profiles so two accounts with the same
  // ICP don't collide on the same people. Off by default - ship dark, then tune.
  CONTACT_HEAT_ENABLED: () => /^(1|true|on)$/i.test(process.env.CONTACT_HEAT_ENABLED ?? ''),
  // Salt for the contact-heat identity hash. The hash is what makes the tally
  // anonymous (not reversible to a person); without a stable salt set, heat is
  // treated as disabled so we never write weakly-hashed identities.
  CONTACT_HEAT_SALT: () => process.env.CONTACT_HEAT_SALT || null,

  // MillionVerifier (optional) - catch-all gate after resolution. When set, a
  // finder hit on a catch-all/unknown domain is downgraded to 'likely' and
  // 'invalid' addresses are discarded instead of shipped as 'verified'.
  MILLIONVERIFIER_API_KEY: () => process.env.MILLIONVERIFIER_API_KEY || null,

  // Stripe (monetization). Optional so the service boots without billing
  // configured; the billing endpoints fail with a clear error if unset.
  STRIPE_SECRET_KEY: () => optional('STRIPE_SECRET_KEY'),
  STRIPE_WEBHOOK_SECRET: () => optional('STRIPE_WEBHOOK_SECRET'),
  // Stripe Price ids (recurring monthly) for each paid plan.
  STRIPE_PRICE_STARTER: () => optional('STRIPE_PRICE_STARTER'),
  STRIPE_PRICE_PRO: () => optional('STRIPE_PRICE_PRO'),
  STRIPE_PRICE_SCALE: () => optional('STRIPE_PRICE_SCALE'),
  // Public app origin used to build Checkout success/cancel + portal return
  // URLs. Defaults to the custom domain (must be connected to Firebase Hosting
  // with the /api/** -> Cloud Run rewrite, same as the Stripe webhook).
  APP_URL: () => optional('APP_URL', 'https://outreachos.app'),
};

// Vars that every deploy must provide for the service to handle any request.
// Validated eagerly at boot so a misconfigured deploy fails fast with all of
// them listed at once.
//
// NOTE: CLOUD_TASKS_TARGET_URL / CLOUD_TASKS_SERVICE_ACCOUNT are declared with
// required() above but are deliberately NOT in this boot set: their only
// consumer is the unwired Cloud Tasks enqueue path (dead code), they are not
// supplied by cloudbuild.yaml, and the service runs fine without them. They
// still throw lazily if that path is ever wired up without them.
export const REQUIRED_ENV = [
  'MONGODB_URI',
  'FIREBASE_PROJECT_ID',
  'GCP_PROJECT_ID',
  'GCS_BUCKET',
  'ENCRYPTION_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
] as const;

/**
 * Fail fast at startup if a required env var is missing. Without this the
 * service boots "healthy" (the getters are lazy) and only 500s when the first
 * request reaches code that reads the unset var - a misconfigured deploy looks
 * fine until a user hits it. Call once before app.listen().
 */
export function assertRequiredEnv(): void {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required env var(s): ${missing.join(', ')}`);
  }
}
