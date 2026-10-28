import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { authState, goSignIn, needsSignIn, unreachable } from './api';
import { useRoute } from './router';
import { GoalDetail } from './screens/GoalDetail';
import { NewGoal } from './screens/NewGoal';
import { Today } from './screens/Today';
import { Header } from './ui';

// Dev only: /goals/#gallery shows every shared component. Vite drops this from production builds.
const Gallery = import.meta.env.DEV ? lazy(() => import('./Gallery').then((m) => ({ default: m.Gallery }))) : null;

/**
 * Opens the app once Keel says this phone may: no login set up, or a Goals session.
 * Otherwise it leaves for the sign-in page, which comes back here (ADR 0002).
 * When Keel is not reachable, it opens anyway: the screens show what this phone last saw.
 */
function Gate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'open' | { error: string }>('checking');
  useEffect(() => {
    authState().then(
      (s) => (needsSignIn(s) ? goSignIn() : setState('open')),
      (e: Error) => setState(unreachable(e) ? 'open' : { error: e.message }),
    );
  }, []);
  if (state === 'open') return <>{children}</>;
  if (typeof state === 'object') return <p className="muted">{state.error}</p>;
  return null;
}

function Screen() {
  const route = useRoute();
  if (route.name === 'new') return <NewGoal />;
  if (route.name === 'goal') return <GoalDetail key={route.ref} goalRef={route.ref} />;
  return <Today />;
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
