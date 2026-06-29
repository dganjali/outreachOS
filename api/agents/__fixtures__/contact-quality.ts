// Labeled, offline fixtures for the contact-quality eval (see
// contacts.quality.test.ts). Each case is a real-ish mission + a recorded set of
// LinkedIn SERP results, with the names that are CORRECT contacts for that
// mission labeled. No network / LLM: the harness feeds these straight through
// serpResultToSuggestion → rankCandidates so the deterministic "right person"
// core is what's measured.
//
// Authoring rules (keep the eval honest):
//  - `right` = on-function, within the size-relative band, current, not a
//    router/gatekeeper. Every case has ≥3 of them so precision@3 is well-defined.
//  - everyone else is a deliberate distractor the engine SHOULD keep out of the
//    top of the list: off-function execs, above-cap execs, former/ex employees,
//    in-house recruiters (for sourcing), or wrong-team people.
//  - `extraFunctions` mimics what the per-mission ICP synthesizer would add for
//    this audience (e.g. "robotics"). Audience-level only — never tuned to an
//    individual candidate.

import type { MissionMode, SizeTier } from '../../../shared/types';

export interface SerpFixture {
  title: string; // verbatim LinkedIn SERP title: "Name - Role - Company | LinkedIn"
  link: string;
  snippet: string;
}

export interface QualityCase {
  id: string;
  mode: MissionMode;
  geo?: string | null;
  companyName: string;
  sizeTier: SizeTier | null;
  extraFunctions?: string[];
  serp: SerpFixture[];
  right: string[]; // names (first token of the title) that are correct
}

const li = (slug: string) => `https://www.linkedin.com/in/${slug}`;

