import { useEffect, useState } from 'react';
import { api } from '../api';
import { daysLeft, formatDay } from '../format';
import type { Goal } from '../goal';
import { go } from '../router';
import { Button, Card, ProgressBar, ScreenTitle } from '../ui';

// Screen 01 (designs/SCREENS.md). This phase: the date, the active goals with their
// progress, the empty state and "+ New goal". The next step with its check button,
// the last-seen copy and the not-live state come with 04.4.

export function Today() {
  const [data, setData] = useState<{ today: string; goals: Goal[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ today: string; goals: Goal[] }>('/api/goals').then(setData, (e: Error) => setError(e.message));
  }, []);

  if (error) return <p className="muted">{error}</p>;
  if (!data) return null;
  const { today, goals } = data;
  const count = goals.length;

  return (
    <>
      <ScreenTitle title="Today" sub={`${formatDay(today, today)} · ${count} active goal${count === 1 ? '' : 's'}`} />
      {count === 0 ? (
        <Card>
          <h2>No goals yet</h2>
          <p className="sub">Pick one small thing you want done in a few weeks. Keel asks what done looks like, what could get in the way, and the first tiny step.</p>
        </Card>
      ) : (
        goals.map((g) => (
          <Card key={g.id}>
            <h2>{g.title}</h2>
            <p className="sub">
              due {formatDay(g.dueOn, today)} · {daysLeft(g.dueOn, today)}
            </p>
            <ProgressBar done={g.progress.done} total={g.progress.total} label={g.progress.label} />
          </Card>
        ))
      )}
      <div className="actions">
        <Button onClick={() => go('new')}>+ New goal</Button>
      </div>
    </>
  );
}
