import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { daysLeft, formatDay } from '../format';
import type { Goal } from '../goal';
import { goalByRef, loadGoals, markStepDone, notMarked } from '../lastSeen';
import { go } from '../router';
import { Checkbox, CueChip, NotLive, ProgressBar, ScreenTitle, StatusChip, StatusLine } from '../ui';

// Screen 04 (designs/SCREENS.md): the finish line, progress, the plan, the open steps
// to tick, then the done ones. The partner card, "Close goal" and "+ Add step" come
// with slices 05 and 06. Not live, it shows the last-seen copy like Today.

/** Done steps shown before "Show all". */
const DONE_SHOWN = 3;

interface View {
  goal: Goal;
  today: string;
  savedAt: string | null;
}

export function GoalDetail({ goalRef }: { goalRef: string }) {
  const [view, setView] = useState<View | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [allDone, setAllDone] = useState(false);

  const load = useCallback(() => {
    setFailed(null);
    (async () => {
      const loaded = await loadGoals();
      if (!loaded.live) {
        const goal = loaded.list && goalByRef(loaded.list.goals, goalRef);
        if (!goal) return setFailed(loaded.list ? `${loaded.error.message} This phone has not seen goal ${goalRef} yet.` : loaded.error.message);
        return setView({ goal, today: loaded.list!.today, savedAt: loaded.list!.savedAt });
      }
      // Today lists active goals; a closed one comes from its own route.
      const goal = goalByRef(loaded.list.goals, goalRef) ?? (await api<Goal>(`/api/goals/${encodeURIComponent(goalRef)}`));
      setView({ goal, today: loaded.list.today, savedAt: null });
    })().catch((e: Error) => setFailed(e.message));
  }, [goalRef]);
  useEffect(load, [load]);

  async function check(position: number) {
    if (!view) return;
    setBusy(true);
    setProblem(null);
    try {
      const goal = await markStepDone(view.goal, position);
      if (view.savedAt) return load();
      setView({ ...view, goal });
    } catch (e) {
      setProblem(notMarked(e));
    } finally {
      setBusy(false);
    }
  }

  const back = () => go('today');
  if (failed)
    return (
      <>
        <ScreenTitle title="Goal" onBack={back} />
        <p className="muted">{failed}</p>
      </>
    );
  if (!view) return null;
  const { goal, today, savedAt } = view;
  const open = goal.steps.filter((s) => s.status === 'open');
  const done = goal.steps.filter((s) => s.status === 'done');
  const shown = allDone ? done : done.slice(-DONE_SHOWN);
  const active = goal.status === 'active';
  const due = active ? `due ${formatDay(goal.dueOn, today)} · ${daysLeft(goal.dueOn, today)}` : `was due ${formatDay(goal.dueOn, today)}`;

  return (
    <>
      <ScreenTitle title={goal.title} sub={[due, goal.appetite].filter(Boolean).join(' · ')} onBack={back} />
      {savedAt ? <NotLive savedAt={savedAt} onRetry={load} /> : null}
      {active ? null : (
        <StatusLine tone={goal.status === 'done' ? 'done' : 'today'}>
          {goal.status === 'done' ? 'Done' : 'Dropped on purpose'}
          {goal.closedAt ? ` on ${formatDay(goal.closedAt.slice(0, 10), today)}` : ''}
        </StatusLine>
      )}
      <p className="done-means">
        <strong>Done means:</strong> {goal.doneMeans}
      </p>
      <ProgressBar done={goal.progress.done} total={goal.progress.total} label={goal.progress.label} />

      <section className="plan-card plan-show">
        <h2 className="field-label">Plan</h2>
        <p>{goal.plan}</p>
      </section>

      {open.length ? (
        <section aria-labelledby="next-head">
          <h2 id="next-head" className="group-head">
            Next
          </h2>
          <ul className="step-list">
            {open.map((s) => (
              <li key={s.position}>
                <Checkbox
                  checked={false}
                  disabled={busy || !active}
                  onChange={() => check(s.position)}
                  label={
                    <>
                      <span className="step-text">{s.text}</span>
                      <span className="step-chips">
                        <CueChip cueAt={s.cueAt} place={s.cuePlace} today={today} />
                        {s.firstStep ? <StatusChip>first tiny step</StatusChip> : null}
                      </span>
                      {s.minimum ? <span className="field-help step-min">Minimum version: {s.minimum}</span> : null}
                    </>
                  }
                />
              </li>
            ))}
          </ul>
          {problem ? <StatusLine tone="late">{problem}</StatusLine> : null}
        </section>
      ) : active ? (
        <p className="sub all-done">All steps done. Close the goal from your computer: goal done {goal.ref}</p>
      ) : null}

      {done.length ? (
        <section aria-labelledby="done-head">
          <h2 id="done-head" className="group-head">
            Done
          </h2>
          <ul className="done-list">
            {shown.map((s) => (
              <li key={s.position}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 12.5l4 4 8-9" />
                </svg>
                <span>{s.text}</span>
              </li>
            ))}
          </ul>
          {done.length > DONE_SHOWN ? (
            <button type="button" className="btn btn-link show-all" onClick={() => setAllDone(!allDone)} aria-expanded={allDone}>
              {allDone ? 'Show fewer' : `Show all ${done.length}`}
            </button>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
