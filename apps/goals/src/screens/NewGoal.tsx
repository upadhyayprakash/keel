import { useState } from 'react';
import { api, ApiError } from '../api';
import { composePlan, type Goal, type NewGoal as NewGoalBody } from '../goal';
import { go } from '../router';
import { Button, Card, ChoiceChips, CueChip, Field, ScreenTitle, StatusChip, StepBar } from '../ui';

// Screens 02 and 03 (designs/SCREENS.md): the finish line, then the plan for the hard part.
// The server checks everything again (ADR 0004); its `field` puts an error back where it belongs.

type Draft = NewGoalBody['steps'][number];
type Errors = Partial<Record<'title' | 'doneMeans' | 'dueOn' | 'appetite' | 'obstacle' | 'then' | 'steps' | 'step', string>>;

const TIMES = ['1 week', '3 weeks', '6 weeks', 'Other'];

/** Today on this phone, `YYYY-MM-DD`, for the date picker's lower bound. The server decides in the end. */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function NewGoal() {
  const [page, setPage] = useState<1 | 2>(1);
  const [title, setTitle] = useState('');
  const [doneMeans, setDoneMeans] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [time, setTime] = useState<string | null>(null);
  const [otherTime, setOtherTime] = useState('');
  const [obstacle, setObstacle] = useState('');
  const [when, setWhen] = useState('');
  const [then, setThen] = useState('');
  const [steps, setSteps] = useState<Draft[]>([]);
  const [adding, setAdding] = useState<Draft>({ text: '', cueAt: null, cuePlace: null, minimum: null });
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const today = localToday();

  const appetite = time === 'Other' ? otherTime.trim() || null : time;

  /** A setter that also clears the error shown for that input, once the person edits it. */
  const edit = (key: keyof Errors, set: (value: string) => void) => (value: string) => {
    set(value);
    if (errors[key]) setErrors({ ...errors, [key]: undefined });
  };

  function next() {
    const e: Errors = {};
    if (!title.trim()) e.title = 'A goal needs a name, like: Run 5 km.';
    if (!doneMeans.trim()) e.doneMeans = 'Say what done looks like, something you could check.';
    if (!dueOn) e.dueOn = 'Pick a deadline.';
    else if (dueOn < today) e.dueOn = 'The deadline is in the past.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setPage(2);
    window.scrollTo(0, 0);
  }

  function addStep() {
    if (!adding.text.trim()) {
      setErrors({ ...errors, step: 'Write the step first.' });
      return;
    }
    setSteps([...steps, { text: adding.text.trim(), cueAt: adding.cueAt || null, cuePlace: adding.cuePlace?.trim() || null, minimum: adding.minimum?.trim() || null }]);
    setAdding({ text: '', cueAt: null, cuePlace: null, minimum: null });
    setErrors({ ...errors, step: undefined, steps: undefined });
  }

  async function start() {
    const e: Errors = {};
    if (!obstacle.trim()) e.obstacle = 'Name one thing that could get in the way.';
    if (!then.trim()) e.then = 'Add what you will do, so the plan can fire.';
    if (!steps.length) e.steps = 'Add at least one step. Make the first one take under 10 minutes.';
    setErrors(e);
    if (Object.keys(e).length) return;

    setSaving(true);
    setFailure(null);
    try {
      const body: NewGoalBody = { title, doneMeans, dueOn, appetite, obstacle, plan: composePlan(when || obstacle, then), steps };
      await api<Goal>('/api/goals', { body });
      go('today', { replace: true });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      // Put the server's answer next to the field it is about.
      const message = err.hint ? `${err.message} ${err.hint}` : err.message;
      if (err.field === 'title' || err.field === 'doneMeans' || err.field === 'dueOn') {
        setErrors({ [err.field]: message });
        setPage(1);
      } else if (err.field === 'plan') setErrors({ then: message });
      else if (err.field === 'steps') setErrors({ steps: message });
      else setFailure(message);
    } finally {
      setSaving(false);
    }
  }

  if (page === 1) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          next();
        }}
      >
        <ScreenTitle title="New goal" sub="Step 1 of 2" onBack={() => go('today')} />
        <StepBar step={1} total={2} />
        <Field label="Goal" value={title} onChange={edit('title', setTitle)} placeholder="Run 5 km without stopping" error={errors.title} />
        <Field label="Done means..." helper="How will you know it is finished?" value={doneMeans} onChange={edit('doneMeans', setDoneMeans)} placeholder="I run 5 km in one go" multiline error={errors.doneMeans} />
        <Field label="Deadline" type="date" min={today} value={dueOn} onChange={edit('dueOn', setDueOn)} error={errors.dueOn} />
        <ChoiceChips label="Time you will give it" options={TIMES} value={time} onChange={(v) => setTime(v === time ? null : v)} />
        {time === 'Other' ? <Field label="How much time?" value={otherTime} onChange={setOtherTime} placeholder="30 minutes a day" /> : null}
        <Button type="submit">Next: plan for the hard part</Button>
      </form>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <ScreenTitle title="New goal" sub="Step 2 of 2" onBack={() => setPage(1)} />
      <StepBar step={2} total={2} />
      <Field label="What is most likely to stop you?" value={obstacle} onChange={edit('obstacle', setObstacle)} placeholder="Rainy mornings" error={errors.obstacle} />

      <fieldset className="plan-card">
        <legend className="field-label">Your plan</legend>
        <label className="plan-line">
          <span>If</span>
          <input className="input" value={when} onChange={(e) => setWhen(e.target.value)} placeholder={obstacle.trim() || 'it is raining at 7:00'} />
        </label>
        <label className="plan-line">
          <span>then I will</span>
          <input
            className={`input${errors.then ? ' input-error' : ''}`}
            value={then}
            onChange={(e) => edit('then', setThen)(e.target.value)}
            placeholder="do 20 minutes on the treadmill"
            aria-invalid={errors.then ? true : undefined}
            aria-describedby={errors.then ? 'plan-error' : undefined}
          />
        </label>
        {errors.then ? (
          <p id="plan-error" className="field-error" role="alert">
            {errors.then}
          </p>
        ) : (
          <p className="field-help">Needed to save.</p>
        )}
      </fieldset>

      <h2 className="field-label">Steps</h2>
      {steps.length ? (
        <ol className="draft-steps">
          {steps.map((st, i) => (
            <li key={i}>
              <span className="box" aria-hidden="true" />
              <div>
                <span>{st.text}</span> {i === 0 ? <StatusChip>first tiny step</StatusChip> : null} <CueChip cueAt={st.cueAt} place={st.cuePlace} today={today} />
                {st.minimum ? <p className="field-help">Minimum version: {st.minimum}</p> : null}
              </div>
              <button type="button" className="remove" aria-label={`Remove step: ${st.text}`} onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      {errors.steps ? (
        <p className="field-error" role="alert">
          {errors.steps}
        </p>
      ) : null}

      <Card>
        <Field label={steps.length ? 'Add a step' : 'First step (under 10 minutes)'} value={adding.text} onChange={edit('step', (text) => setAdding({ ...adding, text }))} placeholder={steps.length ? 'Run 1 km at the park' : 'Put my running shoes by the door'} error={errors.step} />
        <Field label="When (optional)" type="datetime-local" value={adding.cueAt ?? ''} onChange={(cueAt) => setAdding({ ...adding, cueAt })} />
        <Field label="Where (optional)" value={adding.cuePlace ?? ''} onChange={(cuePlace) => setAdding({ ...adding, cuePlace })} placeholder="the park" />
        <Field label="Minimum version for a bad day (optional)" value={adding.minimum ?? ''} onChange={(minimum) => setAdding({ ...adding, minimum })} placeholder="walk 10 minutes" />
        <Button variant="outline" onClick={addStep}>
          + Add step
        </Button>
      </Card>

      {failure ? (
        <p className="field-error" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="actions">
        <Button type="submit" disabled={saving}>
          {saving ? 'Starting...' : 'Start goal'}
        </Button>
      </div>
    </form>
  );
}
