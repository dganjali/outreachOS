import type { SupabaseClient } from '@supabase/supabase-js';

export type AgentType = 'targeting' | 'contacts' | 'evidence' | 'sequence' | 'reply';
export type RunStatus = 'running' | 'completed' | 'failed';

export interface AgentRunRow {
  id: string;
  user_id: string;
  mission_id: string | null;
  target_id: string | null;
  contact_id: string | null;
  agent_type: AgentType;
  status: RunStatus;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export async function startRun(
  client: SupabaseClient,
  args: {
    user_id: string;
    agent_type: AgentType;
    mission_id?: string | null;
    target_id?: string | null;
    contact_id?: string | null;
    input?: Record<string, unknown>;
  }
): Promise<AgentRunRow> {
  const { data, error } = await client
    .from('agent_runs')
    .insert({
      user_id: args.user_id,
      agent_type: args.agent_type,
      mission_id: args.mission_id ?? null,
      target_id: args.target_id ?? null,
      contact_id: args.contact_id ?? null,
      input: args.input ?? null,
      status: 'running',
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as AgentRunRow;
}

export async function completeRun(
  client: SupabaseClient,
  id: string,
  output: Record<string, unknown>
) {
  await client
    .from('agent_runs')
    .update({ status: 'completed', output, completed_at: new Date().toISOString() })
    .eq('id', id);
}

export async function failRun(client: SupabaseClient, id: string, error: string) {
  await client
    .from('agent_runs')
    .update({ status: 'failed', error, completed_at: new Date().toISOString() })
    .eq('id', id);
}
