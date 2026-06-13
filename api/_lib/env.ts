function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] || fallback;
}

export const env = {
  // Gemini (Vertex AI) — the agent LLM. Auth is via Application Default
  // Credentials (the Cloud Run runtime service account), so no API key here.
  GEMINI_MODEL: () => optional('GEMINI_MODEL', 'gemini-2.5-flash'),
  // Embeddings model (Vertex AI). Pinned to 1024 dims in embeddings.ts to
  // match the existing Atlas vector indexes.
  GEMINI_EMBED_MODEL: () => optional('GEMINI_EMBED_MODEL', 'gemini-embedding-001'),
  // Vertex AI region for generateContent. gemini-2.5-* live in us-central1.
  VERTEX_LOCATION: () => optional('VERTEX_LOCATION', 'us-central1'),

  // Anthropic (legacy — optional, kept so old config doesn't crash boot)
  ANTHROPIC_API_KEY: () => optional('ANTHROPIC_API_KEY'),
  ANTHROPIC_MODEL: () => optional('ANTHROPIC_MODEL', 'claude-sonnet-4-5'),

  // MongoDB
  MONGODB_URI: () => required('MONGODB_URI'),
  MONGODB_DB: () => optional('MONGODB_DB', 'outreachos'),

  // Firebase (server side via firebase-admin)
  FIREBASE_PROJECT_ID: () => required('FIREBASE_PROJECT_ID'),
  FIREBASE_SERVICE_ACCOUNT_JSON: () => optional('FIREBASE_SERVICE_ACCOUNT_JSON'),

  // Voyage AI (legacy — embeddings moved to Vertex; optional so boot won't fail)
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

  // Apollo (optional)
  APOLLO_API_KEY: () => process.env.APOLLO_API_KEY || null,

  // Serper (optional) — Google SERP API for person discovery. When set, the
  // contacts agent uses deterministic search results instead of the LLM's
  // built-in web_search grounding.
  SERPER_API_KEY: () => process.env.SERPER_API_KEY || null,

  // emailfinder.dev (optional) — SMTP-verified email resolution. When set, the
  // contacts agent resolves a real, deliverable email instead of guessing.
  EMAILFINDER_API_KEY: () => process.env.EMAILFINDER_API_KEY || null,
};
