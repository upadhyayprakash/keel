import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { authState, goSignIn, needsSignIn } from './api';
import { useRoute } from './router';
import { NewGoal } from './screens/NewGoal';
import { Today } from './screens/Today';
import { Header } from './ui';

// Dev only: /goals/#gallery shows every shared component. Vite drops this from production builds.
const Gallery = import.meta.env.DEV ? lazy(() => import('./Gallery').then((m) => ({ default: m.Gallery }))) : null;

/**
 * Opens the app once Keel says this phone may: no login set up, or a Goals session.
 * Otherwise it leaves for the sign-in page, which comes back here (ADR 0002).
 */
function Gate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'open' | 'offline'>('checking');
  useEffect(() => {
    authState().then(
      (s) => (needsSignIn(s) ? goSignIn() : setState('open')),
      () => setState('offline'),
    );
  }, []);
  if (state === 'open') return <>{children}</>;
  if (state === 'offline') return <p className="muted">Keel is not reachable. Is keel serve running on your computer?</p>;
  return null;
}

function Screen() {
  const route = useRoute();
  return route.name === 'new' ? <NewGoal /> : <Today />;
}

export function App() {
  const gallery = Gallery && window.location.hash === '#gallery';
  return (
    <div className="screen">
      <Header />
      <main className="body">
        {gallery ? (
          <Suspense fallback={null}>
            <Gallery />
          </Suspense>
        ) : (
          <Gate>
            <Screen />
          </Gate>
        )}
      </main>
    </div>
  );
}
