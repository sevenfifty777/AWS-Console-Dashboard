import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Profile, ResourceInfo, ResourceResult, SessionState, SettingsPatch } from '../../../shared/types';
import { api, errorMessage } from '../api';
import { DataTable, Notice, countOf, timeAgo } from '../components';
import { STATE_LABEL } from '../hooks';

interface Props {
  active?: Profile;
  /** Region override from the header; undefined means the region of the profile. */
  region?: string;
  /** ARN of the role in use, if any. */
  role?: string;
  /** Lists cover every region of the account instead of one. */
  allRegions: boolean;
  onSettings: (patch: SettingsPatch) => void;
}

/** A view opened from a row of another view, for example the records of one hosted zone. */
interface Drill {
  view: string;
  param: string;
  title: string;
  /** Region of the row it was opened from, when the parent list covered every region. */
  region?: string;
}

const ERROR_TEXT: Record<SessionState, string> = {
  valid: '',
  expired: 'The session of this profile has expired. Sign in again on the Profiles page.',
  'no-credentials': 'This profile has no valid credentials.',
  'access-denied': 'This profile or role is not allowed to list these resources.',
  network: 'AWS could not be reached. Check the network connection or proxy.',
  error: 'The AWS CLI returned an error.',
};

const REGION_COLUMN = { key: 'region', label: 'Region' };

export function ResourcesPage({ active, region, role, allRegions, onSettings }: Props) {
  const [selected, setSelected] = useState('ec2');
  const [drill, setDrill] = useState<Drill | null>(null);
  const views = useQuery({ queryKey: ['resources'], queryFn: () => api<ResourceInfo[]>('/api/resources'), staleTime: Infinity });

  // An opened row belongs to one account: go back to the list when the profile or role changes.
  useEffect(() => setDrill(null), [active?.name, role]);

  const tabs = (views.data ?? []).filter((v) => !v.parent && !v.hidden);
  const view = views.data?.find((v) => v.id === (drill?.view ?? selected));
  const parent = drill ? views.data?.find((v) => v.id === selected) : undefined;
  const param = drill?.param ?? '';
  const oneRegion = drill?.region ?? region;
  const everyRegion = allRegions && view !== undefined && !view.global && !drill?.region;

  const result = useQuery({
    queryKey: ['resource', view?.id, active?.name, role ?? '', everyRegion ? '*' : (oneRegion ?? ''), param],
    queryFn: () => {
      const params = new URLSearchParams({ profile: active!.name });
      if (role) params.set('role', role);
      if (everyRegion) params.set('allRegions', '1');
      else if (oneRegion) params.set('region', oneRegion);
      if (param) params.set('param', param);
      return api<ResourceResult>(`/api/resources/${view!.id}?${params.toString()}`);
    },
    enabled: active !== undefined && view !== undefined,
    staleTime: 60_000,
  });

  const effectiveRegion = oneRegion ?? active?.region;
  const openRow = view?.drill;
  const covered = result.data?.regions;
  const scope = !view
    ? ''
    : view.global
      ? 'listed for the whole account, whatever the region'
      : everyRegion
        ? 'all regions of the account'
        : `region ${effectiveRegion ?? 'not set'}`;

  return (
    <section>
      <div className="toolbar">
        <h1>Resources</h1>
        <div className="segmented" role="group" aria-label="Service">
          {tabs.map((v) => (
            <button
              key={v.id}
              type="button"
              className={v.id === selected ? 'active' : ''}
              onClick={() => {
                setSelected(v.id);
                setDrill(null);
              }}
            >
              {v.title}
            </button>
          ))}
        </div>
        <label className="check" title="Run each list in every region enabled in the account, instead of the one region chosen above.">
          <input type="checkbox" checked={allRegions} onChange={(e) => onSettings({ allRegions: e.target.checked })} />
          All regions
        </label>
      </div>

      {views.error && <Notice tone="error">Could not load the list of views: {errorMessage(views.error)}</Notice>}

      {view && (
        <div className="card">
          <div className="card-head">
            {drill && (
              <button className="btn" type="button" onClick={() => setDrill(null)}>
                ← {parent?.title ?? 'Back'}
              </button>
            )}
            <div>
              <h2>{drill ? `${view.title}: ${drill.title}` : view.title}</h2>
              <div className="faint">
                profile {active?.name} · {scope}
                {result.data && <> · updated {timeAgo(result.data.fetchedAt)}</>}
              </div>
            </div>
            <span className="spacer" />
            {result.isFetching && <span className="badge muted">{everyRegion ? 'Loading all regions…' : 'Loading…'}</span>}
            <button className="btn" type="button" disabled={result.isFetching} onClick={() => void result.refetch()}>
              Refresh
            </button>
          </div>

          {result.error && <Notice tone="error">{errorMessage(result.error)}</Notice>}
          {result.data?.error && (
            <Notice tone={result.data.error.state === 'error' ? 'error' : 'warn'}>
              {ERROR_TEXT[result.data.error.state]}
              <div className="faint">{result.data.error.message}</div>
            </Notice>
          )}

          {covered && (
            <div className="faint region-note">
              Looked in {countOf(covered.checked, 'region')}
              {covered.standardList && ' (the usual ones: this profile may not read the list of regions of the account)'}.
              {covered.failed.length > 0 && (
                <details>
                  <summary>
                    {countOf(covered.failed.length, 'region')} could not be listed: {covered.failed.map((f) => f.region).join(', ')}
                  </summary>
                  <ul>
                    {covered.failed.map((f) => (
                      <li key={f.region}>
                        <strong>{f.region}</strong>: {STATE_LABEL[f.state].toLowerCase()}. {f.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {result.data && !result.data.error && result.data.rows.length === 0 && (
            <p className="faint">
              Nothing found{drill ? '' : view.global ? ' in this account' : everyRegion ? ' in any region' : ` in ${effectiveRegion ?? 'this region'}`}.
            </p>
          )}
          {result.data && result.data.rows.length > 0 && (
            <DataTable
              key={`${view.id}:${param}:${everyRegion}`}
              columns={covered ? [REGION_COLUMN, ...view.columns] : view.columns}
              rows={result.data.rows}
              rowAction={
                openRow && {
                  label: openRow.label,
                  onRow: (row) =>
                    setDrill({
                      view: openRow.view,
                      param: String(row[openRow.paramKey] ?? ''),
                      title: String(row[openRow.titleKey] ?? ''),
                      region: typeof row.region === 'string' && covered ? row.region : undefined,
                    }),
                }
              }
            />
          )}
        </div>
      )}
    </section>
  );
}
