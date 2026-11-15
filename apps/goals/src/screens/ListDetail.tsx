import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { api, ApiError } from '../api';
import {
  afterIdAt,
  insertIndex,
  isComplete,
  parseTags,
  readCoverFile,
  shownItems,
  SORTS,
  splitLines,
  STATE_LABEL,
  STATES,
  type ItemState,
  type List,
  type ListItem,
  type ListKind,
  type Target,
  type ViewSort,
} from '../list';
import { Confirm, Cover, Section, StateChip, Tags } from '../listUi';
import { go } from '../router';
import { Button, Card, Checkbox, Field, NotLive, ProgressBar, ScreenTitle, StatusLine } from '../ui';

// ADR 0005: one list. A plain list shows its items alone; a tracked one gives each item a state
// and counts them. Order is stored (manual) and dragging changes only the dragged row; the sort
// chips only change how the list is shown. A phone can drag with a finger, and the handle also
// answers the arrow keys. Everything saves at once, through the same rules as the CLI.

interface Drag {
  id: string;
  from: number;
  to: number;
  /** How far the pointer has moved down from where it started. */
  dy: number;
}

export function ListDetail({ listRef }: { listRef: string }) {
  const [list, setList] = useState<List | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  const [drag, setDrag] = useState<Drag | null>(null);
  // Where the rows were when the drag began (page coordinates), and where the pointer was.
  const origin = useRef<{ mids: number[]; startY: number } | null>(null);
  const path = `/api/lists/${encodeURIComponent(listRef)}`;

  const load = useCallback(() => {
    setFailed(null);
    api<List>(path).then(setList, (e: Error) => setFailed(e.message));
  }, [path]);
  useEffect(load, [load]);

  /** Runs a change that answers with the list; shows what went wrong in words, and looks again after a conflict. */
  async function act(request: Promise<List>): Promise<boolean> {
    setBusy(true);
    setProblem(null);
    try {
      setList(await request);
      return true;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      setProblem(e.hint ? `${e.message} ${e.hint}` : e.message);
      if (e.status === 409 || e.status === 404) load();
      return false;
    } finally {
      setBusy(false);
    }
  }

  const back = () => go('lists');
  if (failed) {
    return (
      <>
        <ScreenTitle title="List" onBack={back} />
        <NotLive savedAt={null} onRetry={load} />
        <p className="muted">{failed}</p>
      </>
    );
  }
  if (!list) return null;

  const tracked = list.kind === 'tracked';
  const manual = list.viewSort === 'manual';
  const items = manual ? list.items : shownItems(list);
  const complete = isComplete(list);
  const patchList = (body: Record<string, unknown>) => act(api<List>(path, { method: 'PATCH', body }));
  const patchItem = (id: string, body: Record<string, unknown>) => act(api<List>(`${path}/items/${id}`, { method: 'PATCH', body }));
  const moveItem = (id: string, afterId: string | null) => act(api<List>(`${path}/items/${id}/move`, { body: { afterId } }));

  async function add() {
    const texts = splitLines(adding);
    if (!texts.length) return;
    if (await act(api<List>(`${path}/items`, { body: { texts } }))) setAdding('');
  }

  // ---- dragging ----

  function startDrag(e: PointerEvent<HTMLButtonElement>, id: string) {
    if (busy) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rows = [...(e.currentTarget.closest('ul')?.children ?? [])] as HTMLElement[];
    origin.current = { mids: rows.map((row) => row.getBoundingClientRect().top + window.scrollY + row.offsetHeight / 2), startY: e.pageY };
    const from = list!.items.findIndex((i) => i.id === id);
    setDrag({ id, from, to: from, dy: 0 });
  }

  function moveDrag(e: PointerEvent<HTMLButtonElement>) {
    if (!drag || !origin.current) return;
    setDrag({ ...drag, to: insertIndex(origin.current.mids, e.pageY, drag.from), dy: e.pageY - origin.current.startY });
  }

  function endDrag(commit: boolean) {
    const d = drag;
    setDrag(null);
    origin.current = null;
    if (commit && d && d.to !== d.from) void moveItem(d.id, afterIdAt(list!.items.map((i) => i.id), d.id, d.to));
  }

  function keyMove(e: KeyboardEvent<HTMLButtonElement>, id: string) {
    const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (!step || busy) return;
    e.preventDefault();
    const from = list!.items.findIndex((i) => i.id === id);
    const to = from + step;
    if (to < 0 || to >= list!.items.length) return;
    void moveItem(id, afterIdAt(list!.items.map((i) => i.id), id, to));
  }

  const others = drag ? list.items.filter((i) => i.id !== drag.id) : [];
  const before = drag && drag.to < others.length ? others[drag.to]?.id : undefined;
  const afterLast = drag && drag.to >= others.length ? others.at(-1)?.id : undefined;

  return (
    <>
      <ScreenTitle title={list.name} sub={`${list.ref} · ${list.project}${list.status === 'archived' ? ' · archived' : ''}`} onBack={back} />
      <Cover list={list} large />
      {list.description ? <p className="list-about">{list.description}</p> : null}
      <Tags tags={list.tags} />
      {list.status === 'archived' ? (
        <div className="archived-note">
          <StatusLine tone="today">Archived. It is hidden from your lists.</StatusLine>
          <Button variant="outline" disabled={busy} onClick={() => patchList({ status: 'active' })}>
            Bring it back
          </Button>
        </div>
      ) : null}
      {tracked ? <ProgressBar done={list.progress?.done ?? 0} total={list.progress?.total ?? 0} label={list.progress?.label ?? ''} /> : null}

      {complete ? (
        <Card>
          <h2>All {list.items.length} done</h2>
          <p className="sub">Use it again, or finish with it.</p>
          <div className="button-row complete-row">
            <Confirm label="Reset it" sure="Yes, reset" disabled={busy} onConfirm={() => act(api<List>(`${path}/reset`, { body: {} }))} />
            <Button variant="outline" disabled={busy} onClick={() => patchList({ status: 'archived' })}>
              Archive it
            </Button>
          </div>
        </Card>
      ) : null}

      <div className="choice-row sort-row" role="group" aria-label="Show items">
        {SORTS.filter((s) => tracked || s.value !== 'state').map((s) => (
          <button key={s.value} type="button" className={`choice${s.value === list.viewSort ? ' choice-on' : ''}`} aria-pressed={s.value === list.viewSort} disabled={busy} onClick={() => patchList({ viewSort: s.value })}>
            {s.label}
          </button>
        ))}
      </div>
      {!manual ? <p className="field-help">Sorted for now. Switch to Manual to drag items into your own order.</p> : null}

      {items.length === 0 ? <p className="sub empty">Empty. Add the first item below.</p> : null}
      <ul className={`items${drag ? ' items-dragging' : ''}`}>
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            tracked={tracked}
            canDrag={manual && items.length > 1}
            expanded={openItem === item.id}
            busy={busy}
            dragging={drag?.id === item.id ? drag : null}
            markBefore={before === item.id}
            markAfter={afterLast === item.id}
            onToggle={() => setOpenItem(openItem === item.id ? null : item.id)}
            onState={(state) => patchItem(item.id, { state })}
            onSave={(text, note) => patchItem(item.id, { text, note: note || null })}
            onRemove={async () => {
              if (await act(api<List>(`${path}/items/${item.id}`, { method: 'DELETE' }))) setOpenItem(null);
            }}
            onDragStart={(e) => startDrag(e, item.id)}
            onDragMove={moveDrag}
            onDragEnd={endDrag}
            onKey={(e) => keyMove(e, item.id)}
          />
        ))}
      </ul>

      <form
        className="add-item"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Field label="Add items" value={adding} onChange={setAdding} placeholder="milk" helper="One per line: paste a whole list to add it all" multiline />
        <Button type="submit" disabled={busy || !adding.trim()}>
          Add
        </Button>
      </form>
      {problem ? <StatusLine tone="late">{problem}</StatusLine> : null}

      <div className="list-actions">
        <Button variant="outline" disabled={busy} onClick={() => patchList({ pinned: !list.pinned })}>
          {list.pinned ? '★ Unpin' : '☆ Pin to the top'}
        </Button>
        {tracked && !complete && list.items.some((i) => i.state !== 'open') ? <Confirm label="Reset all to open" sure="Yes, reset" disabled={busy} onConfirm={() => act(api<List>(`${path}/reset`, { body: {} }))} /> : null}
        {list.status === 'active' ? (
          <Button variant="outline" disabled={busy} onClick={() => patchList({ status: 'archived' })}>
            Archive
          </Button>
        ) : null}
      </div>
      {list.resetCount ? <p className="field-help">Reset {list.resetCount} time{list.resetCount === 1 ? '' : 's'}.</p> : null}

      <Section title="Edit list">
        <EditList key={list.updatedAt} list={list} busy={busy} onSave={patchList} />
      </Section>
      <Section title="Cover">
        <CoverEditor list={list} busy={busy} onSet={(body) => act(api<List>(`${path}/cover`, { method: 'PUT', body }))} onClear={() => act(api<List>(`${path}/cover`, { method: 'DELETE' }))} />
      </Section>
      <Section title="Move to another project">
        <MoveList list={list} busy={busy} onMove={(project) => act(api<List>(`${path}/move`, { body: { project } }))} />
      </Section>
      <Section title="Delete">
        <p className="field-help">Removes the list and its items. Your daily backups from before still have them. To keep it but hide it, archive it.</p>
        <Confirm
          label="Delete this list"
          sure="Yes, delete it"
          disabled={busy}
          onConfirm={async () => {
            setBusy(true);
            try {
              await api(path, { method: 'DELETE' });
              go('lists', { replace: true });
            } catch (e) {
              if (!(e instanceof ApiError)) throw e;
              setProblem(e.message);
              setBusy(false);
            }
          }}
        />
      </Section>
    </>
  );
}

