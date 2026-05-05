function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  ANTHROPIC_API_KEY: () => required('ANTHROPIC_API_KEY'),
  SUPABASE_URL: () => required('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: () => required('SUPABASE_SERVICE_ROLE_KEY'),
  ANTHROPIC_MODEL: () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
  APOLLO_API_KEY: () => process.env.APOLLO_API_KEY || null,
  ENCRYPTION_KEY: () => required('ENCRYPTION_KEY'),
  CRON_SECRET: () => process.env.CRON_SECRET || '',
  GOOGLE_CLIENT_ID: () => required('GOOGLE_CLIENT_ID'),
  GOOGLE_CLIENT_SECRET: () => required('GOOGLE_CLIENT_SECRET'),
};
