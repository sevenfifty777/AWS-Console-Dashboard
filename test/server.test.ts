import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppState, ResourceResult, StreamEvent } from '../shared/types';
import { findAwsCli } from '../server/src/aws/cli';
import { buildApp, type AppContext } from '../server/src/routes';
import { resolveStatic } from '../server/src/static';
import { Store } from '../server/src/store';

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-aws.mjs', import.meta.url));
const PORT = 4999;
const TOKEN = 'test-token';

const ADMIN_ROLE = 'arn:aws:iam::222222222222:role/Admin';

let dir: string;
let app: FastifyInstance;
let ctx: AppContext;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'awsdash-server-'));
  writeFileSync(
    join(dir, 'config'),
    [
      '[default]',
      'region = eu-west-1',
      'login_session = arn:aws:iam::111111111111:user/alice',
      '',
      '[profile sso-expired]',
      'sso_start_url = https://corp.awsapps.com/start',
      'sso_account_id = 222222222222',
      'sso_role_name = ReadOnly',
      '',
    ].join('\n'),
  );
  mkdirSync(join(dir, 'public', 'assets'), { recursive: true });
  writeFileSync(join(dir, 'public', 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(dir, 'public', 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, 'secret.txt'), 'outside the public folder');

  ctx = {
    cli: findAwsCli({ AWS_DASHBOARD_CLI: FAKE_CLI }),
    cliVersion: 'fake',
    store: new Store(join(dir, 'data')),
    token: TOKEN,
    port: PORT,
    extraOrigins: [],
    publicDir: join(dir, 'public'),
    allowChanges: true,
    env: { AWS_CONFIG_FILE: join(dir, 'config'), AWS_SHARED_CREDENTIALS_FILE: join(dir, 'credentials') },
    awsDir: dir,
  };
  app = buildApp(ctx);
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

type Call = { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; body?: unknown; headers?: Record<string, string> };

function call({ method = 'GET', url, body, headers }: Call) {
  return app.inject({
    method,
    url,
    payload: body as object | undefined,
    headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...headers },
  });
}

const events = (payload: string) =>
  payload
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StreamEvent);

