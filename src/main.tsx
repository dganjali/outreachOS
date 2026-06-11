import React from 'react';
import ReactDOM from 'react-dom/client';
// Legacy global styles first; the new Tailwind/shadcn layer loads LAST so its
// design tokens (--primary, --border, --ring, --radius, etc.) win over the
// legacy OKLCH duplicates during the page-by-page migration.
import './index.css';
import './styles/globals.css';
import App from './App';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

