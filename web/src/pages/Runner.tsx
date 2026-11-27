import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import type { AppState, CommandCheck, Favourite, Profile, ProfileLabel, ResourceColumn, StreamEvent } from '../../../shared/types';
import { api, errorMessage, streamApi } from '../api';
import { DataTable, JsonTree, LabelTag, Notice, timeAgo } from '../components';
import { roleName } from '../hooks';

interface Props {
  active?: Profile;
  /** ARN of the role in use, if any. */
  role?: string;
  /** Region override from the header; undefined means the region of the profile. */
  region?: string;
  label?: ProfileLabel;
  accountId?: string;
  /** False in read-only mode: commands that may change resources are refused. */
  allowChanges: boolean;
  appState?: AppState;
}

const READ_ONLY_TEXT =
  'Read-only mode: this command may change or delete resources, so it was not run. Only commands that read (describe, list, get and similar) are allowed.';

type EndEvent = Extract<StreamEvent, { t: 'end' }>;
type View = 'table' | 'tree' | 'raw';

interface RunInfo {
  profile: string;
  role?: string;
  region?: string;
  args?: string[];
  end?: EndEvent;
}

const MAX_RAW_SHOWN = 500_000;

function isRowList(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) && value.length > 0 && value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
  );
}

/** Finds a list of objects to show as a table: the answer itself, or the first such list inside it. */
function findRows(value: unknown): Record<string, unknown>[] | null {
  if (isRowList(value)) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const inner of Object.values(value)) if (isRowList(inner)) return inner;
  }
  return null;
}

function columnsOf(rows: Record<string, unknown>[]): ResourceColumn[] {
  const keys = new Set<string>();
  for (const row of rows.slice(0, 100)) for (const key of Object.keys(row)) keys.add(key);
  return [...keys].slice(0, 30).map((key) => ({ key, label: key }));
}

