import { useEffect, useRef, useState } from 'react';
import { REGION_PATTERN, type CreateResult, type SsoSessionInfo } from '../../../shared/types';
import { api, errorMessage } from '../api';
import { Notice } from '../components';
import { REGIONS } from '../hooks';

type Kind = 'login' | 'sso' | 'keys';

const KINDS: { id: Kind; label: string; about: string }[] = [
  {
    id: 'login',
    label: 'AWS login',
    about: 'Sign in with your AWS console user in the browser (aws login). No keys are stored; the sign-in renews by itself.',
  },
  {
    id: 'sso',
    label: 'SSO',
    about: 'An account and role reached through IAM Identity Center (aws configure sso). Several profiles can share one SSO session and one sign-in.',
  },
  {
    id: 'keys',
    label: 'Access keys',
    about: 'A long-lived access key of an IAM user (aws configure). The AWS CLI stores the key in your credentials file.',
  },
];

/** Stands for "create a new SSO session" in the session list. Session names cannot contain this character. */
const NEW_SESSION = '*new';

interface Props {
  ssoSessions: SsoSessionInfo[];
  existingNames: string[];
  defaultRegion?: string;
  onClose: () => void;
  /** A profile was created; the text says what to do next. */
  onCreated: (message: string) => void;
  /** An "aws login" profile needs the browser sign-in, which the Profiles page runs and shows. */
  onLogin: (name: string, region: string) => void;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="form-row">
      <span className="form-label">{label}</span>
      <span className="form-control">
        {children}
        {hint && <small className="faint">{hint}</small>}
      </span>
    </label>
  );
}

export function NewProfileDialog({ ssoSessions, existingNames, defaultRegion, onClose, onCreated, onLogin }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<Kind>('login');
  const [name, setName] = useState('');
  const [region, setRegion] = useState(defaultRegion ?? '');
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [session, setSession] = useState(ssoSessions[0]?.name ?? NEW_SESSION);
  const [sessionName, setSessionName] = useState('');
  const [startUrl, setStartUrl] = useState('');
  const [ssoRegion, setSsoRegion] = useState(defaultRegion ?? '');
  const [accountId, setAccountId] = useState('');
  const [roleName, setRoleName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const about = KINDS.find((k) => k.id === kind)!.about;
  const newSession = session === NEW_SESSION;
  const chosenSession = ssoSessions.find((s) => s.name === session);

  const submit = async () => {
    setProblem(null);
    const profileName = name.trim();
    if (!profileName) return setProblem('Give the profile a name.');
    if (existingNames.includes(profileName)) return setProblem(`A profile named "${profileName}" already exists.`);
    if (!REGION_PATTERN.test(region.trim())) return setProblem('Choose a region, for example eu-west-1.');

    if (kind === 'login') return onLogin(profileName, region.trim());

    setBusy(true);
    try {
      if (kind === 'keys') {
        await api<CreateResult>('/api/profiles/new/keys', {
          method: 'POST',
          body: { name: profileName, accessKeyId: keyId.trim(), secretAccessKey: secret.trim(), region: region.trim() },
        });
        setSecret('');
        onCreated(`Profile "${profileName}" was created with its access keys.`);
      } else {
        await api<CreateResult>('/api/profiles/new/sso', {
          method: 'POST',
          body: {
            name: profileName,
            session: newSession ? sessionName.trim() : session,
            newSession: newSession ? { startUrl: startUrl.trim(), region: ssoRegion.trim() } : undefined,
            accountId: accountId.trim(),
            roleName: roleName.trim(),
            region: region.trim(),
          },
        });
        onCreated(`Profile "${profileName}" was created. If its SSO session is not signed in yet, press Sign in on its group.`);
      }
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialogRef} className="dialog plain" aria-labelledby="new-profile-title" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 id="new-profile-title">New profile</h2>
        <div className="segmented" role="group" aria-label="Kind of profile">
          {KINDS.map((k) => (
            <button key={k.id} type="button" className={kind === k.id ? 'active' : ''} aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>
              {k.label}
            </button>
          ))}
        </div>
        <p className="faint">{about}</p>

        <div className="form">
          <Field label="Profile name" hint="The name you will see in the dashboard and use with --profile.">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} spellCheck={false} autoFocus />
          </Field>

          {kind === 'sso' && (
            <>
              <Field label="SSO session" hint={chosenSession?.startUrl}>
                <select className="input" value={session} onChange={(e) => setSession(e.target.value)}>
                  {ssoSessions.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                  <option value={NEW_SESSION}>New SSO session…</option>
                </select>
              </Field>
              {newSession && (
                <>
                  <Field label="Session name" hint="A short name of your choice, for example the company name.">
                    <input className="input" value={sessionName} onChange={(e) => setSessionName(e.target.value)} maxLength={64} spellCheck={false} />
                  </Field>
                  <Field label="Start URL" hint="The address of the AWS access portal.">
                    <input
                      className="input"
                      value={startUrl}
                      onChange={(e) => setStartUrl(e.target.value)}
                      placeholder="https://my-company.awsapps.com/start"
                      spellCheck={false}
                    />
                  </Field>
                  <Field label="SSO region" hint="The region where IAM Identity Center is set up. It can differ from the region you work in.">
                    <input className="input" list="region-list" value={ssoRegion} onChange={(e) => setSsoRegion(e.target.value)} spellCheck={false} />
                  </Field>
                </>
              )}
              <Field label="Account ID" hint="12 digits, as shown in the access portal.">
                <input className="input mono" value={accountId} onChange={(e) => setAccountId(e.target.value)} maxLength={12} inputMode="numeric" />
              </Field>
              <Field label="Role name" hint="The permission set, for example ReadOnlyAccess, exactly as the portal shows it.">
                <input className="input" value={roleName} onChange={(e) => setRoleName(e.target.value)} maxLength={64} spellCheck={false} />
              </Field>
            </>
          )}

          {kind === 'keys' && (
            <>
              <Field label="Access key ID">
                <input className="input mono" value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="AKIA…" spellCheck={false} autoComplete="off" />
              </Field>
              <Field
                label="Secret access key"
                hint="Passed straight to the AWS CLI, which stores it in your credentials file. The dashboard does not keep or show it."
              >
                <input className="input mono" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
              </Field>
            </>
          )}

          <Field label="Region" hint="The region this profile works in by default.">
            <input className="input" list="region-list" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="eu-west-1" spellCheck={false} />
          </Field>
          <datalist id="region-list">
            {REGIONS.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </div>

        {kind === 'login' && <p className="faint">Your browser opens for the sign-in. The profile is saved once you have signed in.</p>}
        {problem && <Notice tone="error">{problem}</Notice>}

        <div className="row end">
          <button className="btn" type="button" onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'Creating…' : kind === 'login' ? 'Sign in and create' : 'Create profile'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
