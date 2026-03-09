export type OnboardingStep = 1 | 2 | 3 | 4;

export interface Profile {
  id: string;
  user_id: string;
  name: string | null;
  role: string | null;
  organization: string | null;
  bio: string | null;
  resume_url: string | null;
  linkedin_url: string | null;
  website: string | null;
  portfolio_links: string[] | null;
  proof_points: string | null;
  achievements: string | null;
  metrics: string | null;
  example_emails: string | null;
  writing_tone: string | null;
  onboarding_step: number;
  onboarding_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Mission {
  id: string;
  user_id: string;
  name: string;
  goal: string;
  target_description: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface Target {
  id: string;
  mission_id: string;
  company_name: string;
  created_at: string;
}

export interface Contact {
  id: string;
  target_id: string;
  name: string;
  role: string;
  email: string;
  created_at: string;
}

export interface EmailDraft {
  id: string;
  contact_id: string;
  subject: string;
  body: string;
  status: string;
  created_at: string;
}

export interface Reply {
  id: string;
  contact_id: string;
  status: string;
  notes: string | null;
  created_at: string;
}