export const CONTACT_QUALITY_CASES: QualityCase[] = [
  // ----------------------------- SPONSORSHIP -----------------------------
  {
    id: 'sponsorship-enterprise-bank',
    mode: 'sponsorship',
    companyName: 'Big Bank',
    sizeTier: 'enterprise',
    serp: [
      { title: 'Manny Okafor - Senior Community Investment Manager - Big Bank | LinkedIn', link: li('manny-okafor'), snippet: 'Community investment and sponsorships at Big Bank.' },
      { title: 'Dina Roy - Director, Sponsorships and Community Investment - Big Bank | LinkedIn', link: li('dina-roy'), snippet: 'Leads sponsorship strategy and community partnerships.' },
      { title: 'Paula Greene - Community Programs Manager - Big Bank | LinkedIn', link: li('paula-greene'), snippet: 'Runs community grant programs and event sponsorships.' },
      { title: 'Reggie Stone - Regional President - Big Bank | LinkedIn', link: li('reggie-stone'), snippet: 'Regional President, Personal & Commercial Banking.' },
      { title: 'Glenda Marsh - Global Chief Marketing Officer - Big Bank | LinkedIn', link: li('glenda-marsh'), snippet: 'CMO. Brand, advertising and marketing.' },
      { title: 'Frank Hale - Former Head of Community - Big Bank | LinkedIn', link: li('frank-hale'), snippet: 'Former Head of Community at Big Bank; now advising startups.' },
    ],
    right: ['Manny', 'Dina', 'Paula'],
  },
  {
    id: 'sponsorship-large-saas',
    mode: 'sponsorship',
    extraFunctions: ['developer relations', 'developer advocacy'],
    companyName: 'CloudScale',
    sizeTier: 'large',
    serp: [
      { title: 'Tara Quinn - Developer Relations Manager - CloudScale | LinkedIn', link: li('tara-quinn'), snippet: 'DevRel and developer community programs.' },
      { title: 'Owen Park - Senior Developer Advocate - CloudScale | LinkedIn', link: li('owen-park'), snippet: 'Developer advocacy, hackathons and sponsorships.' },
      { title: 'Nadia Bloom - Director of Community - CloudScale | LinkedIn', link: li('nadia-bloom'), snippet: 'Owns the developer community and event sponsorship budget.' },
      { title: 'Greg Lin - VP of Sales - CloudScale | LinkedIn', link: li('greg-lin'), snippet: 'Leads global sales.' },
      { title: 'Helen Tsai - Chief Technology Officer - CloudScale | LinkedIn', link: li('helen-tsai'), snippet: 'CTO. Platform and infrastructure.' },
      { title: 'Ivan Cole - Ex-Community Manager - CloudScale | LinkedIn', link: li('ivan-cole'), snippet: 'Formerly Community Manager at CloudScale.' },
    ],
    right: ['Tara', 'Owen', 'Nadia'],
  },
  {
    id: 'sponsorship-startup-devtool',
    mode: 'sponsorship',
    extraFunctions: ['developer relations'],
    companyName: 'DevToolCo',
    sizeTier: 'startup',
    serp: [
      { title: 'Hannah West - Head of Developer Relations - DevToolCo | LinkedIn', link: li('hannah-west'), snippet: 'Leads DevRel and community at DevToolCo.' },
      { title: 'Cory Adler - Community Manager - DevToolCo | LinkedIn', link: li('cory-adler'), snippet: 'Developer community, events and sponsorships.' },
      { title: 'Devi Rao - Developer Advocate - DevToolCo | LinkedIn', link: li('devi-rao'), snippet: 'Developer advocacy and hackathon partnerships.' },
      { title: 'Vince Holt - VP of Finance - DevToolCo | LinkedIn', link: li('vince-holt'), snippet: 'Finance and accounting.' },
      { title: 'Ferdinand Cho - Former Developer Advocate - DevToolCo | LinkedIn', link: li('ferdinand-cho'), snippet: 'Former Developer Advocate, now at another company.' },
    ],
    right: ['Hannah', 'Cory', 'Devi'],
  },
  {
    id: 'sponsorship-mid-fintech',
    mode: 'sponsorship',
    companyName: 'PayMid',
    sizeTier: 'mid',
    serp: [
      { title: 'Aisha Khan - Events and Sponsorship Manager - PayMid | LinkedIn', link: li('aisha-khan'), snippet: 'Runs event sponsorships and brand partnerships.' },
      { title: 'Bruno Lima - Partnerships Manager - PayMid | LinkedIn', link: li('bruno-lima'), snippet: 'Brand partnerships and ecosystem.' },
      { title: 'Carol Webb - Director, Brand and Community - PayMid | LinkedIn', link: li('carol-webb'), snippet: 'Brand, community and sponsorship strategy.' },
      { title: 'Derek Voss - Chief Financial Officer - PayMid | LinkedIn', link: li('derek-voss'), snippet: 'CFO.' },
      { title: 'Elaine Fox - SVP, Operations - PayMid | LinkedIn', link: li('elaine-fox'), snippet: 'Senior Vice President of Operations.' },
      { title: 'Gita Nair - Retired Marketing Director - PayMid | LinkedIn', link: li('gita-nair'), snippet: 'Retired. Former Marketing Director.' },
    ],
    right: ['Aisha', 'Bruno', 'Carol'],
  },

  // -------------------------------- BD -----------------------------------
  {
    id: 'bd-enterprise-cloud',
    mode: 'bd',
    companyName: 'MegaCloud',
    sizeTier: 'enterprise',
    serp: [
      { title: 'Sara Pine - Strategic Partnerships Manager - MegaCloud | LinkedIn', link: li('sara-pine'), snippet: 'Strategic partnerships and alliances.' },
      { title: 'Tom Reyes - Director of Business Development - MegaCloud | LinkedIn', link: li('tom-reyes'), snippet: 'Leads BD and integrations partnerships.' },
      { title: 'Uma Patel - Senior Alliances Manager - MegaCloud | LinkedIn', link: li('uma-patel'), snippet: 'Technology alliances and ecosystem partnerships.' },
      { title: 'Victor Hahn - Chief Revenue Officer - MegaCloud | LinkedIn', link: li('victor-hahn'), snippet: 'CRO.' },
      { title: 'Wendy Cross - VP of Engineering - MegaCloud | LinkedIn', link: li('wendy-cross'), snippet: 'Engineering leadership.' },
      { title: 'Xavier Mund - Former Partnerships Director - MegaCloud | LinkedIn', link: li('xavier-mund'), snippet: 'Former Partnerships Director at MegaCloud.' },
    ],
    right: ['Sara', 'Tom', 'Uma'],
  },
  {
    id: 'bd-mid-marketplace',
    mode: 'bd',
    companyName: 'MarketGo',
    sizeTier: 'mid',
    serp: [
      { title: 'Yara Sol - Partnerships Manager - MarketGo | LinkedIn', link: li('yara-sol'), snippet: 'Partnerships and integrations.' },
      { title: 'Zane Ott - Business Development Manager - MarketGo | LinkedIn', link: li('zane-ott'), snippet: 'BD and ecosystem deals.' },
      { title: 'Amir Daud - Director, Corporate Development - MarketGo | LinkedIn', link: li('amir-daud'), snippet: 'Corporate development and strategic partnerships.' },
      { title: 'Bea Lund - Chief Executive Officer - MarketGo | LinkedIn', link: li('bea-lund'), snippet: 'CEO and co-founder.' },
      { title: 'Cleo Marsh - Senior Designer - MarketGo | LinkedIn', link: li('cleo-marsh'), snippet: 'Product design.' },
      { title: 'Dan Pike - Ex-Head of Partnerships - MarketGo | LinkedIn', link: li('dan-pike'), snippet: 'Formerly Head of Partnerships at MarketGo.' },
    ],
    right: ['Yara', 'Zane', 'Amir'],
  },
  {
    id: 'bd-large-infra',
    mode: 'bd',
    companyName: 'InfraNet',
    sizeTier: 'large',
    serp: [
      { title: 'Ella Voss - Alliances Manager - InfraNet | LinkedIn', link: li('ella-voss'), snippet: 'Technology alliances.' },
      { title: 'Finn Roe - Senior Partnerships Manager - InfraNet | LinkedIn', link: li('finn-roe'), snippet: 'Strategic partnerships and ecosystem.' },
      { title: 'Gwen Aoki - Director, Strategic Partnerships - InfraNet | LinkedIn', link: li('gwen-aoki'), snippet: 'Leads strategic partnerships.' },
      { title: 'Hugo Bell - President, International - InfraNet | LinkedIn', link: li('hugo-bell'), snippet: 'President of international operations.' },
      { title: 'Iris Lund - Chief Marketing Officer - InfraNet | LinkedIn', link: li('iris-lund'), snippet: 'CMO.' },
      { title: 'Jed Park - Office Coordinator - InfraNet | LinkedIn', link: li('jed-park'), snippet: 'Administrative coordinator.' },
    ],
    right: ['Ella', 'Finn', 'Gwen'],
  },

  // ----------------------------- RECRUITING ------------------------------
  {
    id: 'recruiting-robotics-research',
    mode: 'recruiting',
    extraFunctions: ['robotics', 'perception', 'controls'],
    companyName: 'RoboLab',
    sizeTier: 'mid',
    serp: [
      { title: 'Kai Mori - Staff Robotics Engineer - RoboLab | LinkedIn', link: li('kai-mori'), snippet: 'Robotics, perception and controls.' },
      { title: 'Lena Fox - Senior Machine Learning Engineer - RoboLab | LinkedIn', link: li('lena-fox'), snippet: 'Machine learning for robot perception.' },
      { title: 'Milo Sant - Robotics Research Engineer - RoboLab | LinkedIn', link: li('milo-sant'), snippet: 'Research engineer working on manipulation and controls.' },
      { title: 'Nora Vance - Technical Recruiter - RoboLab | LinkedIn', link: li('nora-vance'), snippet: 'Technical recruiter hiring robotics engineers.' },
      { title: 'Otis Bell - VP of Sales - RoboLab | LinkedIn', link: li('otis-bell'), snippet: 'Sales leadership.' },
      { title: 'Pia Gust - Former Staff Engineer - RoboLab | LinkedIn', link: li('pia-gust'), snippet: 'Formerly Staff Engineer at RoboLab.' },
    ],
    right: ['Kai', 'Lena', 'Milo'],
  },
  {
    id: 'recruiting-ml-startup',
    mode: 'recruiting',
    extraFunctions: ['machine learning', 'nlp'],
    companyName: 'NimbusAI',
    sizeTier: 'startup',
    serp: [
      { title: 'Quinn Ash - Senior Machine Learning Engineer - NimbusAI | LinkedIn', link: li('quinn-ash'), snippet: 'ML and NLP systems.' },
      { title: 'Remy Cole - Staff Software Engineer - NimbusAI | LinkedIn', link: li('remy-cole'), snippet: 'Backend and ML infrastructure.' },
      { title: 'Sage Doan - Machine Learning Engineer - NimbusAI | LinkedIn', link: li('sage-doan'), snippet: 'Applied machine learning and data.' },
      { title: 'Tess Rao - Talent Acquisition Partner - NimbusAI | LinkedIn', link: li('tess-rao'), snippet: 'Talent acquisition and sourcing.' },
      { title: 'Uli Frost - Chief Executive Officer - NimbusAI | LinkedIn', link: li('uli-frost'), snippet: 'CEO and co-founder.' },
      { title: 'Vera Lin - Former ML Engineer - NimbusAI | LinkedIn', link: li('vera-lin'), snippet: 'Former Machine Learning Engineer at NimbusAI.' },
    ],
    right: ['Quinn', 'Remy', 'Sage'],
  },
  {
    id: 'recruiting-data-large',
    mode: 'recruiting',
    extraFunctions: ['data engineering', 'analytics'],
    companyName: 'DataForge',
    sizeTier: 'large',
    serp: [
      { title: 'Will Roe - Senior Data Engineer - DataForge | LinkedIn', link: li('will-roe'), snippet: 'Data engineering and pipelines.' },
      { title: 'Xena Pike - Staff Data Scientist - DataForge | LinkedIn', link: li('xena-pike'), snippet: 'Data science and analytics.' },
      { title: 'Yusuf Adel - Data Platform Lead - DataForge | LinkedIn', link: li('yusuf-adel'), snippet: 'Leads the data platform team.' },
      { title: 'Zoe Hart - Director of People - DataForge | LinkedIn', link: li('zoe-hart'), snippet: 'HR and people operations.' },
      { title: 'Abe Tan - Chief Financial Officer - DataForge | LinkedIn', link: li('abe-tan'), snippet: 'CFO.' },
      { title: 'Bo Frey - Sourcer - DataForge | LinkedIn', link: li('bo-frey'), snippet: 'Technical sourcer and recruiter.' },
    ],
    right: ['Will', 'Xena', 'Yusuf'],
  },

  // ----------------------------- INTERNSHIP ------------------------------
  {
    id: 'internship-eng-mid',
    mode: 'internship',
    extraFunctions: ['software'],
    companyName: 'AppWorks',
    sizeTier: 'mid',
    serp: [
      { title: 'Cara Im - Engineering Manager - AppWorks | LinkedIn', link: li('cara-im'), snippet: 'Manages the platform engineering team and interns.' },
      { title: 'Dale Ng - Software Engineering Lead - AppWorks | LinkedIn', link: li('dale-ng'), snippet: 'Leads a backend engineering team.' },
      { title: 'Esha Rao - University Recruiter - AppWorks | LinkedIn', link: li('esha-rao'), snippet: 'University and early career recruiting.' },
      { title: 'Fritz Lo - Chief Executive Officer - AppWorks | LinkedIn', link: li('fritz-lo'), snippet: 'CEO.' },
      { title: 'Gabe Mun - VP of Marketing - AppWorks | LinkedIn', link: li('gabe-mun'), snippet: 'Marketing leadership.' },
      { title: 'Hana Ott - Former Recruiter - AppWorks | LinkedIn', link: li('hana-ott'), snippet: 'Former recruiter at AppWorks.' },
    ],
    right: ['Cara', 'Dale', 'Esha'],
  },
  {
    id: 'internship-eng-large',
    mode: 'internship',
    extraFunctions: ['software'],
    companyName: 'BuildBox',
    sizeTier: 'large',
    serp: [
      { title: 'Ivy Sun - Senior Software Engineer - BuildBox | LinkedIn', link: li('ivy-sun'), snippet: 'Senior engineer, mentors interns.' },
      { title: 'Jack Reed - Engineering Team Lead - BuildBox | LinkedIn', link: li('jack-reed'), snippet: 'Leads an engineering team.' },
      { title: 'Kira Vale - Early Career Recruiter - BuildBox | LinkedIn', link: li('kira-vale'), snippet: 'Early career and university recruiting.' },
      { title: 'Liam Foy - Chief Operating Officer - BuildBox | LinkedIn', link: li('liam-foy'), snippet: 'COO.' },
      { title: 'Mara Kid - SVP, Engineering - BuildBox | LinkedIn', link: li('mara-kid'), snippet: 'Senior Vice President of Engineering.' },
      { title: 'Nash Orr - Retired Engineer - BuildBox | LinkedIn', link: li('nash-orr'), snippet: 'Retired software engineer.' },
    ],
    right: ['Ivy', 'Jack', 'Kira'],
  },
  {
    id: 'internship-startup',
    mode: 'internship',
    extraFunctions: ['software'],
    companyName: 'TinySeed',
    sizeTier: 'startup',
    serp: [
      { title: 'Owen Tate - Software Engineering Lead - TinySeed | LinkedIn', link: li('owen-tate'), snippet: 'Leads engineering at TinySeed.' },
      { title: 'Pearl Ng - Senior Software Engineer - TinySeed | LinkedIn', link: li('pearl-ng'), snippet: 'Full-stack engineer.' },
      { title: 'Quincy Bel - Engineering Manager - TinySeed | LinkedIn', link: li('quincy-bel'), snippet: 'Engineering manager and hiring lead.' },
      { title: 'Rosa Lim - Head of Sales - TinySeed | LinkedIn', link: li('rosa-lim'), snippet: 'Sales.' },
      { title: 'Sven Aas - Former Intern - TinySeed | LinkedIn', link: li('sven-aas'), snippet: 'Former software intern at TinySeed.' },
    ],
    right: ['Owen', 'Pearl', 'Quincy'],
  },

  // -------------------------------- SALES --------------------------------
  {
    id: 'sales-ops-enterprise',
    mode: 'sales',
    extraFunctions: ['supply chain', 'logistics'],
    companyName: 'GlobalRetail',
    sizeTier: 'enterprise',
    serp: [
      { title: 'Tara Bell - Director of Operations - GlobalRetail | LinkedIn', link: li('tara-bell'), snippet: 'Owns supply chain and logistics operations.' },
      { title: 'Umar Sy - Senior Operations Manager - GlobalRetail | LinkedIn', link: li('umar-sy'), snippet: 'Operations and logistics.' },
      { title: 'Vivi Lor - Supply Chain Manager - GlobalRetail | LinkedIn', link: li('vivi-lor'), snippet: 'Supply chain planning.' },
      { title: 'Wes Pratt - Chief Executive Officer - GlobalRetail | LinkedIn', link: li('wes-pratt'), snippet: 'CEO.' },
      { title: 'Xia Ten - Global Chief Operating Officer - GlobalRetail | LinkedIn', link: li('xia-ten'), snippet: 'Global COO.' },
      { title: 'Yon Cole - Former Operations Director - GlobalRetail | LinkedIn', link: li('yon-cole'), snippet: 'Former Operations Director at GlobalRetail.' },
    ],
    right: ['Tara', 'Umar', 'Vivi'],
  },
  {
    id: 'sales-growth-mid',
    mode: 'sales',
    extraFunctions: ['growth marketing'],
    companyName: 'GrowEasy',
    sizeTier: 'mid',
    serp: [
      { title: 'Ada Lim - Growth Manager - GrowEasy | LinkedIn', link: li('ada-lim'), snippet: 'Growth marketing and revenue operations.' },
      { title: 'Ben Roy - Director of Growth - GrowEasy | LinkedIn', link: li('ben-roy'), snippet: 'Owns growth and demand generation.' },
      { title: 'Cleo Ade - Senior Marketing Manager - GrowEasy | LinkedIn', link: li('cleo-ade'), snippet: 'Marketing and growth.' },
      { title: 'Dex Hall - Chief Revenue Officer - GrowEasy | LinkedIn', link: li('dex-hall'), snippet: 'CRO.' },
      { title: 'Evan Lux - Executive Assistant to the CEO - GrowEasy | LinkedIn', link: li('evan-lux'), snippet: 'EA to the CEO.' },
      { title: 'Fawn Oye - Ex-Growth Manager - GrowEasy | LinkedIn', link: li('fawn-oye'), snippet: 'Formerly Growth Manager at GrowEasy.' },
    ],
    right: ['Ada', 'Ben', 'Cleo'],
  },
  {
    id: 'sales-it-large',
    mode: 'sales',
    extraFunctions: ['information technology', 'it operations'],
    companyName: 'HealthCorp',
    sizeTier: 'large',
    serp: [
      { title: 'Gil Mora - IT Operations Manager - HealthCorp | LinkedIn', link: li('gil-mora'), snippet: 'IT operations and infrastructure.' },
      { title: 'Hira Sol - Director of Information Technology - HealthCorp | LinkedIn', link: li('hira-sol'), snippet: 'Owns IT systems.' },
      { title: 'Ike Tan - Senior IT Manager - HealthCorp | LinkedIn', link: li('ike-tan'), snippet: 'IT service management.' },
      { title: 'Jana Vey - Chief Information Officer - HealthCorp | LinkedIn', link: li('jana-vey'), snippet: 'CIO.' },
      { title: 'Koa Rin - President, Hospital Division - HealthCorp | LinkedIn', link: li('koa-rin'), snippet: 'Division President.' },
      { title: 'Lia Ott - Retired IT Director - HealthCorp | LinkedIn', link: li('lia-ott'), snippet: 'Retired. Former IT Director.' },
    ],
    right: ['Gil', 'Hira', 'Ike'],
  },
  {
    id: 'sales-geo-toronto',
    mode: 'sales',
    geo: 'Toronto, Canada',
    extraFunctions: ['operations'],
    companyName: 'NorthOps',
    sizeTier: 'mid',
    serp: [
      { title: 'Mateo Ruiz - Operations Manager - NorthOps | LinkedIn', link: li('mateo-ruiz'), snippet: 'Operations manager based in Toronto, Canada.' },
      { title: 'Nina Patel - Director of Operations - NorthOps | LinkedIn', link: li('nina-patel'), snippet: 'Operations leader in Toronto, ON.' },
      { title: 'Omar Said - Senior Operations Manager - NorthOps | LinkedIn', link: li('omar-said'), snippet: 'Operations, Toronto, Canada.' },
      { title: 'Petra Voss - Chief Financial Officer - NorthOps | LinkedIn', link: li('petra-voss'), snippet: 'CFO, Toronto.' },
      { title: 'Quill Reed - VP of Sales - NorthOps | LinkedIn', link: li('quill-reed'), snippet: 'Sales leadership.' },
      { title: 'Rafe Lund - Former Operations Manager - NorthOps | LinkedIn', link: li('rafe-lund'), snippet: 'Former Operations Manager at NorthOps.' },
    ],
    right: ['Mateo', 'Nina', 'Omar'],
  },

  // --------------------------- HARD / EDGE CASES -------------------------
  // Truncated SERP titles (no company segment) — parser must still pull the role.
  {
    id: 'hard-truncated-titles',
    mode: 'sponsorship',
    companyName: 'TruncCorp',
    sizeTier: 'enterprise',
    serp: [
      { title: 'Manny Okafor - Senior Community Investment Manager', link: li('h-manny'), snippet: 'Community investment and sponsorships.' },
      { title: 'Dina Roy - Director, Community Partnerships', link: li('h-dina'), snippet: 'Community partnerships and sponsorship.' },
      { title: 'Paula Greene - Community Programs Manager', link: li('h-paula'), snippet: 'Community grant programs and events.' },
      { title: 'Reggie Stone - Chief Marketing Officer', link: li('h-reggie'), snippet: 'CMO.' },
      { title: 'Frank Hale - Former Head of Community', link: li('h-frank'), snippet: 'Former Head of Community.' },
    ],
    right: ['Manny', 'Dina', 'Paula'],
  },
  // "VP" appears mid-title on a NON-exec (a manager who supports the VP org).
  // The real owner (a manager) must still beat the actual VP.
  {
    id: 'hard-vp-substring',
    mode: 'bd',
    companyName: 'Edgely',
    sizeTier: 'mid',
    serp: [
      { title: 'Gwen Aoki - Partnerships Manager, VP Sales Org - Edgely | LinkedIn', link: li('h-gwen'), snippet: 'Partnerships manager supporting the VP Sales organization.' },
      { title: 'Finn Roe - Senior Partnerships Manager - Edgely | LinkedIn', link: li('h-finn'), snippet: 'Strategic partnerships and alliances.' },
      { title: 'Uma Patel - Director of Business Development - Edgely | LinkedIn', link: li('h-uma'), snippet: 'Leads business development.' },
      { title: 'Victor Hahn - VP of Partnerships - Edgely | LinkedIn', link: li('h-victor'), snippet: 'Vice President of Partnerships.' },
      { title: 'Wendy Cross - Chief Revenue Officer - Edgely | LinkedIn', link: li('h-wendy'), snippet: 'CRO.' },
    ],
    right: ['Gwen', 'Finn', 'Uma'],
  },
  // Thin on-function pool (only 2 on-function) mixed with an off-function in-band
  // manager — the gate intentionally does NOT fire, but the two owners must still
  // rank above the off-function manager.
  {
    id: 'hard-thin-onfunction',
    mode: 'recruiting',
    extraFunctions: ['robotics'],
    companyName: 'ThinRobo',
    sizeTier: 'mid',
    serp: [
      { title: 'Kai Mori - Staff Robotics Engineer - ThinRobo | LinkedIn', link: li('h-kai'), snippet: 'Robotics and controls.' },
      { title: 'Lena Fox - Senior Robotics Engineer - ThinRobo | LinkedIn', link: li('h-lena'), snippet: 'Robotics perception.' },
      { title: 'Sal Vint - Senior Marketing Manager - ThinRobo | LinkedIn', link: li('h-sal'), snippet: 'Marketing and brand.' },
      { title: 'Otis Bell - Chief Executive Officer - ThinRobo | LinkedIn', link: li('h-otis'), snippet: 'CEO.' },
    ],
    right: ['Kai', 'Lena'],
  },
  // "Ex-" prefix directly in the title (not the snippet).
  {
    id: 'hard-ex-prefix',
    mode: 'sponsorship',
    extraFunctions: ['developer relations'],
    companyName: 'ExCorp',
    sizeTier: 'large',
    serp: [
      { title: 'Tara Quinn - Developer Relations Manager - ExCorp | LinkedIn', link: li('h-tara'), snippet: 'DevRel programs.' },
      { title: 'Owen Park - Senior Developer Advocate - ExCorp | LinkedIn', link: li('h-owen'), snippet: 'Developer advocacy and sponsorships.' },
      { title: 'Nadia Bloom - Director of Community - ExCorp | LinkedIn', link: li('h-nadia'), snippet: 'Owns the community program.' },
      { title: 'Ivan Cole - Ex-Director of Community - ExCorp | LinkedIn', link: li('h-ivan'), snippet: 'Previously Director of Community at ExCorp.' },
      { title: 'Greg Lin - VP of Sales - ExCorp | LinkedIn', link: li('h-greg'), snippet: 'Sales.' },
    ],
    right: ['Tara', 'Owen', 'Nadia'],
  },
];
