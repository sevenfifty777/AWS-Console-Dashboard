import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import type { Profile, SessionStatus, Settings, SettingsPatch } from '../../../shared/types';
import { api, errorMessage, streamApi } from '../api';
import { LabelTag, Notice, StatusBadge, countOf, statusDetail } from '../components';
import { LABEL_PRESETS, TYPE_LABEL, recheckStatus, useStatus } from '../hooks';

interface Props {
  profiles: Profile[];
  settings: Settings;
  active?: Profile;
  onUse: (name: string) => void;
  onSettings: (patch: SettingsPatch) => void;
}

/** Output of the sign-in or sign-out command that was last started. */
interface Job {
  title: string;
  command?: string;
  output: string;
  running: boolean;
  result?: string;
  ok?: boolean;
}

/** Profiles that sign in together share a card; profiles without a sign-in step share one card. */
const groupKey = (p: Profile) => (p.loginKind === 'none' ? 'none' : p.authGroup);

export function ProfilesPage({ profiles, settings, active, onUse, onSettings }: Props) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const pinned = new Set(settings.pins);
    const matching = profiles.filter(
      (p) =>
        !needle ||
        [p.name, p.accountId, p.roleName, p.region, p.ssoSession, TYPE_LABEL[p.type], settings.labels[p.name]?.text].some((v) =>
          v?.toLowerCase().includes(needle),
        ),
    );
    const sorted = [...matching].sort((a, b) => Number(pinned.has(b.name)) - Number(pinned.has(a.name)));
    const byGroup = new Map<string, Profile[]>();
    for (const p of sorted) {
      const key = groupKey(p);
      const list = byGroup.get(key);
      if (list) list.push(p);
      else byGroup.set(key, [p]);
    }
    return [...byGroup.entries()];
  }, [profiles, settings.pins, settings.labels, search]);

  const shownCount = groups.reduce((sum, [, members]) => sum + members.length, 0);

  const signIn = async (profile: Profile, useDeviceCode: boolean) => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setJob({ title: `Signing in: ${profile.ssoSession ?? profile.authProfile}`, output: '', running: true });
    const update = (patch: Partial<Job> | ((job: Job) => Partial<Job>)) =>
      setJob((current) => current && { ...current, ...(typeof patch === 'function' ? patch(current) : patch) });
    try {
      await streamApi(
        '/api/auth/login',
        { profile: profile.name, useDeviceCode },
        (event) => {
          if (event.t === 'start') update({ command: `aws ${event.args.join(' ')}` });
          else if (event.t === 'out' || event.t === 'err') update((current) => ({ output: current.output + event.d }));
          else {
            const result = event.cancelled
              ? 'Sign-in cancelled'
              : event.timedOut
                ? 'Sign-in stopped after 5 minutes without completing'
                : event.code === 0
                  ? 'Signed in'
                  : `Sign-in failed (exit code ${event.code})`;
            update({ running: false, result, ok: event.code === 0 });
          }
        },
        abort.signal,
      );
    } catch (err) {
      update({ running: false, ok: false, result: abort.signal.aborted ? 'Sign-in cancelled' : errorMessage(err) });
    } finally {
      update((current) => (current.running ? { running: false, result: current.result ?? 'Sign-in cancelled' } : {}));
      await queryClient.invalidateQueries({ queryKey: ['status'] });
    }
  };

  const signOut = async (profile: Profile) => {
    if (
      profile.loginKind === 'sso' &&
      !window.confirm('Signing out ends every SSO session on this computer, not only this one. Continue?')
    ) {
      return;
    }
    setJob({ title: `Signing out: ${profile.authProfile}`, output: '', running: true });
    try {
      const res = await api<{ ok: boolean; output: string }>('/api/auth/logout', { method: 'POST', body: { profile: profile.name } });
      setJob({
        title: `Signing out: ${profile.authProfile}`,
        output: res.output,
        running: false,
        ok: res.ok,
        result: res.ok ? 'Signed out' : 'Sign-out failed',
      });
    } catch (err) {
      setJob({ title: `Signing out: ${profile.authProfile}`, output: '', running: false, ok: false, result: errorMessage(err) });
    }
    await queryClient.invalidateQueries({ queryKey: ['status'] });
  };

  const togglePin = (name: string) =>
    onSettings({ pins: settings.pins.includes(name) ? settings.pins.filter((p) => p !== name) : [...settings.pins, name] });

  const setLabel = (name: string, color: string) => {
    const labels = { ...settings.labels };
    const preset = LABEL_PRESETS.find((l) => l.color === color);
    if (preset) labels[name] = preset;
    else delete labels[name];
    onSettings({ labels });
  };

  return (
    <section>
      <div className="toolbar">
        <h1>Profiles</h1>
        <input
          className="input"
          type="search"
          placeholder="Search by name, account, role, region or label"
          aria-label="Search profiles"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="faint">
          {shownCount === profiles.length
            ? countOf(profiles.length, 'profile')
            : `${shownCount} of ${countOf(profiles.length, 'profile')}`}
        </span>
        <button className="btn" type="button" onClick={() => void queryClient.invalidateQueries({ queryKey: ['status'] })}>
          Refresh status
        </button>
      </div>

      {job && (
        <div className="card job">
          <div className="card-head">
            <strong>{job.title}</strong>
            {job.command && <code>{job.command}</code>}
            <span className="spacer" />
            {job.running ? (
              <button className="btn small" type="button" onClick={() => abortRef.current?.abort()}>
                Cancel
              </button>
            ) : (
              <button className="btn small" type="button" onClick={() => setJob(null)}>
                Close
              </button>
            )}
          </div>
          {job.running && (
            <p className="faint">
              A browser window opens for the sign-in. Complete it there; this panel updates when it is done.
            </p>
          )}
          {job.output.trim() && <pre className="output small">{job.output.trim()}</pre>}
          {job.result && <Notice tone={job.ok ? 'info' : 'error'}>{job.result}</Notice>}
        </div>
      )}

      {groups.length === 0 && <p className="faint">No profile matches the search.</p>}

      {groups.map(([key, members]) => (
        <GroupCard
          key={key}
          members={members}
          settings={settings}
          activeName={active?.name}
          busy={job?.running ?? false}
          onUse={onUse}
          onPin={togglePin}
          onLabel={setLabel}
          onSignIn={signIn}
          onSignOut={signOut}
        />
      ))}
    </section>
  );
}

