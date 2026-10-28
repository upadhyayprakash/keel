import { useCallback, useEffect, useState } from 'react';
import { daysLeft, formatDay } from '../format';
import { nextStep, type Goal } from '../goal';
import { loadGoals, markStepDone, notMarked, type Loaded } from '../lastSeen';
import { go } from '../router';
import { Button, Card, CheckButton, CueChip, NotLive, ProgressBar, ScreenTitle, StatusLine } from '../ui';

// Screen 01 (designs/SCREENS.md): the date, then one card per active goal with its
// progress and next step, which the round button marks done; the card opens the goal (04).
// When Keel is not reachable, the last-seen goals show under a not-live line.
// The partner and missed-day lines come with slices 05 and 03.

export function Today() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ id: string; message: string } | null>(null);

  const load = useCallback(() => {
    setFailed(null);
    loadGoals().then(setLoaded, (e: Error) => setFailed(e.message));
  }, []);
  useEffect(load, [load]);

  async function check(goal: Goal, position: number) {
    setBusy(goal.id);
    setProblem(null);
    try {
      const updated = await markStepDone(goal, position);
      if (!loaded?.live) return load();
      setLoaded({ live: true, list: { ...loaded.list, goals: loaded.list.goals.map((g) => (g.id === updated.id ? updated : g)) } });
    } catch (e) {
      setProblem({ id: goal.id, message: notMarked(e) });
    } finally {
      setBusy(null);
    }
  }

  if (failed) return <p className="muted">{failed}</p>;
  if (!loaded) return null;
  if (!loaded.list) return <NotLive savedAt={null} onRetry={load} />;
  const { today, goals } = loaded.list;
  const count = goals.length;

  return (
    <>
      <ScreenTitle title="Today" sub={`${formatDay(today, today)} · ${count} active goal${count === 1 ? '' : 's'}`} />
      {loaded.live ? null : <NotLive savedAt={loaded.list.savedAt} onRetry={load} />}
      {count === 0 ? (
        <Card>
          <h2>No goals yet</h2>
          <p className="sub">Pick one small thing you want done in a few weeks. Keel asks what done looks like, what could get in the way, and the first tiny step.</p>
        </Card>
      ) : (
        goals.map((g) => {
          const next = nextStep(g);
          return (
            <Card key={g.id} onOpen={() => go({ name: 'goal', ref: g.ref })} label={`${g.title}: open the goal`}>
              <h2>{g.title}</h2>
              <p className="sub">
                due {formatDay(g.dueOn, today)} · {daysLeft(g.dueOn, today)}
              </p>
              <ProgressBar done={g.progress.done} total={g.progress.total} label={g.progress.label} />
              {next ? (
                <div className="next">
                  <div>
                    <p className="sub">Next:</p>
                    <p className="next-step">{next.text}</p>
                    <CueChip cueAt={next.cueAt} place={next.cuePlace} today={today} />
                  </div>
                  <CheckButton checked={false} label={next.text} busy={busy === g.id} onCheck={() => check(g, next.position)} />
                </div>
              ) : (
                <p className="next sub">All steps done. Close the goal from your computer: goal done {g.ref}</p>
              )}
              {problem?.id === g.id ? <StatusLine tone="late">{problem.message}</StatusLine> : null}
            </Card>
          );
        })
      )}
      <div className="actions">
        <Button onClick={() => go('new')} disabled={!loaded.live}>
          + New goal
        </Button>
      </div>
    </>
  );
}
