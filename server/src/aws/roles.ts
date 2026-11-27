import { userInfo } from 'node:os';
import type { Profile, SessionState } from '../../../shared/types';
import { classifyCliError } from './auth';
import { runAws, type CliTarget, type RoleCredentials } from './cli';

/** Ask for new keys this long before the current ones run out. */
const RENEW_BEFORE_EXPIRY_MS = 5 * 60_000;

export interface RoleSession {
  credentials: RoleCredentials;
  expiresAt: string;
  /** The identity AWS reports for the session, for example arn:aws:sts::123:assumed-role/Name/session. */
  assumedArn?: string;
}

export type RoleResult = { ok: true; session: RoleSession } | { ok: false; state: SessionState; message: string };

/** Shown in the audit trail of the account, so it names the tool and the Windows user. */
function sessionName(): string {
  let user = 'user';
  try {
    user = userInfo().username;
  } catch {
    // No user name available: keep the placeholder.
  }
  return `aws-dashboard-${user}`.replace(/[^\w+=,.@-]/g, '-').slice(0, 64);
}

/**
 * Switches to IAM roles with "aws sts assume-role", run as the chosen profile.
 *
 * This is the one place where the dashboard holds credentials: the temporary keys
 * of an assumed role (valid one hour). They stay in this object, in memory. They are
 * never written to disk and never sent to the browser.
 */
export class RoleSessions {
  private cache = new Map<string, RoleSession>();
  private inflight = new Map<string, Promise<RoleResult>>();

  constructor(private readonly cli: CliTarget | null) {}

  invalidate(): void {
    this.cache.clear();
  }

  get(profile: Profile, roleArn: string, force = false): Promise<RoleResult> {
    const key = `${profile.name}|${roleArn}`;
    const cached = this.cache.get(key);
    if (!force && cached && Date.parse(cached.expiresAt) - Date.now() > RENEW_BEFORE_EXPIRY_MS) {
      return Promise.resolve({ ok: true, session: cached });
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const request = this.assume(profile, roleArn)
      .then((result) => {
        if (result.ok) this.cache.set(key, result.session);
        else this.cache.delete(key);
        return result;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    return request;
  }

  private async assume(profile: Profile, roleArn: string): Promise<RoleResult> {
    if (!this.cli) return { ok: false, state: 'error', message: 'The AWS CLI was not found on this computer' };
    const result = await runAws(
      this.cli,
      ['sts', 'assume-role', '--role-arn', roleArn, '--role-session-name', sessionName(), '--profile', profile.name, '--output', 'json'],
      { profile: profile.name, timeoutMs: 30_000 },
    );
    if (result.timedOut) return { ok: false, state: 'network', message: 'No answer from AWS after 30 seconds' };
    if (result.code !== 0) return { ok: false, ...classifyCliError(result.stderr) };
    try {
      const answer = JSON.parse(result.stdout) as {
        Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: string };
        AssumedRoleUser?: { Arn?: string };
      };
      const keys = answer.Credentials;
      const expires = Date.parse(keys?.Expiration ?? '');
      if (!keys?.AccessKeyId || !keys.SecretAccessKey || !keys.SessionToken || Number.isNaN(expires)) throw new Error('incomplete');
      return {
        ok: true,
        session: {
          credentials: { accessKeyId: keys.AccessKeyId, secretAccessKey: keys.SecretAccessKey, sessionToken: keys.SessionToken },
          expiresAt: new Date(expires).toISOString(),
          assumedArn: answer.AssumedRoleUser?.Arn,
        },
      };
    } catch {
      return { ok: false, state: 'error', message: 'The AWS CLI returned an answer that could not be read' };
    }
  }
}
