import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Profile } from '../shared/types';
import { StatusService, classifyCliError, loginCommand, logoutCommand, readExpiry } from '../server/src/aws/auth';
import { childEnv, findAwsCli, runAws } from '../server/src/aws/cli';

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-aws.mjs', import.meta.url));
const cli = findAwsCli({ AWS_DASHBOARD_CLI: FAKE_CLI })!;

function profile(overrides: Partial<Profile> & { name: string }): Profile {
  return {
    type: 'sso',
    loginKind: 'sso',
    authProfile: overrides.name,
    authGroup: `test:${overrides.name}`,
    problems: [],
    ...overrides,
  };
}

describe('classifyCliError', () => {
  it.each([
    ['Error when retrieving token from sso: Token has expired and refresh failed', 'expired'],
    ['Error loading SSO Token: Token for corp does not exist', 'expired'],
    ['The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.', 'expired'],
    ['An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: The security token included in the request is expired', 'expired'],
    ["Your session has expired. Please reauthenticate using 'aws login'.", 'expired'],
    ['Unable to locate credentials. You can configure credentials by running "aws configure".', 'no-credentials'],
    ['The config profile (nope) could not be found', 'no-credentials'],
    ['An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation: The security token included in the request is invalid.', 'no-credentials'],
    ['An error occurred (AccessDenied) when calling the ListBuckets operation: Access Denied', 'access-denied'],
    ['An error occurred (UnauthorizedOperation) when calling the DescribeInstances operation: You are not authorized to perform this operation.', 'access-denied'],
    ['An error occurred (ForbiddenException) when calling the GetRoleCredentials operation: No access', 'access-denied'],
    ['Could not connect to the endpoint URL: "https://sts.eu-west-1.amazonaws.com/"', 'network'],
    ['SSL validation failed for https://sts.amazonaws.com/ [SSL: CERTIFICATE_VERIFY_FAILED]', 'network'],
    ['Something nobody has seen before', 'error'],
  ])('reads "%s" as %s', (stderr, state) => {
    expect(classifyCliError(`\n${stderr}\n`).state).toBe(state);
  });

  it('returns the error text on one line', () => {
    expect(classifyCliError('\nfirst line\n  second line\n').message).toBe('first line second line');
  });
});

describe('sign-in and sign-out commands', () => {
  it('signs in an SSO session once for all its profiles', () => {
    expect(loginCommand(profile({ name: 'dev', ssoSession: 'corp' }), false)).toEqual(['sso', 'login', '--sso-session', 'corp']);
    expect(loginCommand(profile({ name: 'dev', ssoSession: 'corp' }), true)).toEqual([
      'sso',
      'login',
      '--sso-session',
      'corp',
      '--use-device-code',
    ]);
  });

  it('signs in older SSO profiles and aws login profiles by profile name', () => {
    expect(loginCommand(profile({ name: 'legacy' }), false)).toEqual(['sso', 'login', '--profile', 'legacy']);
    expect(loginCommand(profile({ name: 'default', type: 'login', loginKind: 'login' }), false)).toEqual(['login', '--profile', 'default']);
    expect(logoutCommand(profile({ name: 'default', type: 'login', loginKind: 'login' }))).toEqual(['logout', '--profile', 'default']);
    expect(logoutCommand(profile({ name: 'dev', ssoSession: 'corp' }))).toEqual(['sso', 'logout']);
  });

  it('has no sign-in step for access keys', () => {
    expect(loginCommand(profile({ name: 'keys', type: 'keys', loginKind: 'none' }), false)).toBeNull();
    expect(logoutCommand(profile({ name: 'keys', type: 'keys', loginKind: 'none' }))).toBeNull();
  });
});

