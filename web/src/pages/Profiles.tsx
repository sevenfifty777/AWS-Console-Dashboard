import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import {
  LABEL_COLORS,
  type LabelColor,
  type Profile,
  type ProfileLabel,
  type SessionStatus,
  type Settings,
  type SettingsPatch,
  type SsoSessionInfo,
} from '../../../shared/types';
import { NewProfileDialog } from './NewProfile';
import { api, errorMessage, streamApi } from '../api';
import { LabelTag, Notice, StatusBadge, countOf, statusDetail } from '../components';
import { LABEL_PRESETS, TYPE_LABEL, recheckStatus, useStatus } from '../hooks';

interface Props {
  profiles: Profile[];
  ssoSessions: SsoSessionInfo[];
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

export function ProfilesPage({ profiles, ssoSessions, settings, active, onUse, onSettings }: Props) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [creating, setCreating] = useState(false);
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

  /** Runs a browser sign-in on the server and shows its progress in the panel at the top. */
  const runSignIn = async (title: string, path: string, body: unknown, doneText: string) => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setJob({ title, output: '', running: true });
    const update = (patch: Partial<Job> | ((job: Job) => Partial<Job>)) =>
      setJob((current) => current && { ...current, ...(typeof patch === 'function' ? patch(current) : patch) });
    try {
      await streamApi(
        path,
        body,
        (event) => {
          if (event.t === 'start') update({ command: `aws ${event.args.join(' ')}` });
          else if (event.t === 'out' || event.t === 'err') update((current) => ({ output: current.output + event.d }));
          else {
            const result = event.cancelled
              ? 'Sign-in cancelled'
              : event.timedOut
                ? 'Sign-in stopped after 5 minutes without completing'
                : event.code === 0
                  ? doneText
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
      await queryClient.invalidateQueries({ queryKey: ['profiles'] });
      await queryClient.invalidateQueries({ queryKey: ['status'] });
    }
  };

  const signIn = (profile: Profile, useDeviceCode: boolean) =>
    runSignIn(`Signing in: ${profile.ssoSession ?? profile.authProfile}`, '/api/auth/login', { profile: profile.name, useDeviceCode }, 'Signed in');

  /** A new "aws login" profile exists only once its first sign-in has succeeded. */
  const createLoginProfile = (name: string, region: string) => {
    setCreating(false);
    void runSignIn(`New profile: ${name}`, '/api/profiles/new/login', { name, region }, `Profile "${name}" was created and is signed in`);
  };

  const profileCreated = async (message: string) => {
    setCreating(false);
    setJob({ title: 'New profile', output: '', running: false, ok: true, result: message });
    await queryClient.invalidateQueries({ queryKey: ['profiles'] });
    await queryClient.invalidateQueries({ queryKey: ['status'] });
  };

  // SSO is one sign-in per session, shared by all its profiles, and "aws sso logout"
  // can only end every session at once. The texts below say which of the two applies.
  const ssoProfiles = profiles.filter((p) => p.loginKind === 'sso');
  const ssoSessionCount = new Set(ssoProfiles.map((p) => p.authGroup)).size;

  const signOut = async (profile: Profile) => {
    if (profile.loginKind === 'sso') {
      const session = profile.ssoSession ? `SSO session "${profile.ssoSession}"` : 'this SSO sign-in';
      const sharedBy = ssoProfiles.filter((p) => p.authGroup === profile.authGroup).length;
      const message =
        ssoSessionCount > 1
          ? `The AWS CLI can only sign out of all SSO sessions together, not of ${session} alone.\n\n` +
            `All ${ssoSessionCount} SSO sessions on this computer will be signed out (${countOf(ssoProfiles.length, 'profile')}). Continue?`
          : `Sign out of ${session}?\n\n` +
            `It is one sign-in shared by ${countOf(sharedBy, 'profile')}, so they are all signed out together. ` +
            'With SSO, a single account cannot be signed out on its own.';
      if (!window.confirm(message)) return;
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

  const setLabel = (name: string, label: ProfileLabel | undefined) => {
    const labels = { ...settings.labels };
    if (label) labels[name] = label;
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
        <span className="spacer" />
        <button className="btn primary" type="button" disabled={job?.running ?? false} onClick={() => setCreating(true)}>
          New profile
        </button>
      </div>

      {creating && (
        <NewProfileDialog
          ssoSessions={ssoSessions}
          existingNames={profiles.map((p) => p.name)}
          defaultRegion={active?.region}
          onClose={() => setCreating(false)}
          onCreated={(message) => void profileCreated(message)}
          onLogin={createLoginProfile}
        />
      )}

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

      {groups.length === 0 && profiles.length > 0 && <p className="faint">No profile matches the search.</p>}

      {groups.map(([key, members]) => (
        <GroupCard
          key={key}
          members={members}
          settings={settings}
          activeName={active?.name}
          severalSsoSessions={ssoSessionCount > 1}
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
  /** More than one SSO session is set up, so signing out of SSO ends them all. */
  severalSsoSessions: boolean;
  busy: boolean;
  onUse: (name: string) => void;
  onPin: (name: string) => void;
  onLabel: (name: string, label: ProfileLabel | undefined) => void;
  onSignIn: (profile: Profile, useDeviceCode: boolean) => void;
  onSignOut: (profile: Profile) => void;
}

function GroupCard({ members, settings, activeName, severalSsoSessions, busy, onUse, onPin, onLabel, onSignIn, onSignOut }: GroupProps) {
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
  const signOutAllSso = first.loginKind === 'sso' && severalSsoSessions;
  const detail =
    first.loginKind === 'sso'
      ? `${first.ssoStartUrl ? `${first.ssoStartUrl} · ` : ''}one sign-in shared by all the profiles below`
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
            <button
              className="btn"
              type="button"
              disabled={busy}
              title={
                first.loginKind === 'sso'
                  ? signOutAllSso
                    ? 'The AWS CLI can only sign out of all SSO sessions together.'
                    : 'Signs out every profile of this SSO session: they share one sign-in.'
                  : undefined
              }
              onClick={() => onSignOut(first)}
            >
              {signOutAllSso ? 'Sign out of all SSO' : 'Sign out'}
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
  /** Check this profile straight away instead of waiting for the user to ask. */
  checkNow: boolean;
  groupStatus?: SessionStatus;
  onUse: (name: string) => void;
  onPin: (name: string) => void;
  onLabel: (name: string, label: ProfileLabel | undefined) => void;
}

const COLOR_NAMES: Record<LabelColor, string> = { red: 'Red', amber: 'Amber', green: 'Green', blue: 'Blue', purple: 'Purple' };
const MAX_LABEL_LENGTH = 24;

/**
 * Picks the label of a profile: none, a ready-made one, or a name typed by the user
 * with a colour of their choice.
 */
function LabelEditor({ profileName, label, onChange }: { profileName: string; label?: ProfileLabel; onChange: (label: ProfileLabel | undefined) => void }) {
  const preset = label ? LABEL_PRESETS.find((p) => p.color === label.color && p.text === label.text) : undefined;
  const [custom, setCustom] = useState(label !== undefined && !preset);
  const [text, setText] = useState(label?.text ?? '');
  const [color, setColor] = useState<LabelColor>(label?.color ?? 'blue');

  /** Saves the typed name, unless it is empty or nothing changed. Choose "None" to remove a label. */
  const saveCustom = (nextText: string, nextColor: LabelColor) => {
    const name = nextText.trim();
    if (name && (name !== label?.text || nextColor !== label.color)) onChange({ color: nextColor, text: name });
  };

  return (
    <div className="label-editor">
      <select
        className="input small"
        aria-label={`Label for ${profileName}`}
        value={custom ? 'custom' : (preset?.color ?? '')}
        onChange={(e) => {
          if (e.target.value === 'custom') {
            setCustom(true);
            setText(preset ? '' : (label?.text ?? ''));
            setColor(label?.color ?? 'blue');
            return;
          }
          setCustom(false);
          onChange(LABEL_PRESETS.find((p) => p.color === e.target.value));
        }}
      >
        <option value="">None</option>
        {LABEL_PRESETS.map((p) => (
          <option key={p.color} value={p.color}>
            {p.text}
          </option>
        ))}
        <option value="custom">Custom name…</option>
      </select>
      {custom && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            saveCustom(text, color);
          }}
        >
          <input
            className="input small"
            aria-label={`Custom label name for ${profileName}`}
            placeholder="Name, then Enter"
            maxLength={MAX_LABEL_LENGTH}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => saveCustom(text, color)}
          />
          <select
            className="input small"
            aria-label={`Label colour for ${profileName}`}
            value={color}
            onChange={(e) => {
              const next = e.target.value as LabelColor;
              setColor(next);
              saveCustom(text, next);
            }}
          >
            {LABEL_COLORS.map((c) => (
              <option key={c} value={c}>
                {COLOR_NAMES[c]}
              </option>
            ))}
          </select>
        </form>
      )}
    </div>
  );
}

function ProfileRow({ profile, settings, isActive, pinned, checkNow, groupStatus, onUse, onPin, onLabel }: RowProps) {
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
        <LabelEditor
          profileName={profile.name}
          label={settings.labels[profile.name]}
          onChange={(label) => onLabel(profile.name, label)}
        />
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
