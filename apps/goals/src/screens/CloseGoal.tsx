import { useCallback, useEffect, useState } from 'react';
import { api, unreachable } from '../api';
import { planVsTookText, type CloseReview, type Goal } from '../goal';
import { closeGoal, goalByRef, loadGoals } from '../lastSeen';
import { go } from '../router';
import { Button, Field, NotLive, ScreenTitle, StatusLine } from '../ui';

// Screen 06 (designs/SCREENS.md): close as done or dropped on purpose, then the three
// review questions, the same as `keel goal done` (ADR 0004). Closing needs Keel live:
// there are no offline writes (ADR 0003), so a not-live copy only shows why.

type Outcome = CloseReview['outcome'];

const OUTCOMES: Array<{ value: Outcome; label: string; help: string }> = [
  { value: 'done', label: 'Done', help: 'I reached the finish line.' },
  { value: 'dropped', label: 'Dropped on purpose', help: 'I chose to stop.' },
];

interface View {
  goal: Goal;
  today: string;
  live: boolean;
}

export function CloseGoal({ goalRef }: { goalRef: string }) {
  const [view, setView] = useState<View | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [happened, setHappened] = useState('');
  const [why, setWhy] = useState('');
  const [change, setChange] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setFailed(null);
    (async () => {
      const loaded = await loadGoals();
      if (!loaded.live) {
        const goal = loaded.list && goalByRef(loaded.list.goals, goalRef);
        if (!goal) return setFailed(loaded.error.message);
        return setView({ goal, today: loaded.list!.today, live: false });
      }
      const goal = goalByRef(loaded.list.goals, goalRef) ?? (await api<Goal>(`/api/goals/${encodeURIComponent(goalRef)}`));
      setView({ goal, today: loaded.list.today, live: true });
    })().catch((e: Error) => setFailed(e.message));
  }, [goalRef]);
  useEffect(load, [load]);

  const back = () => go({ name: 'goal', ref: goalRef });

  async function save() {
    if (!view) return;
    if (!outcome) return setError('Choose done or dropped on purpose.');
    setSaving(true);
    setError(null);
    try {
      await closeGoal(view.goal, { outcome, happened, why, change });
      go({ name: 'goal', ref: view.goal.ref }, { replace: true });
    } catch (e) {
      setError(unreachable(e) ? 'Keel is not reachable, so the goal is not closed. Your answers are still here: try again once keel serve is running.' : (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (failed)
    return (
      <>
        <ScreenTitle title="Close goal" onBack={back} />
        <p className="muted">{failed}</p>
      </>
    );
  if (!view) return null;
  const { goal, today, live } = view;

  if (goal.status !== 'active')
    return (
      <>
        <ScreenTitle title="Close goal" sub={goal.title} onBack={back} />
        <StatusLine tone={goal.status === 'done' ? 'done' : 'today'}>This goal is already {goal.status}. A closed goal stays closed.</StatusLine>
      </>
    );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <ScreenTitle title="Close goal" sub={goal.title} onBack={back} />
      {live ? null : <NotLive savedAt={null} onRetry={load} />}

      <fieldset className="choices">
        <legend className="field-label">How did it end?</legend>
        <div className="outcome-cards" role="radiogroup">
          {OUTCOMES.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={outcome === o.value}
              aria-label={o.label}
              className={`card outcome${outcome === o.value ? ' outcome-on' : ''}`}
              onClick={() => {
                setOutcome(o.value);
                setError(null);
              }}
            >
              <strong>{o.label}</strong>
              <span className="field-help">{o.help}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <p className="plan-vs-took">{planVsTookText(goal, today)}</p>

      <Field label="What happened, against the plan?" value={happened} onChange={setHappened} multiline />
      <Field label="Why?" value={why} onChange={setWhy} multiline />
      <Field label="What will you change next time?" value={change} onChange={setChange} multiline />
      <p className="field-help">Your answers help pad the deadline of your next goal.</p>

      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="actions">
        <Button type="submit" disabled={saving || !live}>
          {saving ? 'Saving...' : 'Close and save review'}
        </Button>
      </div>
    </form>
  );
}