// ---- one item ----

interface RowProps {
  item: ListItem;
  tracked: boolean;
  canDrag: boolean;
  expanded: boolean;
  busy: boolean;
  dragging: Drag | null;
  markBefore: boolean;
  markAfter: boolean;
  onToggle: () => void;
  onState: (state: ItemState) => void;
  onSave: (text: string, note: string) => void;
  onRemove: () => void;
  onDragStart: (e: PointerEvent<HTMLButtonElement>) => void;
  onDragMove: (e: PointerEvent<HTMLButtonElement>) => void;
  onDragEnd: (commit: boolean) => void;
  onKey: (e: KeyboardEvent<HTMLButtonElement>) => void;
}

function ItemRow(p: RowProps) {
  const { item, tracked } = p;
  const done = tracked && item.state === 'done';
  const text = (
    <>
      <span className={`item-text${done ? ' item-done' : ''}`}>{item.text}</span>
      {item.note ? <span className="field-help item-note">{item.note}</span> : null}
      {tracked ? <StateChip state={item.state} /> : null}
    </>
  );
  return (
    <li className={`item${p.dragging ? ' item-lifted' : ''}${p.markBefore ? ' drop-before' : ''}${p.markAfter ? ' drop-after' : ''}`} style={p.dragging ? { transform: `translateY(${p.dragging.dy}px)` } : undefined}>
      <div className="item-main">
        {p.canDrag ? (
          <button
            type="button"
            className="handle"
            aria-label={`Move ${item.text}. Drag it, or press the up and down arrows.`}
            onPointerDown={p.onDragStart}
            onPointerMove={p.onDragMove}
            onPointerUp={() => p.onDragEnd(true)}
            onPointerCancel={() => p.onDragEnd(false)}
            onKeyDown={p.onKey}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" />
            </svg>
          </button>
        ) : null}
        {tracked ? (
          <Checkbox checked={item.state === 'done'} disabled={p.busy} onChange={(on) => p.onState(on ? 'done' : 'open')} label={text} />
        ) : (
          <span className="plain-item">
            <span className="bullet" aria-hidden="true">
              ·
            </span>
            <span className="plain-text">{text}</span>
          </span>
        )}
        <button type="button" className="more" aria-expanded={p.expanded} aria-label={`Edit ${item.text}`} onClick={p.onToggle}>
          ⋯
        </button>
      </div>
      {p.expanded ? <ItemEditor item={item} tracked={tracked} busy={p.busy} onState={p.onState} onSave={p.onSave} onRemove={p.onRemove} /> : null}
    </li>
  );
}

