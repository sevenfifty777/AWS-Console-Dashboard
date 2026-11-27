import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { AppInfo, SettingsPatch } from '../../shared/types';
import { api, errorMessage, initToken, onUnauthorized, setToken } from './api';
import { LabelTag, Notice, StatusBadge, statusDetail } from './components';
import { EMPTY_SETTINGS, REGIONS, roleAccount, roleName, useAppState, useInfo, useProfiles, useSaveSettings, useStatus } from './hooks';
import { ProfilesPage } from './pages/Profiles';
import { ResourcesPage } from './pages/Resources';
import { RolesPage } from './pages/Roles';
import { RunnerPage } from './pages/Runner';

type Page = 'profiles' | 'roles' | 'runner' | 'resources';
const PAGES: { id: Page; label: string }[] = [
  { id: 'profiles', label: 'Profiles' },
  { id: 'roles', label: 'IAM roles' },
  { id: 'runner', label: 'Command runner' },
  { id: 'resources', label: 'Resources' },
];

function pageFromHash(): Page {
  const id = window.location.hash.replace(/^#\/?/, '');
  return PAGES.some((p) => p.id === id) ? (id as Page) : 'profiles';
}

export function App() {
  const queryClient = useQueryClient();
  const [hasToken, setHasToken] = useState(initToken);
  useEffect(() => onUnauthorized(() => setHasToken(false)), []);

  if (!hasToken) {
    return (
      <TokenGate
        onToken={(value) => {
          setToken(value);
          setHasToken(true);
          void queryClient.invalidateQueries();
        }}
      />
    );
  }
  return <Dashboard />;
}

/** Shown when the page was opened without the access link, or after a server restart. */
function TokenGate({ onToken }: { onToken: (value: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <main className="gate">
      <h1>AWS Console Dashboard</h1>
      <p>
        This page needs the access link of the running dashboard. Each time the dashboard starts it prints a new link
        in its terminal window, ending in <code>#token=…</code>. Open that link, or paste it here.
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onToken(value);
        }}
      >
        <input
          className="input grow"
          aria-label="Access link or token"
          placeholder="http://127.0.0.1:4780/#token=…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        <button className="btn primary" type="submit">
          Open dashboard
        </button>
      </form>
    </main>
  );
}

/**
 * The Read-only / Write switch. Going to Write opens a popup that explains the risk and
 * needs a ticked acknowledgement; going back to Read-only is immediate.
 */
