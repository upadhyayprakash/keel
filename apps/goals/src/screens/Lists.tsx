import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { matches, type ListSummary } from '../list';
import { Cover, Tags } from '../listUi';
import { go } from '../router';
import { Button, Card, Field, NotLive, ProgressBar, ScreenTitle } from '../ui';

// ADR 0005: every list, as cards with their cover. Search over name, description and tags;
// pinned lists first. Lists stay out of Today: you come here when you need one.

export function Lists() {
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const [lists, setLists] = useState<ListSummary[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);

  const load = useCallback(() => {
    setFailed(null);
    api<{ lists: ListSummary[] }>(`/api/lists?status=${status}`).then(
      (r) => setLists(r.lists),
      (e: Error) => setFailed(e.message),
    );
  }, [status]);
  useEffect(load, [load]);

  const tags = useMemo(() => [...new Set((lists ?? []).flatMap((l) => l.tags))].sort(), [lists]);
  const shown = (lists ?? []).filter((l) => matches(l, query) && (!tag || l.tags.includes(tag)));
  const back = () => go('today');

  return (
    <>
      <ScreenTitle title="Lists" sub={lists ? `${lists.length} ${status === 'archived' ? 'archived' : 'list'}${lists.length === 1 ? '' : 's'}` : undefined} onBack={back} />
      {failed ? <NotLive savedAt={null} onRetry={load} /> : null}

      <div className="list-toolbar">
        <Field label="Search" value={query} onChange={setQuery} placeholder="name, topic or tag" />
        <div className="choice-row" role="group" aria-label="Which lists">
          {(['active', 'archived'] as const).map((s) => (
            <button key={s} type="button" className={`choice${s === status ? ' choice-on' : ''}`} aria-pressed={s === status} onClick={() => setStatus(s)}>
              {s === 'active' ? 'Active' : 'Archived'}
            </button>
          ))}
          {tags.map((t) => (
            <button key={t} type="button" className={`choice${t === tag ? ' choice-on' : ''}`} aria-pressed={t === tag} onClick={() => setTag(t === tag ? null : t)}>
              #{t}
            </button>
          ))}
        </div>
      </div>

      {lists && shown.length === 0 ? (
        <Card>
          <h2>{lists.length ? 'No lists match' : status === 'archived' ? 'Nothing archived' : 'No lists yet'}</h2>
          <p className="sub">{lists.length ? 'Try another word or tag.' : status === 'archived' ? 'Finished lists you archive wait here.' : 'A plain list keeps things together. A tracked one counts what is done, and can be reset to use again.'}</p>
        </Card>
      ) : null}

      <ul className="list-grid">
        {shown.map((l) => (
          <li key={l.id}>
            <Card onOpen={() => go({ name: 'list', ref: l.ref })} label={`${l.name}: open the list`}>
              <Cover list={l} />
              <h2 className="list-name">
                {l.pinned ? <span className="pin" aria-label="Pinned">★ </span> : null}
                {l.name}
              </h2>
              <p className="sub">
                {l.ref} · {l.project}
              </p>
              {l.progress ? <ProgressBar done={l.progress.done} total={l.progress.total} label={l.progress.label} /> : <p className="sub">{l.itemCount} item{l.itemCount === 1 ? '' : 's'}</p>}
              <Tags tags={l.tags} />
            </Card>
          </li>
        ))}
      </ul>

      <div className="actions">
        <Button onClick={() => go('list-new')}>+ New list</Button>
      </div>
    </>
  );
}
