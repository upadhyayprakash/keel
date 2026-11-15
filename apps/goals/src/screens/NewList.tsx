import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { parseTags, splitLines, type List, type ListKind, type Target } from '../list';
import { go } from '../router';
import { Button, ChoiceChips, Field, ScreenTitle, StatusLine } from '../ui';

// ADR 0005: a name, plain or tracked, and a place. Everything else is optional and can be
// set later. The server checks it all again; its `field` puts an error where it belongs.

type Errors = Partial<Record<'name' | 'description' | 'tags' | 'items' | 'project', string>>;
const KINDS: Record<string, ListKind> = { Plain: 'plain', Tracked: 'tracked' };

export function NewList() {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ListKind>('plain');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [items, setItems] = useState('');
  const [project, setProject] = useState('personal');
  const [targets, setTargets] = useState<Target[]>([{ value: 'personal', label: 'Personal' }]);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    api<{ targets: Target[] }>('/api/lists/targets').then(
      (r) => setTargets(r.targets),
      () => undefined, // Personal still works; the save says if Keel is away.
    );
  }, []);

  const edit = (key: keyof Errors, set: (value: string) => void) => (value: string) => {
    set(value);
    if (errors[key]) setErrors({ ...errors, [key]: undefined });
  };

  async function save() {
    if (!name.trim()) return setErrors({ name: 'A list needs a name, like: D-mart groceries.' });
    setSaving(true);
    setFailure(null);
    try {
      const list = await api<List>('/api/lists', {
        body: { name, kind, description: description.trim() || null, tags: parseTags(tags), project, items: splitLines(items) },
      });
      go({ name: 'list', ref: list.ref }, { replace: true });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      const message = err.hint ? `${err.message} ${err.hint}` : err.message;
      if (err.field === 'name' || err.field === 'description' || err.field === 'tags' || err.field === 'items' || err.field === 'project') setErrors({ [err.field]: message });
      else setFailure(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <ScreenTitle title="New list" onBack={() => go('lists')} />
      <Field label="Name" value={name} onChange={edit('name', setName)} placeholder="D-mart groceries" error={errors.name} />
      <ChoiceChips
        label="Kind"
        options={Object.keys(KINDS)}
        value={kind === 'tracked' ? 'Tracked' : 'Plain'}
        onChange={(v) => setKind(KINDS[v]!)}
      />
      <p className="field-help kind-help">{kind === 'tracked' ? 'Each item can be open, doing, blocked or done. Shows "4 of 7 done", and can be reset to use again.' : 'Just the things, with no checkboxes. You can make it tracked later.'}</p>
      <Field label="About (optional)" value={description} onChange={edit('description', setDescription)} placeholder="What it is for" multiline error={errors.description} />
      <Field label="Tags (optional)" value={tags} onChange={edit('tags', setTags)} helper="Up to 5, to search by. Like: groceries, weekly" error={errors.tags} />
      <div className="field">
        <label htmlFor="list-project" className="field-label">
          Where
        </label>
        <select id="list-project" className="input" value={project} onChange={(e) => setProject(e.target.value)}>
          {targets.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        {errors.project ? <p className="field-error" role="alert">{errors.project}</p> : null}
      </div>
      <Field label="First items (optional)" value={items} onChange={edit('items', setItems)} helper="One per line" multiline error={errors.items} />
      {failure ? <StatusLine tone="late">{failure}</StatusLine> : null}
      <div className="actions">
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Create list'}
        </Button>
      </div>
    </form>
  );
}