function ModeSwitch({ allowChanges, target }: { allowChanges: boolean; target: string }) {
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [accepted, setAccepted] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setMode = async (allow: boolean) => {
    setProblem(null);
    setBusy(true);
    try {
      const result = await api<{ allowChanges: boolean }>('/api/mode', {
        method: 'PUT',
        body: { allowChanges: allow, acknowledged: allow && accepted },
      });
      queryClient.setQueryData<AppInfo>(['info'], (old) => (old ? { ...old, allowChanges: result.allowChanges } : old));
      dialogRef.current?.close();
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const askForWrite = () => {
    setAccepted(false);
    setProblem(null);
    dialogRef.current?.showModal();
  };

  return (
    <>
      <div className="segmented mode" role="group" aria-label="Mode">
        <button
          type="button"
          className={allowChanges ? '' : 'active'}
          aria-pressed={!allowChanges}
          title="The command runner refuses commands that may change or delete resources."
          onClick={() => {
            if (allowChanges) void setMode(false);
          }}
        >
          Read-only
        </button>
        <button
          type="button"
          className={allowChanges ? 'active danger' : ''}
          aria-pressed={allowChanges}
          title="Let the command runner run commands that change or delete resources."
          onClick={() => {
            if (!allowChanges) askForWrite();
          }}
        >
          Write
        </button>
      </div>
      {problem && !dialogRef.current?.open && <span className="problem">{problem}</span>}

      <dialog ref={dialogRef} className="dialog" aria-labelledby="mode-title">
        <h2 id="mode-title">Switch to write mode?</h2>
        <p>
          In write mode the command runner runs <strong>any</strong> AWS CLI command you type, including commands that
          create, change or delete resources.
        </p>
        <ul>
          <li>
            A change made by a command is real and immediate. The dashboard cannot undo it, and it can break running
            systems, lose data or cost money.
          </li>
          <li>
            It applies to every profile and role you use here, production accounts included. Right now commands would
            run as <strong>{target}</strong>.
          </li>
          <li>Before each such command you still get a confirmation that names the profile and account.</li>
          <li>Write mode lasts until you switch back to Read-only or the dashboard is restarted.</li>
        </ul>
        <label className="check accept">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          I understand the risk and accept responsibility for the commands I run.
        </label>
        {problem && <Notice tone="error">{problem}</Notice>}
        <div className="row end">
          <button className="btn" type="button" autoFocus onClick={() => dialogRef.current?.close()}>
            Stay read-only
          </button>
          <button className="btn danger" type="button" disabled={!accepted || busy} onClick={() => void setMode(true)}>
            Switch to write mode
          </button>
        </div>
      </dialog>
    </>
  );
}

function Dashboard() {
  const info = useInfo();
  const profilesQuery = useProfiles();
  const stateQuery = useAppState();
  const saveSettings = useSaveSettings();
  const [page, setPage] = useState<Page>(pageFromHash);

  useEffect(() => {
    const onHashChange = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const profiles = profilesQuery.data?.profiles ?? [];
  const settings = stateQuery.data?.settings ?? EMPTY_SETTINGS;
  const active =
    profiles.find((p) => p.name === settings.activeProfile) ?? profiles.find((p) => p.name === 'default') ?? profiles[0];
  // A role belongs to the profile it was switched to from; with another profile active it does not apply.
  const role = active && settings.activeRole?.profile === active.name ? settings.activeRole.arn : undefined;
  const status = useStatus(active?.name, true, role);
  const label = active ? settings.labels[active.name] : undefined;
  const accountId = role ? roleAccount(role) : (active?.accountId ?? status.data?.accountId);
  const allowChanges = info.data?.allowChanges ?? false;
  const regionChoices = settings.region && !REGIONS.includes(settings.region) ? [settings.region, ...REGIONS] : REGIONS;
  const pinned = new Set(settings.pins);
  const ordered = [...profiles].sort((a, b) => Number(pinned.has(b.name)) - Number(pinned.has(a.name)));

  /** Who commands would run as, spelled out in the write-mode popup. */
  const target = active
    ? [
        `profile ${active.name}`,
        role ? `role ${roleName(role)}` : null,
        accountId ? `account ${accountId}` : null,
        label?.text ? `labelled "${label.text}"` : null,
      ]
        .filter(Boolean)
        .join(', ')
    : 'no profile';

  const loadError = profilesQuery.error ?? stateQuery.error;
  const noProfiles = profiles.length === 0 && !loadError;
  const save = (patch: SettingsPatch) => saveSettings.mutate(patch);
  /** Changing profile also leaves any role, which was switched to from the previous profile. */
  const selectProfile = (name: string) => save({ activeProfile: name, activeRole: null });

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">AWS Console Dashboard</div>
        <nav className="nav" aria-label="Pages">
          {PAGES.map((p) => (
            <a key={p.id} href={`#/${p.id}`} className={page === p.id ? 'active' : ''} aria-current={page === p.id ? 'page' : undefined}>
              {p.label}
            </a>
          ))}
        </nav>
        <div className="context">
          {info.data && <ModeSwitch allowChanges={allowChanges} target={target} />}
          <label className="field">
            <span>Profile</span>
            <select
              className="input"
              value={active?.name ?? ''}
              disabled={profiles.length === 0}
              onChange={(e) => selectProfile(e.target.value)}
            >
              {ordered.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                  {p.accountId ? ` — ${p.accountId}` : ''}
                  {settings.labels[p.name]?.text ? ` (${settings.labels[p.name]?.text})` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Region</span>
            <select className="input" value={settings.region ?? ''} onChange={(e) => save({ region: e.target.value })}>
              <option value="">Profile default{active?.region ? ` (${active.region})` : ''}</option>
              {regionChoices.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <StatusBadge status={status.data} loading={status.isFetching} />
        </div>
      </header>

      {active && (
        <div className={`activebar ${label ? `label-${label.color} labelled` : ''}`}>
          <LabelTag label={label} />
          {allowChanges && (
            <span className="badge bad" title="The command runner can run commands that change or delete resources.">
              Write mode
            </span>
          )}
          <span>
            Active profile <strong>{active.name}</strong>
            {role && (
              <>
                {' '}
                · role <strong>{roleName(role)}</strong>
              </>
            )}
            {accountId && (
              <>
                {' '}
                · account <strong>{accountId}</strong>
              </>
            )}
            {!role && active.roleName && <> · {active.roleName}</>} · region{' '}
            <strong>{settings.region ?? active.region ?? 'not set'}</strong>
          </span>
          {status.data && statusDetail(status.data) && status.data.state === 'valid' && (
            <span className="faint">{statusDetail(status.data)}</span>
          )}
          {role && (
            <button className="btn small" type="button" onClick={() => save({ activeRole: null })}>
              Leave role
            </button>
          )}
        </div>
      )}

      <main className="page">
        {info.data && !info.data.cliPath && (
          <Notice tone="error">
            The AWS CLI was not found on this computer. Install AWS CLI version 2, then restart the dashboard.
          </Notice>
        )}
        {loadError && <Notice tone="error">Could not load the dashboard data: {errorMessage(loadError)}</Notice>}
        {saveSettings.error && <Notice tone="error">Could not save the setting: {errorMessage(saveSettings.error)}</Notice>}
        {role && status.data && status.data.state !== 'valid' && (
          <Notice tone="warn">
            The role {roleName(role)} cannot be used right now, so commands and lists will fail. {status.data.message} Leave
            the role, or sign in again on the Profiles page if the session of the profile has expired.
          </Notice>
        )}

        {profilesQuery.isPending || stateQuery.isPending ? (
          <p className="faint">Loading profiles…</p>
        ) : (
          <>
            {/* The Profiles page keeps its place below whether or not profiles exist, so what it
                shows (such as the result of creating the first profile) survives the change. */}
            {noProfiles && (
              <Notice tone="info">
                No AWS CLI profiles were found in <code>{info.data?.configFile ?? 'the AWS config file'}</code>. Create the
                first one with <strong>New profile</strong> on the Profiles page.
              </Notice>
            )}
            {page === 'profiles' && (
              <ProfilesPage
                profiles={profiles}
                ssoSessions={profilesQuery.data?.ssoSessions ?? []}
                settings={settings}
                active={active}
                onUse={selectProfile}
                onSettings={save}
              />
            )}
            {page === 'roles' && !noProfiles && <RolesPage active={active} role={role} settings={settings} onSettings={save} />}
            {/* The runner stays mounted so a running command and its output survive a page switch. */}
            <div hidden={page !== 'runner' || noProfiles}>
              <RunnerPage
                active={active}
                role={role}
                region={settings.region}
                label={label}
                accountId={accountId}
                allowChanges={allowChanges}
                appState={stateQuery.data}
              />
            </div>
            {page === 'resources' && !noProfiles && (
              <ResourcesPage
                active={active}
                role={role}
                region={settings.region}
                allRegions={settings.allRegions === true}
                onSettings={save}
              />
            )}
          </>
        )}
      </main>

      <footer className="footer faint">
        {info.data?.cliVersion ?? 'AWS CLI'} · config file {info.data?.configFile ?? '…'} · served on this computer only
      </footer>
    </div>
  );
}