describe('readExpiry', () => {
  let awsDir: string;
  const loginSession = 'arn:aws:iam::111111111111:user/alice';
  const sha = (algorithm: string, text: string) => createHash(algorithm).update(text).digest('hex');

  beforeAll(() => {
    awsDir = mkdtempSync(join(tmpdir(), 'awsdash-cache-'));
    mkdirSync(join(awsDir, 'login', 'cache'), { recursive: true });
    mkdirSync(join(awsDir, 'sso', 'cache'), { recursive: true });
    writeFileSync(
      join(awsDir, 'login', 'cache', `${sha('sha256', loginSession)}.json`),
      JSON.stringify({ accessToken: { accessKeyId: 'x', expiresAt: '2030-01-02T03:04:05Z' }, refreshToken: 'x' }),
    );
    writeFileSync(
      join(awsDir, 'sso', 'cache', `${sha('sha1', 'corp')}.json`),
      JSON.stringify({ startUrl: 'https://corp.awsapps.com/start', accessToken: 'x', expiresAt: '2030-05-06T07:08:09Z' }),
    );
  });
  afterAll(() => rmSync(awsDir, { recursive: true, force: true }));

  it('reads the aws login cache', () => {
    const root = profile({ name: 'default', type: 'login', loginKind: 'login', loginSession });
    expect(readExpiry(root, awsDir)).toEqual({ expiresAt: '2030-01-02T03:04:05.000Z', autoRenews: true });
  });

  it('reads the SSO cache by session name', () => {
    expect(readExpiry(profile({ name: 'dev', ssoSession: 'corp' }), awsDir)).toEqual({
      expiresAt: '2030-05-06T07:08:09.000Z',
      autoRenews: false,
    });
  });

  it('returns nothing when there is no cache file', () => {
    expect(readExpiry(profile({ name: 'other', ssoSession: 'elsewhere' }), awsDir)).toEqual({});
    expect(readExpiry(profile({ name: 'keys', type: 'keys', loginKind: 'none' }), awsDir)).toEqual({});
  });
});

describe('running the CLI', () => {
  it('passes the profile and region and removes credentials inherited from the environment', () => {
    const env = childEnv({ Path: 'p', AWS_ACCESS_KEY_ID: 'leak', aws_secret_access_key: 'leak', AWS_PROFILE: 'old' }, 'dev', 'eu-west-1');
    expect(env).toMatchObject({ Path: 'p', AWS_PROFILE: 'dev', AWS_REGION: 'eu-west-1', AWS_DEFAULT_REGION: 'eu-west-1', AWS_PAGER: '' });
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.aws_secret_access_key).toBeUndefined();
  });

  it('runs the executable with the chosen profile', async () => {
    const result = await runAws(cli, ['print-env'], { profile: 'dev-admin', region: 'eu-central-1' });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ profile: 'dev-admin', region: 'eu-central-1', accessKey: null, pager: '' });
  });

  it('stops a command that runs past its time limit', async () => {
    const result = await runAws(cli, ['sleep'], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.ms).toBeLessThan(10_000);
  });

  it('stops a command when it is cancelled', async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 300);
    const result = await runAws(cli, ['sleep'], { signal: abort.signal });
    expect(result.cancelled).toBe(true);
    expect(result.ms).toBeLessThan(10_000);
  });

  it('reports a failure to start instead of throwing', async () => {
    const result = await runAws({ command: join(tmpdir(), 'no-such-aws-cli.exe'), prefixArgs: [], display: 'missing' }, ['s3', 'ls']);
    expect(result.code).toBeNull();
    expect(result.stderr).toContain('Could not start the AWS CLI');
  });
});

describe('StatusService', () => {
  const emptyDir = join(tmpdir(), 'awsdash-no-cache');

  it('reports a working profile as valid with its account', async () => {
    const dev = profile({ name: 'dev-admin' });
    const status = await new StatusService(cli, emptyDir).get(dev, [dev]);
    expect(status).toMatchObject({ profile: 'dev-admin', state: 'valid', accountId: '111111111111' });
  });

  it('reports an expired SSO session as expired', async () => {
    const stale = profile({ name: 'sso-expired' });
    const status = await new StatusService(cli, emptyDir).get(stale, [stale]);
    expect(status.state).toBe('expired');
    expect(status.message).toContain('Token has expired');
  });

  it('answers repeated checks from its cache until forced', async () => {
    const dev = profile({ name: 'dev-admin' });
    const service = new StatusService(cli, emptyDir);
    const first = await service.get(dev, [dev]);
    expect(await service.get(dev, [dev])).toBe(first);
    expect(await service.get(dev, [dev], true)).not.toBe(first);
  });

  it('explains when the CLI is missing', async () => {
    const dev = profile({ name: 'dev-admin' });
    expect((await new StatusService(null).get(dev, [dev])).state).toBe('error');
  });
});