function ItemEditor({ item, tracked, busy, onState, onSave, onRemove }: Pick<RowProps, 'item' | 'tracked' | 'busy' | 'onState' | 'onSave' | 'onRemove'>) {
  const [text, setText] = useState(item.text);
  const [note, setNote] = useState(item.note ?? '');
  return (
    <div className="item-editor">
      {tracked ? (
        <div className="choice-row" role="group" aria-label="State">
          {STATES.map((s) => (
            <button key={s} type="button" className={`choice${s === item.state ? ' choice-on' : ''}`} aria-pressed={s === item.state} disabled={busy || s === item.state} onClick={() => onState(s)}>
              {STATE_LABEL[s]}
            </button>
          ))}
        </div>
      ) : null}
      <Field label="Item" value={text} onChange={setText} />
      <Field label="Note (optional)" value={note} onChange={setNote} />
      <div className="button-row">
        <Button disabled={busy || !text.trim() || (text === item.text && note === (item.note ?? ''))} onClick={() => onSave(text, note)}>
          Save
        </Button>
        <Confirm label="Remove" sure="Yes, remove" disabled={busy} onConfirm={onRemove} />
      </div>
    </div>
  );
}

// ---- the list itself ----

function EditList({ list, busy, onSave }: { list: List; busy: boolean; onSave: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [name, setName] = useState(list.name);
  const [description, setDescription] = useState(list.description ?? '');
  const [tags, setTags] = useState(list.tags.join(', '));
  const [kind, setKind] = useState<ListKind>(list.kind);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({ name, description: description.trim() || null, tags: parseTags(tags), kind });
      }}
    >
      <Field label="Name" value={name} onChange={setName} />
      <Field label="About" value={description} onChange={setDescription} multiline />
      <Field label="Tags" value={tags} onChange={setTags} helper="Up to 5, to search by" />
      <div className="choice-row" role="group" aria-label="Kind">
        {(['plain', 'tracked'] as const).map((k) => (
          <button key={k} type="button" className={`choice${k === kind ? ' choice-on' : ''}`} aria-pressed={k === kind} onClick={() => setKind(k)}>
            {k === 'plain' ? 'Plain' : 'Tracked'}
          </button>
        ))}
      </div>
      <p className="field-help">Switching loses nothing: a tracked list keeps its item states while it is plain.</p>
      <Button type="submit" disabled={busy || !name.trim()}>
        Save changes
      </Button>
    </form>
  );
}

