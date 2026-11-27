import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Profile, SessionState, SessionStatus } from '../../../shared/types';
import { runAws, type CliTarget } from './cli';
import { authRoot } from './profiles';

const STATUS_TIMEOUT_MS = 20_000;
const VALID_TTL_MS = 60_000;
const PROBLEM_TTL_MS = 10_000;
const MAX_PARALLEL_CHECKS = 4;

/** First match wins, so the order matters: an expired SSO token also mentions "Unauthorized". */
const ERROR_PATTERNS: [SessionState, RegExp][] = [
  [
    'network',
    /Could not connect to the endpoint URL|ConnectTimeoutError|ReadTimeoutError|EndpointConnectionError|SSL validation failed|ProxyConnectionError|getaddrinfo failed|Failed to establish a new connection|Max retries exceeded|Connection was closed/i,
  ],
  [
    'expired',
    /Token has expired|refresh failed|Error loading SSO Token|Token for .* does not exist|SSO session associated with this profile|Your session has expired|ExpiredToken|RequestExpired|token included in the request is expired|reauthenticate|UnauthorizedException|aws sso login|run aws login|using 'aws login'/i,
  ],
  [
    'no-credentials',
    /Unable to locate credentials|NoCredentials|config profile \(.*\) could not be found|Partial credentials|InvalidClientTokenId|token included in the request is invalid|SignatureDoesNotMatch|UnrecognizedClientException|AuthFailure/i,
  ],
  ['access-denied', /AccessDenied|not authorized to perform|UnauthorizedOperation|AuthorizationError|ForbiddenException|Forbidden/i],
];

/** Maps the error text of the AWS CLI to a state the dashboard can explain. */
export function classifyCliError(stderr: string): { state: SessionState; message: string } {
  const message =
    stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, 600) || 'The AWS CLI returned an error without a message';
  for (const [state, pattern] of ERROR_PATTERNS) {
    if (pattern.test(stderr)) return { state, message };
  }
  return { state: 'error', message };
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

const hash = (algorithm: string, text: string) => createHash(algorithm).update(text).digest('hex');

/**
 * Reads when the cached sign-in of a profile expires. Only the expiry date and the
 * presence of a refresh token are taken from the cache file; the tokens are not kept.
 */
export function readExpiry(root: Profile, awsDir = join(homedir(), '.aws')): { expiresAt?: string; autoRenews?: boolean } {
  if (root.loginKind === 'login' && root.loginSession) {
    // aws login: cache file is named after the SHA-256 of the login_session ARN.
    const data = readJson(join(awsDir, 'login', 'cache', `${hash('sha256', root.loginSession)}.json`));
    if (!data) return {};
    const token = data.accessToken as Record<string, unknown> | undefined;
    return { expiresAt: isoDate(token?.expiresAt), autoRenews: typeof data.refreshToken === 'string' };
  }
  if (root.loginKind === 'sso') {
    // SSO: cache file is named after the SHA-1 of the sso-session name, or of the start URL for older profiles.
    for (const key of [root.ssoSession, root.ssoStartUrl]) {
      if (!key) continue;
      const data = readJson(join(awsDir, 'sso', 'cache', `${hash('sha1', key)}.json`));
      if (data?.expiresAt) return { expiresAt: isoDate(data.expiresAt), autoRenews: typeof data.refreshToken === 'string' };
    }
  }
  return {};
}

export function loginCommand(root: Profile, useDeviceCode: boolean): string[] | null {
  if (root.loginKind === 'sso') {
    const target = root.ssoSession ? ['--sso-session', root.ssoSession] : ['--profile', root.name];
    return ['sso', 'login', ...target, ...(useDeviceCode ? ['--use-device-code'] : [])];
  }
  if (root.loginKind === 'login') return ['login', '--profile', root.name];
  return null;
}

export function logoutCommand(root: Profile): string[] | null {
  if (root.loginKind === 'sso') return ['sso', 'logout'];
  if (root.loginKind === 'login') return ['logout', '--profile', root.name];
  return null;
}

/** Checks whether profiles can reach AWS, with a short cache and a limit on parallel checks. */
export class StatusService {
  private cache = new Map<string, { at: number; status: SessionStatus }>();
  private inflight = new Map<string, Promise<SessionStatus>>();
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private readonly cli: CliTarget | null,
    private readonly awsDir?: string,
  ) {}

  invalidate(): void {
    this.cache.clear();
  }

  get(profile: Profile, all: Profile[], force = false): Promise<SessionStatus> {
    const hit = this.cache.get(profile.name);
    if (!force && hit) {
      const ttl = hit.status.state === 'valid' ? VALID_TTL_MS : PROBLEM_TTL_MS;
      if (Date.now() - hit.at < ttl) return Promise.resolve(hit.status);
    }
    const pending = this.inflight.get(profile.name);
    if (pending) return pending;
    const check = this.limit(() => this.check(profile, all))
      .then((status) => {
        this.cache.set(profile.name, { at: Date.now(), status });
        return status;
      })
      .finally(() => this.inflight.delete(profile.name));
    this.inflight.set(profile.name, check);
    return check;
  }

  private limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.running++;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.running--;
            this.waiting.shift()?.();
          });
      };
      if (this.running < MAX_PARALLEL_CHECKS) start();
      else this.waiting.push(start);
    });
  }

  private async check(profile: Profile, all: Profile[]): Promise<SessionStatus> {
    const base = { profile: profile.name, checkedAt: new Date().toISOString() };
    if (!this.cli) return { ...base, state: 'error', message: 'The AWS CLI was not found on this computer' };

    const result = await runAws(this.cli, ['sts', 'get-caller-identity', '--profile', profile.name, '--output', 'json'], {
      profile: profile.name,
      timeoutMs: STATUS_TIMEOUT_MS,
    });

    if (result.timedOut) {
      return { ...base, state: 'network', message: `No answer from AWS after ${STATUS_TIMEOUT_MS / 1000} seconds` };
    }
    if (result.code !== 0) return { ...base, ...classifyCliError(result.stderr) };

    let identity: { Account?: string; Arn?: string } = {};
    try {
      identity = JSON.parse(result.stdout);
    } catch {
      return { ...base, state: 'error', message: 'The AWS CLI returned an answer that is not JSON' };
    }
    // Read the expiry after the call: the CLI refreshes the cached token while answering.
    const expiry = readExpiry(authRoot(profile, all), this.awsDir);
    const inFuture = expiry.expiresAt !== undefined && Date.parse(expiry.expiresAt) > Date.now();
    return {
      ...base,
      state: 'valid',
      accountId: identity.Account,
      arn: identity.Arn,
      expiresAt: inFuture ? expiry.expiresAt : undefined,
      autoRenews: expiry.autoRenews,
    };
  }
}