export function RunnerPage({ active, role, region, label, accountId, allowChanges, appState }: Props) {
  const queryClient = useQueryClient();
  const [command, setCommand] = useState('sts get-caller-identity');
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<CommandCheck | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [out, setOut] = useState('');
  const [err, setErr] = useState('');
  const [run, setRun] = useState<RunInfo | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [favouriteName, setFavouriteName] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const favourites = appState?.favourites ?? [];
  const history = appState?.history ?? [];
  const effectiveRegion = region ?? active?.region ?? 'not set';

  const parsed = useMemo(() => {
    if (running || !out.trim()) return undefined;
    try {
      return JSON.parse(out) as unknown;
    } catch {
      return undefined;
    }
  }, [running, out]);
  const rows = useMemo(() => findRows(parsed), [parsed]);
  const columns = useMemo(() => (rows ? columnsOf(rows) : []), [rows]);
  const available: View[] = [...(rows ? (['table'] as View[]) : []), ...(parsed !== undefined ? (['tree'] as View[]) : []), 'raw'];
  const shownView = view && available.includes(view) ? view : available[0];

  const start = async (confirmed: boolean) => {
    if (!active || running) return;
    setNotice(null);
    if (!confirmed) {
      try {
        const check = await api<CommandCheck>('/api/run/check', { method: 'POST', body: { command } });
        if (check.blocked) return setNotice(check.blocked);
        if (!check.readOnly && !allowChanges) return setNotice(READ_ONLY_TEXT);
        if (!check.readOnly) return setPending(check);
      } catch (error) {
        return setNotice(errorMessage(error));
      }
    }
    setPending(null);
    setOut('');
    setErr('');
    setRun({ profile: active.name, role, region });
    setRunning(true);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      await streamApi(
        '/api/run',
        { profile: active.name, role, region, command, confirmed },
        (event) => {
          if (event.t === 'start') setRun((current) => current && { ...current, args: event.args });
          else if (event.t === 'out') setOut((current) => current + event.d);
          else if (event.t === 'err') setErr((current) => current + event.d);
          else setRun((current) => current && { ...current, end: event });
        },
        abort.signal,
      );
    } catch (error) {
      if (!abort.signal.aborted) setNotice(errorMessage(error));
    } finally {
      setRunning(false);
      void queryClient.invalidateQueries({ queryKey: ['state'] });
    }
  };

  const saveFavourites = async (next: Favourite[]) => {
    try {
      await api('/api/favourites', { method: 'PUT', body: { favourites: next } });
      await queryClient.invalidateQueries({ queryKey: ['state'] });
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const clearHistory = async () => {
    try {
      await api('/api/history', { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['state'] });
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  const end = run?.end;
  const cancelled = !running && run !== null && !end;
  const failed = end ? end.code !== 0 : false;

  return (
    <section className="split">
      <div className="split-main">
        <div className="toolbar">
          <h1>Command runner</h1>
        </div>

        <div className="card">
          <label className="faint" htmlFor="command">
            AWS CLI command. The leading <code>aws</code> is optional. Ctrl+Enter runs it.
          </label>
          <textarea
            id="command"
            className="input command"
            rows={3}
            spellCheck={false}
            value={command}
            onChange={(e) => {
              setCommand(e.target.value);
              setPending(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void start(false);
              }
            }}
          />
          <div className="row">
            {running ? (
              <button className="btn" type="button" onClick={() => abortRef.current?.abort()}>
                Cancel
              </button>
            ) : (
              <button className="btn primary" type="button" disabled={!active || !command.trim()} onClick={() => void start(false)}>
                Run
              </button>
            )}
            <span className="faint">
              Runs as <strong>{active?.name ?? 'no profile'}</strong>
              {role && (
                <>
                  {' '}
                  · role <strong>{roleName(role)}</strong>
                </>
              )}
              {accountId && <> · account {accountId}</>} · region {effectiveRegion}
              {!allowChanges && <> · read-only</>}
            </span>
            <LabelTag label={label} />
            <span className="spacer" />
            {favouriteName === null ? (
              <button className="btn small" type="button" disabled={!command.trim()} onClick={() => setFavouriteName('')}>
                Save as favourite
              </button>
            ) : (
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = favouriteName.trim() || command.trim().slice(0, 60);
                  void saveFavourites([...favourites.filter((f) => f.name !== name), { name, command: command.trim() }]);
                  setFavouriteName(null);
                }}
              >
                <input
                  className="input small"
                  aria-label="Name of the favourite"
                  placeholder="Name"
                  maxLength={80}
                  value={favouriteName}
                  onChange={(e) => setFavouriteName(e.target.value)}
                  autoFocus
                />
                <button className="btn small primary" type="submit">
                  Save
                </button>
                <button className="btn small" type="button" onClick={() => setFavouriteName(null)}>
                  Cancel
                </button>
              </form>
            )}
          </div>
        </div>

        {notice && <Notice tone="error">{notice}</Notice>}

        {pending && active && (
          <div className="card confirm">
            <h2>This command may change or delete resources</h2>
            <pre className="output small">aws {pending.args.join(' ')}</pre>
            <p>
              It will run with profile <strong>{active.name}</strong>
              {role && (
                <>
                  {' '}
                  as role <strong>{roleName(role)}</strong>
                </>
              )}
              {accountId && (
                <>
                  {' '}
                  in account <strong>{accountId}</strong>
                </>
              )}
              , region <strong>{effectiveRegion}</strong>. <LabelTag label={label} />
            </p>
            <div className="row">
              <button className="btn danger" type="button" onClick={() => void start(true)}>
                Run it
              </button>
              <button className="btn" type="button" onClick={() => setPending(null)}>
                Do not run
              </button>
            </div>
          </div>
        )}

        {run && (
          <div className="card">
            <div className="card-head">
              <div>
                <code>aws {run.args?.join(' ') ?? '…'}</code>
                <div className="faint">
                  profile {run.profile}
                  {run.role && <> · role {roleName(run.role)}</>}
                  {run.region && <> · region {run.region}</>}
                  {end && (
                    <>
                      {' '}
                      · exit code {end.code ?? 'none'} · {(end.ms / 1000).toFixed(1)} s
                    </>
                  )}
                </div>
              </div>
              <span className="spacer" />
              {running && <span className="badge muted">Running…</span>}
              {end && <span className={`badge ${failed ? 'bad' : 'ok'}`}>{failed ? 'Failed' : 'Done'}</span>}
              {cancelled && <span className="badge warn">Cancelled</span>}
              {!running && (
                <div className="segmented" role="group" aria-label="Output view">
                  {(['table', 'tree', 'raw'] as View[]).map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={shownView === option ? 'active' : ''}
                      disabled={!available.includes(option)}
                      onClick={() => setView(option)}
                    >
                      {option === 'table' ? 'Table' : option === 'tree' ? 'Tree' : 'Raw'}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {end?.timedOut && <Notice tone="warn">Stopped: the command ran longer than 10 minutes.</Notice>}
            {end?.truncated && <Notice tone="warn">Stopped: the output passed the 10 MB limit. Narrow the command with --query or filters.</Notice>}
            {err.trim() && <pre className={`output small ${failed ? 'stderr' : ''}`}>{err.trim()}</pre>}

            {shownView === 'table' && rows && !running ? (
              <DataTable columns={columns} rows={rows} />
            ) : shownView === 'tree' && parsed !== undefined && !running ? (
              <div className="output tree">
                <JsonTree value={parsed} />
              </div>
            ) : out ? (
              <pre className="output">
                {out.length > MAX_RAW_SHOWN ? `${out.slice(0, MAX_RAW_SHOWN)}\n… output shortened for display` : out}
              </pre>
            ) : (
              !running && !err.trim() && <p className="faint">The command printed nothing.</p>
            )}
          </div>
        )}
      </div>

      <aside className="split-side">
        <div className="card">
          <h2>Favourites</h2>
          {favourites.length === 0 && <p className="faint">Save a command you use often to find it here.</p>}
          <ul className="list">
            {favourites.map((favourite) => (
              <li key={favourite.name}>
                <button type="button" className="list-item" title={favourite.command} onClick={() => setCommand(favourite.command)}>
                  <strong>{favourite.name}</strong>
                  <span className="mono clip">{favourite.command}</span>
                </button>
                <button
                  type="button"
                  className="btn small"
                  aria-label={`Remove favourite ${favourite.name}`}
                  onClick={() => void saveFavourites(favourites.filter((f) => f.name !== favourite.name))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>History</h2>
            <span className="spacer" />
            {history.length > 0 && (
              <button className="btn small" type="button" onClick={() => void clearHistory()}>
                Clear
              </button>
            )}
          </div>
          {history.length === 0 && <p className="faint">Commands you run appear here. They are kept on this computer only.</p>}
          <ul className="list">
            {history.slice(0, 50).map((entry) => (
              <li key={`${entry.at}-${entry.command}`}>
                <button type="button" className="list-item" title={entry.command} onClick={() => setCommand(entry.command)}>
                  <span className="mono clip">{entry.command}</span>
                  <span className="faint">
                    {entry.profile}
                    {entry.role && <> as {roleName(entry.role)}</>} · {timeAgo(entry.at)} · {entry.exitCode === 0 ? 'ok' : `exit ${entry.exitCode ?? 'none'}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </section>
  );
}