describe('access control', () => {
  it('refuses API calls without the token', async () => {
    expect((await call({ url: '/api/profiles', headers: { authorization: '' } })).statusCode).toBe(401);
    expect((await call({ url: '/api/profiles', headers: { authorization: 'Bearer wrong-token' } })).statusCode).toBe(401);
  });

  it('refuses a Host header that is not this server', async () => {
    expect((await call({ url: '/api/profiles', headers: { host: `evil.example:${PORT}` } })).statusCode).toBe(403);
    expect((await call({ url: '/', headers: { host: 'evil.example' } })).statusCode).toBe(403);
  });

  it('refuses requests coming from another site', async () => {
    expect((await call({ url: '/api/profiles', headers: { origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await call({ url: '/api/profiles', headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
  });

  it('accepts its own page', async () => {
    const res = await call({ url: '/api/profiles', headers: { origin: `http://127.0.0.1:${PORT}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().profiles.map((p: { name: string }) => p.name)).toEqual(['default', 'sso-expired']);
  });
});

describe('session status', () => {
  it('reports valid and expired profiles', async () => {
    expect((await call({ url: '/api/status?profile=default' })).json()).toMatchObject({ state: 'valid', accountId: '111111111111' });
    expect((await call({ url: '/api/status?profile=sso-expired' })).json()).toMatchObject({ state: 'expired' });
  });

  it('rejects a profile that is not in the config', async () => {
    expect((await call({ url: '/api/status?profile=--debug' })).statusCode).toBe(400);
  });
});

describe('command runner', () => {
  it('streams the output of a read-only command and records it in the history', async () => {
    const res = await call({ method: 'POST', url: '/api/run', body: { profile: 'default', command: 'aws s3api list-buckets' } });
    expect(res.statusCode).toBe(200);
    const list = events(res.payload);
    expect(list[0]).toEqual({ t: 'start', args: ['s3api', 'list-buckets', '--output', 'json'] });
    expect(list.at(-1)).toMatchObject({ t: 'end', code: 0, timedOut: false, cancelled: false });
    const out = list.map((e) => (e.t === 'out' ? e.d : '')).join('');
    expect(JSON.parse(out).Buckets).toHaveLength(2);

    const state = (await call({ url: '/api/state' })).json() as AppState;
    expect(state.history[0]).toMatchObject({ profile: 'default', command: 'aws s3api list-buckets', exitCode: 0 });
  });

  it('asks for confirmation before a command that may change something', async () => {
    const body = { profile: 'default', command: 's3 rm s3://bucket/key' };
    const refused = await call({ method: 'POST', url: '/api/run', body });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().check).toMatchObject({ readOnly: false });

    const confirmed = await call({ method: 'POST', url: '/api/run', body: { ...body, confirmed: true } });
    expect(confirmed.statusCode).toBe(200);
    expect(events(confirmed.payload).at(-1)).toMatchObject({ t: 'end', code: 2 });
  });

  it('in read-only mode refuses a command that may change something, even when confirmed', async () => {
    ctx.allowChanges = false;
    try {
      const run = (command: string) => call({ method: 'POST', url: '/api/run', body: { profile: 'default', command, confirmed: true } });
      const refused = await run('s3 rm s3://bucket/key');
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error).toContain('Read-only mode');
      expect((await run('s3api list-buckets')).statusCode).toBe(200);
      expect((await call({ url: '/api/info' })).json()).toMatchObject({ allowChanges: false });
    } finally {
      ctx.allowChanges = true;
    }
  });

  it('switches to write mode only with an acknowledgement, and back to read-only freely', async () => {
    const mode = (body: object) => call({ method: 'PUT', url: '/api/mode', body });
    const deleting = { profile: 'default', command: 's3 rm s3://bucket/key' };
    const switches: boolean[] = [];
    ctx.onModeChange = (allow) => switches.push(allow);
    try {
      expect((await mode({ allowChanges: false })).json()).toEqual({ allowChanges: false });
      expect((await call({ method: 'POST', url: '/api/run', body: deleting })).statusCode).toBe(403);

      // Asking for write mode without accepting the risk changes nothing.
      for (const body of [{ allowChanges: true }, { allowChanges: true, acknowledged: 'yes' }, { allowChanges: true, acknowledged: false }]) {
        expect((await mode(body)).statusCode).toBe(400);
      }
      expect((await call({ url: '/api/info' })).json()).toMatchObject({ allowChanges: false });
      expect((await call({ method: 'POST', url: '/api/run', body: deleting })).statusCode).toBe(403);

      expect((await mode({ allowChanges: true, acknowledged: true })).json()).toEqual({ allowChanges: true });
      expect((await call({ url: '/api/info' })).json()).toMatchObject({ allowChanges: true });
      // In write mode each such command still needs its own confirmation.
      expect((await call({ method: 'POST', url: '/api/run', body: deleting })).statusCode).toBe(409);

      expect((await mode({})).json()).toEqual({ allowChanges: false });
      expect((await call({ method: 'POST', url: '/api/run', body: { ...deleting, confirmed: true } })).statusCode).toBe(403);
      expect(switches).toEqual([false, true, false]);
    } finally {
      ctx.onModeChange = undefined;
      ctx.allowChanges = true;
    }
  });

  it('refuses blocked commands, unknown profiles and bad regions', async () => {
    const run = (body: object) => call({ method: 'POST', url: '/api/run', body });
    expect((await run({ profile: 'default', command: 'configure export-credentials' })).statusCode).toBe(400);
    expect((await run({ profile: 'nobody', command: 's3 ls' })).statusCode).toBe(400);
    expect((await run({ profile: 'default', command: 's3 ls', region: 'eu-west-1; calc' })).statusCode).toBe(400);
  });

  it('checks a command without running it', async () => {
    const res = await call({ method: 'POST', url: '/api/run/check', body: { command: 'ec2 terminate-instances --instance-ids i-1' } });
    expect(res.json()).toMatchObject({ readOnly: false, args: ['ec2', 'terminate-instances', '--instance-ids', 'i-1'] });
  });
});

describe('resource views', () => {
  it('returns rows for a service', async () => {
    const result = (await call({ url: '/api/resources/s3?profile=default' })).json() as ResourceResult;
    expect(result.error).toBeUndefined();
    expect(result.rows.map((r) => r.name)).toEqual(['logs-bucket', 'assets-bucket']);
  });

  it('explains a missing permission instead of failing', async () => {
    const result = (await call({ url: '/api/resources/ec2?profile=default&region=eu-central-1' })).json() as ResourceResult;
    expect(result.rows).toEqual([]);
    expect(result.error?.state).toBe('access-denied');
  });

  it('lists the available views and rejects unknown ones', async () => {
    const list = (await call({ url: '/api/resources' })).json() as { id: string; parent?: string; hidden?: boolean }[];
    expect(list.map((r) => r.id)).toEqual([
      'ec2',
      's3',
      'lambda',
      'rds',
      'cloudformation',
      'alarms',
      'route53',
      'route53-records',
      'iam-roles',
    ]);
    expect(list.filter((r) => r.parent).map((r) => r.id)).toEqual(['route53-records']);
    expect(list.filter((r) => r.hidden).map((r) => r.id)).toEqual(['iam-roles']);
    expect((await call({ url: '/api/resources/nope?profile=default' })).statusCode).toBe(404);
  });

  it('lists Route 53 hosted zones with a clean zone ID', async () => {
    const result = (await call({ url: '/api/resources/route53?profile=default' })).json() as ResourceResult;
    expect(result.rows).toEqual([
      { name: 'example.com', id: 'Z0123456789ABCDEFGHIJ', visibility: 'Public', records: 3, comment: 'Main site' },
      { name: 'corp.internal', id: 'Z0999999999ZZZZZZZZZZ', visibility: 'Private', records: 12, comment: null },
    ]);
  });

  it('lists the records of one hosted zone', async () => {
    const result = (await call({ url: '/api/resources/route53-records?profile=default&param=Z0123456789ABCDEFGHIJ' })).json() as ResourceResult;
    expect(result.error).toBeUndefined();
    expect(result.rows).toEqual([
      { name: 'example.com', type: 'A', ttl: null, value: 'Alias to d111111abcdef8.cloudfront.net', routing: '' },
      { name: 'example.com', type: 'NS', ttl: 172800, value: 'ns-1.awsdns-01.org.\nns-2.awsdns-02.co.uk.', routing: '' },
      { name: '*.example.com', type: 'CNAME', ttl: 300, value: 'example.com', routing: 'blue · weight 80' },
    ]);
  });

  it('only accepts a zone ID as the value for the records view', async () => {
    const records = (param: string) => call({ url: `/api/resources/route53-records?profile=default${param}` });
    expect((await records('')).statusCode).toBe(400);
    expect((await records('&param=--debug')).statusCode).toBe(400);
    expect((await records('&param=Z123%20--endpoint-url%20http://evil.example')).statusCode).toBe(400);
    expect((await records('&param=/hostedzone/Z0123456789ABCDEFGHIJ')).statusCode).toBe(400);
    const unknownZone = (await records('&param=Z0000000000')).json() as ResourceResult;
    expect(unknownZone.error?.message).toContain('NoSuchHostedZone');
  });
});

describe('all regions', () => {
  it('runs a list in every region of the account and reports the regions that refused', async () => {
    const result = (await call({ url: '/api/resources/lambda?profile=default&allRegions=1' })).json() as ResourceResult;
    expect(result.error).toBeUndefined();
    expect(result.rows.map((r) => [r.region, r.name])).toEqual([
      ['eu-west-1', 'fn-eu-west-1'],
      ['us-east-1', 'fn-us-east-1'],
    ]);
    expect(result.regions).toMatchObject({ checked: 3, standardList: false });
    expect(result.regions?.failed).toHaveLength(1);
    expect(result.regions?.failed[0]).toMatchObject({ region: 'ap-south-1', state: 'access-denied' });
  });

  it('runs a list in one region when a region is given', async () => {
    const result = (await call({ url: '/api/resources/lambda?profile=default&region=us-east-1' })).json() as ResourceResult;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).not.toHaveProperty('region');
    expect(result.regions).toBeUndefined();
  });

  it('ignores the option for a service that is the same in every region', async () => {
    const result = (await call({ url: '/api/resources/s3?profile=default&allRegions=1' })).json() as ResourceResult;
    expect(result.rows).toHaveLength(2);
    expect(result.regions).toBeUndefined();
  });

  it('gives the reason once when no region answers', async () => {
    const result = (await call({ url: '/api/resources/lambda?profile=sso-expired&allRegions=1' })).json() as ResourceResult;
    expect(result.rows).toEqual([]);
    expect(result.error?.state).toBe('expired');
  });
});

describe('IAM roles', () => {
  it('lists roles with who can use them', async () => {
    const result = (await call({ url: '/api/resources/iam-roles?profile=default' })).json() as ResourceResult;
    expect(result.rows.map((r) => [r.name, r.trustedBy, r.serviceOnly, r.maxHours])).toEqual([
      ['Admin', 'Account 111111111111', false, 4],
      ['lambda-exec', 'Service lambda', true, 1],
      ['Partner', 'user/bob in 222222222222\nAccount 333333333333\nFederated Corp', false, 1],
    ]);
    expect(result.rows[0]).not.toHaveProperty('trust');
  });

  it('reports a role that can be switched to as valid, with its account and expiry', async () => {
    const status = (await call({ url: `/api/status?profile=default&role=${encodeURIComponent(ADMIN_ROLE)}` })).json();
    expect(status).toMatchObject({
      profile: 'default',
      state: 'valid',
      accountId: '222222222222',
      arn: 'arn:aws:sts::222222222222:assumed-role/Admin/session',
      autoRenews: true,
    });
    expect(Date.parse(status.expiresAt)).toBeGreaterThan(Date.now());
    expect(JSON.stringify(status)).not.toContain('ROLE_');
  });

  it('explains when the profile may not switch to a role', async () => {
    const denied = encodeURIComponent('arn:aws:iam::222222222222:role/Denied');
    const status = (await call({ url: `/api/status?profile=default&role=${denied}` })).json();
    expect(status.state).toBe('access-denied');
    expect(status.message).toContain('not authorized to perform: sts:AssumeRole');
  });

  it('rejects anything that is not a role ARN', async () => {
    const status = (await call({ url: '/api/status?profile=default&role=--debug' })).json();
    expect(status.state).toBe('error');
    const run = await call({ method: 'POST', url: '/api/run', body: { profile: 'default', command: 'print-env', role: 'arn:aws:iam::1:user/x' } });
    expect(run.statusCode).toBe(400);
  });

  it('runs commands and resource lists as the role', async () => {
    const run = await call({ method: 'POST', url: '/api/run', body: { profile: 'default', command: 'print-env', role: ADMIN_ROLE } });
    const out = events(run.payload)
      .map((e) => (e.t === 'out' ? e.d : ''))
      .join('');
    expect(JSON.parse(out)).toMatchObject({ profile: 'default', accessKey: 'ROLE_KEY_ID' });

    const state = (await call({ url: '/api/state' })).json() as AppState;
    expect(state.history[0]).toMatchObject({ command: 'print-env', role: ADMIN_ROLE });

    const buckets = (await call({ url: `/api/resources/s3?profile=default&role=${encodeURIComponent(ADMIN_ROLE)}` })).json() as ResourceResult;
    expect(buckets.rows).toHaveLength(2);
    const denied = encodeURIComponent('arn:aws:iam::222222222222:role/Denied');
    const refused = (await call({ url: `/api/resources/s3?profile=default&role=${denied}` })).json() as ResourceResult;
    expect(refused.error?.state).toBe('access-denied');
  });
});

describe('settings', () => {
  it('keeps the role in use, and clears it on request', async () => {
    const save = (body: object) => call({ method: 'PUT', url: '/api/settings', body });
    const saved = (await save({ allRegions: true, activeRole: { profile: 'default', arn: ADMIN_ROLE }, recentRoles: [{ profile: 'default', arn: ADMIN_ROLE }, { profile: 'default', arn: 'not-an-arn' }] })).json();
    expect(saved).toMatchObject({ allRegions: true, activeRole: { profile: 'default', arn: ADMIN_ROLE }, recentRoles: [{ profile: 'default', arn: ADMIN_ROLE }] });
    const cleared = (await save({ allRegions: false, activeRole: null, recentRoles: [] })).json();
    expect(cleared.activeRole).toBeUndefined();
    expect(cleared.allRegions).toBeUndefined();
    expect(cleared.recentRoles).toEqual([]);
  });

  it('saves a label with a name typed by the user, and drops a name that is too long', async () => {
    const save = (labels: object) => call({ method: 'PUT', url: '/api/settings', body: { labels } });
    const saved = (await save({ default: { color: 'purple', text: 'Client ACME (billing)' } })).json();
    expect(saved.labels).toEqual({ default: { color: 'purple', text: 'Client ACME (billing)' } });
    const tooLong = (await save({ default: { color: 'purple', text: 'x'.repeat(25) } })).json();
    expect(tooLong.labels.default).toEqual({ color: 'purple' });
  });

  it('saves valid settings and drops values of the wrong shape', async () => {
    const res = await call({
      method: 'PUT',
      url: '/api/settings',
      body: {
        activeProfile: 'sso-expired',
        region: 'not a region',
        pins: ['default', 'default', 42],
        labels: { default: { color: 'red', text: 'Production' }, other: { color: 'pink' } },
      },
    });
    expect(res.json()).toEqual({
      activeProfile: 'sso-expired',
      region: undefined,
      pins: ['default'],
      labels: { default: { color: 'red', text: 'Production' } },
      recentRoles: [],
    });
    const reloaded = new Store(join(dir, 'data')).snapshot.settings;
    expect(reloaded.activeProfile).toBe('sso-expired');
    expect(reloaded.pins).toEqual(['default']);
  });

  it('saves favourites and clears the history', async () => {
    const saved = await call({ method: 'PUT', url: '/api/favourites', body: { favourites: [{ name: 'Who am I', command: 'sts get-caller-identity' }, { name: '' }] } });
    expect(saved.json()).toEqual([{ name: 'Who am I', command: 'sts get-caller-identity' }]);
    expect((await call({ method: 'DELETE', url: '/api/history' })).json()).toEqual({ ok: true });
    expect(((await call({ url: '/api/state' })).json() as AppState).history).toEqual([]);
  });
});

describe('browser app files', () => {
  it('serves the app shell for page URLs and files for asset URLs', async () => {
    const page = await call({ url: '/', headers: { authorization: '' } });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain("default-src 'self'");
    expect((await call({ url: '/assets/app.js' })).headers['cache-control']).toContain('immutable');
    expect((await call({ url: '/assets/missing.js' })).statusCode).toBe(404);
    expect((await call({ url: '/api/nope' })).statusCode).toBe(404);
  });

  it('never resolves a path outside the public folder', () => {
    const publicDir = join(dir, 'public');
    expect(resolveStatic(publicDir, '/../secret.txt')).toBeNull();
    expect(resolveStatic(publicDir, '/%2e%2e/secret.txt')).toBeNull();
    expect(resolveStatic(publicDir, '/..%5csecret.txt')).toBeNull();
    expect(resolveStatic(publicDir, '/%00')).toBeNull();
    expect(resolveStatic(publicDir, '/profiles')?.path).toBe(join(publicDir, 'index.html'));
  });
});
