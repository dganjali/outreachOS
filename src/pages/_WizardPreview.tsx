// TEMPORARY visual-verification harness — not part of the app. Deleted after
// screenshotting. ?edit=1 opens edit mode (bundle fetch fails offline → empty
// overview, lets us see Overview + Calibrate without a backend).
import { PersonaWizard } from '../components/persona/PersonaWizard';

export function WizardPreview() {
  const edit = new URLSearchParams(window.location.search).get('edit') === '1';
  return (
    <div style={{ minHeight: '100vh', background: 'var(--paper)', padding: '40px 16px' }}>
      <PersonaWizard
        userId="preview-user"
        personaId={edit ? 'preview-persona' : undefined}
        importable={['Ran a 1,400-person developer conference', 'Backed by Vercel and Notion']}
        onDone={() => undefined}
        onCancel={() => undefined}
      />
    </div>
  );
}
