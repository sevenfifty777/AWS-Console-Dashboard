import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  ROLE_ARN_PATTERN,
  type Profile,
  type ResourceInfo,
  type ResourceResult,
  type SessionStatus,
  type Settings,
  type SettingsPatch,
} from '../../../shared/types';
import { api, errorMessage } from '../api';
import { DataTable, Notice, StatusBadge, countOf, statusDetail, timeAgo } from '../components';
import { STATE_LABEL, roleAccount, roleName, statusUrl, useStatus } from '../hooks';

interface Props {
  active?: Profile;
  /** ARN of the role in use, if any. */
  role?: string;
  settings: Settings;
  onSettings: (patch: SettingsPatch) => void;
}

export function RolesPage({ active, role, settings, onSettings }: Props) {
  const queryClient = useQueryClient();
  const [arnInput, setArnInput] = useState('');
  const [hideServiceRoles, setHideServiceRoles] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const roleStatus = useStatus(active?.name, role !== undefined, role);

  const views = useQuery({ queryKey: ['resources'], queryFn: () => api<ResourceInfo[]>('/api/resources'), staleTime: Infinity });
  const columns = views.data?.find((v) => v.id === 'iam-roles')?.columns ?? [];

  // Always read as the profile itself, not as the role in use: a switch starts from the
  // profile, and the role may not be allowed to list roles.
  const list = useQuery({
    queryKey: ['resource', 'iam-roles', active?.name, ''],
    queryFn: () => api<ResourceResult>(`/api/resources/iam-roles?${new URLSearchParams({ profile: active!.name }).toString()}`),
    enabled: active !== undefined,
    staleTime: 5 * 60_000,
  });

  const allRows = list.data?.rows ?? [];
  const rows = useMemo(() => (hideServiceRoles ? allRows.filter((row) => row.serviceOnly !== true) : allRows), [allRows, hideServiceRoles]);
  const recent = (settings.recentRoles ?? []).filter((r) => r.profile === active?.name && r.arn !== role);

  /** Tries the role first, and only makes it the one in use when AWS accepts the switch. */
  const switchTo = async (input: string) => {
    if (!active || switching) return;
    const arn = input.trim();
    if (!ROLE_ARN_PATTERN.test(arn)) {
      setProblem('That is not a role ARN. It looks like arn:aws:iam::123456789012:role/RoleName');
      return;
    }
    setSwitching(true);
    setProblem(null);
    try {
      const status = await api<SessionStatus>(statusUrl(active.name, arn, true));
      if (status.state !== 'valid') {
        setProblem(`Could not switch to ${roleName(arn)}: ${STATE_LABEL[status.state].toLowerCase()}. ${status.message ?? ''}`);
        return;
      }
      queryClient.setQueryData(['status', active.name, arn], status);
      const others = (settings.recentRoles ?? []).filter((r) => !(r.profile === active.name && r.arn === arn));
      onSettings({ activeRole: { profile: active.name, arn }, recentRoles: [{ profile: active.name, arn }, ...others].slice(0, 8) });
      setArnInput('');
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setSwitching(false);
    }
  };

  const profileStatus = useStatus(active?.name);
  const listedAccount = active?.accountId ?? profileStatus.data?.accountId;

  return (
    <section>
      <div className="toolbar">
        <h1>IAM roles</h1>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>Who you are working as</h2>
            {role ? (
              <div>
                Role <strong>{roleName(role)}</strong> in account <strong>{roleAccount(role)}</strong>, through profile{' '}
                <strong>{active?.name}</strong>
              </div>
            ) : (
              <div>
                Profile <strong>{active?.name}</strong> itself, with no role. Pick a role below to switch to it.
              </div>
            )}
          </div>
          <span className="spacer" />
          {role && (
            <>
              <StatusBadge status={roleStatus.data} loading={roleStatus.isFetching} />
              {roleStatus.data && <span className="faint">{statusDetail(roleStatus.data)}</span>}
              <button className="btn" type="button" onClick={() => onSettings({ activeRole: null })}>
                Leave role
              </button>
            </>
          )}
        </div>
        <p className="faint">
          Switching asks AWS for temporary keys of the role (<code>aws sts assume-role</code>, run as the active profile).
          The command runner and the resource lists then work as that role until you leave it or change profile. The keys
          last one hour, are renewed by themselves, stay in the dashboard's memory and are never shown.
        </p>

        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void switchTo(arnInput);
          }}
        >
          <input
            className="input grow mono"
            aria-label="ARN of a role to switch to"
            placeholder="Role in another account: arn:aws:iam::123456789012:role/RoleName"
            spellCheck={false}
            value={arnInput}
            onChange={(e) => setArnInput(e.target.value)}
          />
          <button className="btn primary" type="submit" disabled={!active || switching || !arnInput.trim()}>
            {switching ? 'Switching…' : 'Switch to this role'}
          </button>
        </form>

        {recent.length > 0 && (
          <div className="row chips">
            <span className="faint">Used lately:</span>
            {recent.map((r) => (
              <button key={r.arn} className="btn small" type="button" title={r.arn} disabled={switching} onClick={() => void switchTo(r.arn)}>
                {roleName(r.arn)} · {roleAccount(r.arn)}
              </button>
            ))}
          </div>
        )}
        {problem && <Notice tone="error">{problem}</Notice>}
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>
              Roles in the account of profile {active?.name}
              {listedAccount && <> ({listedAccount})</>}
            </h2>
            <div className="faint">
              {list.data && !list.data.error && (
                <>
                  {countOf(rows.length, 'role')}
                  {hideServiceRoles && allRows.length > rows.length && <> shown, {allRows.length - rows.length} for AWS services hidden</>}
                  {' · '}updated {timeAgo(list.data.fetchedAt)}
                </>
              )}
            </div>
          </div>
          <span className="spacer" />
          <label className="check" title="Roles that only an AWS service such as Lambda or EC2 may use. A person cannot switch to them.">
            <input type="checkbox" checked={hideServiceRoles} onChange={(e) => setHideServiceRoles(e.target.checked)} />
            Hide roles only AWS services can use
          </label>
          {list.isFetching && <span className="badge muted">Loading…</span>}
          <button className="btn" type="button" disabled={list.isFetching} onClick={() => void list.refetch()}>
            Refresh
          </button>
        </div>

        {list.error && <Notice tone="error">{errorMessage(list.error)}</Notice>}
        {list.data?.error && (
          <Notice tone="warn">
            The roles could not be listed: {STATE_LABEL[list.data.error.state].toLowerCase()}. You can still switch to a role by
            entering its ARN above.
            <div className="faint">{list.data.error.message}</div>
          </Notice>
        )}
        {list.data && !list.data.error && rows.length === 0 && <p className="faint">No role to show.</p>}
        {rows.length > 0 && (
          <DataTable
            columns={columns}
            rows={rows}
            filterPlaceholder="Search roles by name"
            rowAction={{ label: 'Switch', disabled: switching, onRow: (row) => void switchTo(String(row.arn ?? '')) }}
          />
        )}
      </div>
    </section>
  );
}
