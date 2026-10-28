import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Gate, Pair, safeNext, SignIn } from './auth';
import './styles.css';

/** /pair and /signin are the login pages (ADR 0002); everything else is the browser terminal. */
function Page() {
  const path = window.location.pathname;
  if (path === '/pair') return <Pair />;
  if (path === '/signin') {
    const params = new URLSearchParams(window.location.search);
    return <SignIn scope={params.get('scope') === 'terminal' ? 'terminal' : 'goals'} next={safeNext(params.get('next'))} />;
  }
  return (
    <Gate>
      <App />
    </Gate>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
