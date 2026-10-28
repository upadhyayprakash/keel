import { useState } from 'react';
import type { ThemeName } from '@keel/core/ui';
import { formatDay, daysLeft } from './format';
import { applyTheme, systemTheme } from './theme';
import { Button, Card, CheckButton, Checkbox, ChoiceChips, CueChip, Field, ProgressBar, ScreenTitle, StatusChip, StatusLine, StepBar } from './ui';

// Dev only (`pnpm dev:goals`, then /goals/#gallery): every shared component in the
// states the screens use, to check against designs/SCREENS.md in light and dark.
// Production builds leave this file out.

const TODAY = '2026-10-16';

export function Gallery() {
  const [theme, setTheme] = useState<ThemeName>(systemTheme());
  const [checked, setChecked] = useState(false);
  const [title, setTitle] = useState('Run 5K without stopping');
  const [then, setThen] = useState('');
  const [time, setTime] = useState<string | null>('3 weeks');
  const [steps, setSteps] = useState([false, false]);
  const flip = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    setTheme(next);
  };

  return (
    <main className="body">
      <ScreenTitle title="Components" sub={`dev gallery · ${theme}`} />
      <Button variant="outline" onClick={flip}>
        Switch to {theme === 'light' ? 'dark' : 'light'}
      </Button>

      <h2 className="gallery-head">01 · Today card</h2>
      <Card onOpen={() => {}} label="Run 5K without stopping">
        <h2>Run 5K without stopping</h2>
        <p className="sub">
          due {formatDay('2026-11-08', TODAY)} · {daysLeft('2026-11-08', TODAY)}
        </p>
        <ProgressBar done={4} total={12} label="4 of 12 done" />
        <div className="next">
          <div>
            <p className="sub">Next:</p>
            <p className="next-step">Run 2 km at the park</p>
            <CueChip cueAt="2026-10-16T07:00" place="park" today={TODAY} />
          </div>
          <CheckButton checked={checked} label="Run 2 km at the park" onCheck={() => setChecked(true)} />
        </div>
        <StatusLine tone="wait">Ravi is following this goal</StatusLine>
      </Card>
      <Card>
        <h2>Clear out the spare room</h2>
        <p className="sub">
          due {formatDay('2026-10-26', TODAY)} · {daysLeft('2026-10-26', TODAY)}
        </p>
        <ProgressBar done={9} total={11} label="2 left" />
        <StatusLine tone="today">Missed yesterday: do the 10-minute version today</StatusLine>
      </Card>

      <h2 className="gallery-head">02 · New goal, step 1</h2>
      <StepBar step={1} total={2} />
      <Field label="Goal" value={title} onChange={setTitle} />
      <Field label="Done means..." helper="How will you know it is finished?" value="" placeholder="I run 5 km in one go" onChange={() => {}} multiline />
      <Field label="Deadline" type="date" value="2026-11-08" onChange={() => {}} />
      <ChoiceChips label="Time you will give it" options={['1 week', '3 weeks', '6 weeks', 'Other']} value={time} onChange={setTime} />
      <Button>Next: plan for the hard part</Button>

      <h2 className="gallery-head">03 · Steps and errors</h2>
      <StepBar step={2} total={2} />
      <Checkbox
        checked={steps[0]!}
        onChange={(v) => setSteps([v, steps[1]!])}
        label={
          <>
            Buy running shoes <StatusChip>first tiny step</StatusChip> <CueChip cueAt={null} place="Fri after work" today={TODAY} />
          </>
        }
      />
      <Checkbox
        checked={steps[1]!}
        onChange={(v) => setSteps([steps[0]!, v])}
        label={
          <>
            Run 1 km at the park <CueChip cueAt="2026-10-17T07:00" place="park" today={TODAY} />
          </>
        }
      />
      <Field label="Your plan" value={then} placeholder="then I will..." onChange={setThen} error={then ? null : 'Add what you will do, so the plan can fire.'} />
      <StatusChip tone="today">Missed yesterday</StatusChip>

      <h2 className="gallery-head">04 · Partner and buttons</h2>
      <Card tint="wait">
        <strong>Partner: Ravi</strong>
        <p className="sub">last note 2 days ago: Nice start, keep the Saturday run!</p>
      </Card>
      <div className="button-row">
        <Button variant="outline">Close goal</Button>
        <Button>+ Add step</Button>
      </div>
      <Button variant="link">I'll skip it</Button>
    </main>
  );
}
