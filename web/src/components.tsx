import { useMemo, useState } from 'react';
import type { ProfileLabel, ResourceColumn, SessionState, SessionStatus } from '../../shared/types';
import { STATE_LABEL } from './hooks';

// --- formatting -----------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function timeLeft(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} days`;
}

export function timeAgo(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : formatDate(iso);
}

/** "1 row", "2 rows". */
export function countOf(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// --- small pieces ---------------------------------------------------------------------

const STATE_TONE: Record<SessionState, string> = {
  valid: 'ok',
  expired: 'warn',
  'no-credentials': 'bad',
  'access-denied': 'bad',
  network: 'warn',
  error: 'bad',
};

/** What to say next to a status: time left for a valid session, the CLI message otherwise. */
export function statusDetail(status: SessionStatus): string | undefined {
  if (status.state !== 'valid') return status.message;
  if (status.autoRenews) return 'Renews automatically';
  if (status.expiresAt) return `Expires in ${timeLeft(status.expiresAt)}`;
  return undefined;
}

export function StatusBadge({ status, loading }: { status?: SessionStatus; loading?: boolean }) {
  if (!status) return <span className="badge muted">{loading ? 'Checking…' : 'Not checked'}</span>;
  return (
    <span className={`badge ${STATE_TONE[status.state]}`} title={statusDetail(status)}>
      {STATE_LABEL[status.state]}
    </span>
  );
}

export function LabelTag({ label }: { label?: ProfileLabel }) {
  if (!label) return null;
  return <span className={`label label-${label.color}`}>{label.text ?? label.color}</span>;
}

export function Notice({ tone, children }: { tone: 'error' | 'warn' | 'info'; children: React.ReactNode }) {
  return (
    <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

// --- table ----------------------------------------------------------------------------

const MAX_ROWS_SHOWN = 500;

function stateTone(value: string): string {
  if (/alarm|fail|rollback|error/i.test(value)) return 'bad';
  if (/stopp|pending|progress|insufficient|shutting|terminated|delet/i.test(value)) return 'warn';
  if (/^(running|available|ok|active)$|_complete$/i.test(value)) return 'ok';
  return 'muted';
}

function Cell({ column, value }: { column: string; value: unknown }) {
  const text = cellText(value);
  if (text === '') return <span className="faint">—</span>;
  if ((column === 'state' || column === 'status') && typeof value === 'string') {
    return <span className={`badge ${stateTone(value)}`}>{value}</span>;
  }
  if (typeof value === 'string' && ISO_DATE.test(value)) return <span title={value}>{formatDate(value)}</span>;
  // Long values (a DKIM key, for example) are shortened; the full text shows on hover.
  return text.length > 300 ? <span title={text}>{text.slice(0, 300)}…</span> : <>{text}</>;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return cellText(a).localeCompare(cellText(b), undefined, { numeric: true, sensitivity: 'base' });
}

interface DataTableProps {
  columns: ResourceColumn[];
  rows: Record<string, unknown>[];
  /** Adds a button at the end of every row. */
  rowAction?: { label: string; disabled?: boolean; onRow: (row: Record<string, unknown>) => void };
  /** Hint shown in the filter box. */
  filterPlaceholder?: string;
}

/** Sortable, filterable table for a list of flat objects. */
export function DataTable({ columns, rows, rowAction, filterPlaceholder = 'Filter rows' }: DataTableProps) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [filter, setFilter] = useState('');

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matching = needle
      ? rows.filter((row) => columns.some((c) => cellText(row[c.key]).toLowerCase().includes(needle)))
      : rows;
    if (!sort) return matching;
    return [...matching].sort((a, b) => compare(a[sort.key], b[sort.key]) * sort.dir);
  }, [rows, columns, filter, sort]);

  const toggleSort = (key: string) =>
    setSort((current) => (current?.key === key ? (current.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 }));

  return (
    <div className="table-wrap">
      <div className="table-tools">
        <input
          className="input"
          type="search"
          placeholder={filterPlaceholder}
          aria-label={filterPlaceholder}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="faint">
          {visible.length === rows.length ? countOf(rows.length, 'row') : `${visible.length} of ${countOf(rows.length, 'row')}`}
        </span>
      </div>
      <div className="table-scroll">
        <table className="grid">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" className="th-button" onClick={() => toggleSort(c.key)}>
                    {c.label}
                    <span aria-hidden="true">{sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</span>
                  </button>
                </th>
              ))}
              {rowAction && <th aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {visible.slice(0, MAX_ROWS_SHOWN).map((row, index) => (
              <tr key={index}>
                {columns.map((c) => (
                  <td key={c.key}>
                    <Cell column={c.key} value={row[c.key]} />
                  </td>
                ))}
                {rowAction && (
                  <td className="actions">
                    <button className="btn small" type="button" disabled={rowAction.disabled} onClick={() => rowAction.onRow(row)}>
                      {rowAction.label}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visible.length > MAX_ROWS_SHOWN && (
        <p className="faint">Showing the first {MAX_ROWS_SHOWN} rows. Use the filter to narrow the list.</p>
      )}
    </div>
  );
}

// --- JSON tree ------------------------------------------------------------------------

/** Collapsible view of any JSON value. Two levels are open to start with. */
export function JsonTree({ value, name, depth = 0 }: { value: unknown; name?: string; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);
  const [limit, setLimit] = useState(100);

  if (value === null || typeof value !== 'object') {
    return (
      <div className="jt-row">
        {name !== undefined && <span className="jt-key">{name}: </span>}
        <span className={`jt-${value === null ? 'null' : typeof value}`}>{JSON.stringify(value)}</span>
      </div>
    );
  }

  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
  const summary = Array.isArray(value) ? `[ ${entries.length} ]` : `{ ${entries.length} }`;

  return (
    <div className="jt-node">
      <button type="button" className="jt-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> {name !== undefined && <span className="jt-key">{name} </span>}
        <span className="faint">{summary}</span>
      </button>
      {open && (
        <div className="jt-children">
          {entries.slice(0, limit).map(([key, child]) => (
            <JsonTree key={key} name={key} value={child} depth={depth + 1} />
          ))}
          {entries.length > limit && (
            <button type="button" className="btn small" onClick={() => setLimit(limit + 500)}>
              Show more ({entries.length - limit} hidden)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
