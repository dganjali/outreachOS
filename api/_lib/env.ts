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

  // emailfinder.dev (optional) - SMTP-verified email resolution. When set, the
  // contacts agent resolves a real, deliverable email instead of guessing.
  EMAILFINDER_API_KEY: () => process.env.EMAILFINDER_API_KEY || null,

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
  APP_URL: () => optional('APP_URL', 'https://outreach-os.ca'),
};