function CoverEditor({ list, busy, onSet, onClear }: { list: List; busy: boolean; onSet: (body: { kind: 'svg' | 'png'; data: string; dark?: string }) => Promise<boolean>; onClear: () => Promise<boolean> }) {
  const [light, setLight] = useState<{ kind: 'svg' | 'png'; data: string; name: string } | null>(null);
  const [dark, setDark] = useState<{ kind: 'svg' | 'png'; data: string; name: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function pick(file: File | undefined, set: typeof setLight) {
    setProblem(null);
    if (!file) return set(null);
    const cover = await readCoverFile(file);
    if (!cover) {
      set(null);
      return setProblem('Use an SVG or a PNG file, up to 200 KB.');
    }
    set({ ...cover, name: file.name });
  }

  async function save() {
    if (!light) return;
    if (dark && dark.kind !== light.kind) return setProblem('The light and dark images must both be SVG, or both PNG.');
    if (await onSet({ kind: light.kind, data: light.data, ...(dark ? { dark: dark.data } : {}) })) {
      setLight(null);
      setDark(null);
    }
  }

  return (
    <div>
      <p className="field-help">
        {list.cover ? `Your own ${list.cover.kind.toUpperCase()} cover${list.cover.dark ? ', light and dark' : ''}.` : 'The built-in cover is showing.'} An SVG or PNG, up to 200 KB. Choosing a new one replaces it.
      </p>
      <label className="field-label" htmlFor="cover-light">
        Image
      </label>
      <input id="cover-light" type="file" accept="image/svg+xml,image/png,.svg,.png" onChange={(e) => void pick(e.target.files?.[0], setLight)} />
      <label className="field-label" htmlFor="cover-dark">
        Dark theme image (optional)
      </label>
      <input id="cover-dark" type="file" accept="image/svg+xml,image/png,.svg,.png" onChange={(e) => void pick(e.target.files?.[0], setDark)} />
      {problem ? <StatusLine tone="late">{problem}</StatusLine> : null}
      <div className="button-row">
        <Button disabled={busy || !light} onClick={() => void save()}>
          Save cover
        </Button>
        {list.cover ? <Confirm label="Use the built-in" sure="Yes, remove mine" disabled={busy} onConfirm={() => void onClear()} /> : null}
      </div>
    </div>
  );
}

function MoveList({ list, busy, onMove }: { list: List; busy: boolean; onMove: (project: string) => Promise<boolean> }) {
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [to, setTo] = useState('');
  useEffect(() => {
    api<{ targets: Target[] }>('/api/lists/targets').then(
      (r) => setTargets(r.targets),
      () => setTargets([]),
    );
  }, []);
  if (!targets) return null;
  const here = list.project;
  return (
    <div>
      <p className="field-help">Now in {here}.</p>
      <select className="input" aria-label="Move to" value={to} onChange={(e) => setTo(e.target.value)}>
        <option value="">Pick a place</option>
        {targets.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
      <Button variant="outline" disabled={busy || !to} onClick={() => void onMove(to)}>
        Move
      </Button>
    </div>
  );
}