interface GroupProps {
  members: Profile[];
  settings: Settings;
  activeName?: string;
  busy: boolean;
  onUse: (name: string) => void;
  onPin: (name: string) => void;
  onLabel: (name: string, color: string) => void;
  onSignIn: (profile: Profile, useDeviceCode: boolean) => void;
  onSignOut: (profile: Profile) => void;
}

function GroupCard({ members, settings, activeName, busy, onUse, onPin, onLabel, onSignIn, onSignOut }: GroupProps) {
  const first = members[0];
  const shared = first.loginKind !== 'none';
  // One check tells whether the shared sign-in is still good; the active profile is preferred for it.
  const representative = members.find((p) => p.name === activeName) ?? first;
  const groupStatus = useStatus(representative.name, shared);
  const [useDeviceCode, setUseDeviceCode] = useState(false);

  const title =
    first.loginKind === 'sso'
      ? first.ssoSession
        ? `SSO session: ${first.ssoSession}`
        : 'SSO sign-in'
      : first.loginKind === 'login'
        ? 'AWS login'
        : 'Profiles without a sign-in step';
  const detail =
    first.loginKind === 'sso'
      ? first.ssoStartUrl
      : first.loginKind === 'login'
        ? first.loginSession
        : 'Access keys, external credential processes and similar. Nothing to sign in to.';

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          {detail && <div className="faint">{detail}</div>}
        </div>
        <span className="spacer" />
        {shared && (
          <>
            <StatusBadge status={groupStatus.data} loading={groupStatus.isFetching} />
            {groupStatus.data && statusDetail(groupStatus.data) && groupStatus.data.state === 'valid' && (
              <span className="faint">{statusDetail(groupStatus.data)}</span>
            )}
            {first.loginKind === 'sso' && (
              <label className="check" title="Use this when the browser cannot return to the CLI, for example behind a strict proxy.">
                <input type="checkbox" checked={useDeviceCode} onChange={(e) => setUseDeviceCode(e.target.checked)} />
                Use device code
              </label>
            )}
            <button className="btn primary" type="button" disabled={busy} onClick={() => onSignIn(first, useDeviceCode)}>
              Sign in
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => onSignOut(first)}>
              Sign out
            </button>
          </>
        )}
      </div>
      {shared && groupStatus.data && groupStatus.data.state !== 'valid' && groupStatus.data.message && (
        <Notice tone="warn">{groupStatus.data.message}</Notice>
      )}
      <div className="table-scroll">
        <table className="grid profiles">
          <thead>
            <tr>
              <th aria-label="Pinned" />
              <th>Profile</th>
              <th>Type</th>
              <th>Account</th>
              <th>Role or identity</th>
              <th>Region</th>
              <th>Status</th>
              <th>Label</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {members.map((profile) => (
              <ProfileRow
                key={profile.name}
                profile={profile}
                isActive={profile.name === activeName}
                pinned={settings.pins.includes(profile.name)}
                labelColor={settings.labels[profile.name]?.color ?? ''}
                checkNow={!shared || profile.name === representative.name}
                groupStatus={shared ? groupStatus.data : undefined}
                onUse={onUse}
                onPin={onPin}
                onLabel={onLabel}
                settings={settings}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface RowProps {
  profile: Profile;
  settings: Settings;
  isActive: boolean;
  pinned: boolean;
  labelColor: string;
  /** Check this profile straight away instead of waiting for the user to ask. */
  checkNow: boolean;
  groupStatus?: SessionStatus;
  onUse: (name: string) => void;
  onPin: (name: string) => void;
  onLabel: (name: string, color: string) => void;
}

function ProfileRow({ profile, settings, isActive, pinned, labelColor, checkNow, groupStatus, onUse, onPin, onLabel }: RowProps) {
  const queryClient = useQueryClient();
  const [asked, setAsked] = useState(false);
  const [checking, setChecking] = useState(false);
  const own = useStatus(profile.name, checkNow || isActive || asked);
  const status = own.data;

  const check = async () => {
    setAsked(true);
    setChecking(true);
    try {
      await recheckStatus(queryClient, profile.name);
    } catch {
      // The status column keeps its previous value; the next refresh tries again.
    } finally {
      setChecking(false);
    }
  };

  let statusCell: React.ReactNode;
  if (status) {
    statusCell = (
      <>
        <StatusBadge status={status} />
        {status.state !== 'valid' && status.message && <div className="faint clip" title={status.message}>{status.message}</div>}
      </>
    );
  } else if (own.isFetching || checking) {
    statusCell = <StatusBadge loading />;
  } else if (groupStatus) {
    // Not checked on its own: the shared sign-in tells most of the story.
    statusCell =
      groupStatus.state === 'valid' ? (
        <span className="badge muted" title="The shared sign-in is valid. Press Check to test this profile itself.">
          Session active
        </span>
      ) : (
        <StatusBadge status={groupStatus} />
      );
  } else {
    statusCell = <StatusBadge />;
  }

  return (
    <tr className={isActive ? 'active-row' : ''}>
      <td>
        <button
          type="button"
          className={`pin ${pinned ? 'on' : ''}`}
          aria-pressed={pinned}
          aria-label={pinned ? `Unpin ${profile.name}` : `Pin ${profile.name}`}
          title={pinned ? 'Unpin' : 'Pin to the top'}
          onClick={() => onPin(profile.name)}
        >
          {pinned ? '★' : '☆'}
        </button>
      </td>
      <td>
        <strong>{profile.name}</strong> {isActive && <span className="badge accent">Active</span>}{' '}
        <LabelTag label={settings.labels[profile.name]} />
        {profile.type === 'assume-role' && profile.sourceProfile && <div className="faint">through {profile.sourceProfile}</div>}
        {profile.problems.map((problem) => (
          <div key={problem} className="problem">
            {problem}
          </div>
        ))}
      </td>
      <td>
        <span className="tag">{TYPE_LABEL[profile.type]}</span>
      </td>
      <td className="mono">{profile.accountId ?? status?.accountId ?? <span className="faint">—</span>}</td>
      <td>{profile.roleName ?? status?.arn?.split(':').pop() ?? <span className="faint">—</span>}</td>
      <td>{profile.region ?? <span className="faint">not set</span>}</td>
      <td>{statusCell}</td>
      <td>
        <select
          className="input small"
          aria-label={`Label for ${profile.name}`}
          value={labelColor}
          onChange={(e) => onLabel(profile.name, e.target.value)}
        >
          <option value="">None</option>
          {LABEL_PRESETS.map((preset) => (
            <option key={preset.color} value={preset.color}>
              {preset.text}
            </option>
          ))}
        </select>
      </td>
      <td className="actions">
        <button className="btn small" type="button" disabled={isActive} onClick={() => onUse(profile.name)}>
          {isActive ? 'In use' : 'Use'}
        </button>
        <button className="btn small" type="button" disabled={checking} onClick={() => void check()}>
          Check
        </button>
      </td>
    </tr>
  );
}
