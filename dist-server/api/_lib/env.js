function required(name) {
    const v = process.env[name];
    if (!v)
        throw new Error(`Missing required env var: ${name}`);
    return v;
}
function optional(name, fallback = '') {
    return process.env[name] || fallback;
}
export const env = {
    // Anthropic
    ANTHROPIC_API_KEY: () => required('ANTHROPIC_API_KEY'),
    ANTHROPIC_MODEL: () => optional('ANTHROPIC_MODEL', 'claude-sonnet-4-5'),
    // MongoDB
    MONGODB_URI: () => required('MONGODB_URI'),
    MONGODB_DB: () => optional('MONGODB_DB', 'outreachos'),
    // Firebase (server side via firebase-admin)
    FIREBASE_PROJECT_ID: () => required('FIREBASE_PROJECT_ID'),
    FIREBASE_SERVICE_ACCOUNT_JSON: () => optional('FIREBASE_SERVICE_ACCOUNT_JSON'),
    // Voyage AI
    VOYAGE_API_KEY: () => required('VOYAGE_API_KEY'),
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
};
