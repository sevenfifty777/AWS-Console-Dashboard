import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Profile, ResourceInfo, ResourceResult, SessionState } from '../../../shared/types';
import { api, errorMessage } from '../api';
import { DataTable, Notice, timeAgo } from '../components';

interface Props {
  active?: Profile;
  /** Region override from the header; undefined means the region of the profile. */
  region?: string;
}

const ERROR_TEXT: Record<SessionState, string> = {
  valid: '',
  expired: 'The session of this profile has expired. Sign in again on the Profiles page.',
  'no-credentials': 'This profile has no valid credentials.',
  'access-denied': 'This profile is not allowed to list these resources.',
  network: 'AWS could not be reached. Check the network connection or proxy.',
  error: 'The AWS CLI returned an error.',
};

export function ResourcesPage({ active, region }: Props) {
  const [selected, setSelected] = useState('ec2');
  const views = useQuery({ queryKey: ['resources'], queryFn: () => api<ResourceInfo[]>('/api/resources'), staleTime: Infinity });
  const view = views.data?.find((v) => v.id === selected);

  const result = useQuery({
    queryKey: ['resource', selected, active?.name, region ?? ''],
    queryFn: () => {
      const params = new URLSearchParams({ profile: active!.name });
      if (region) params.set('region', region);
      return api<ResourceResult>(`/api/resources/${selected}?${params.toString()}`);
    },
    enabled: active !== undefined && view !== undefined,
    staleTime: 60_000,
  });

  const effectiveRegion = region ?? active?.region;

  return (
    <section>
      <div className="toolbar">
        <h1>Resources</h1>
        <div className="segmented" role="group" aria-label="Service">
          {(views.data ?? []).map((v) => (
            <button key={v.id} type="button" className={v.id === selected ? 'active' : ''} onClick={() => setSelected(v.id)}>
              {v.title}
            </button>
          ))}
        </div>
      </div>

      {views.error && <Notice tone="error">Could not load the list of views: {errorMessage(views.error)}</Notice>}

      {view && (
        <div className="card">
          <div className="card-head">
            <div>
              <h2>{view.title}</h2>
              <div className="faint">
                profile {active?.name}
                {view.global ? ' · listed for the whole account, whatever the region' : ` · region ${effectiveRegion ?? 'not set'}`}
                {result.data && <> · updated {timeAgo(result.data.fetchedAt)}</>}
              </div>
            </div>
            <span className="spacer" />
            {result.isFetching && <span className="badge muted">Loading…</span>}
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
          {result.data && !result.data.error && result.data.rows.length === 0 && (
            <p className="faint">
              Nothing found{view.global ? ' in this account' : ` in ${effectiveRegion ?? 'this region'}`}.
            </p>
          )}
          {result.data && result.data.rows.length > 0 && <DataTable columns={view.columns} rows={result.data.rows} />}
        </div>
      )}
    </section>
  );
}
