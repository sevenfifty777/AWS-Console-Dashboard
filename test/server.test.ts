import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppState, ResourceResult, StreamEvent } from '../shared/types';
import { findAwsCli } from '../server/src/aws/cli';
import { buildApp } from '../server/src/routes';
import { resolveStatic } from '../server/src/static';
import { Store } from '../server/src/store';

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-aws.mjs', import.meta.url));
const PORT = 4999;
const TOKEN = 'test-token';

let dir: string;
let app: FastifyInstance;

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

  app = buildApp({
    cli: findAwsCli({ AWS_DASHBOARD_CLI: FAKE_CLI }),
    cliVersion: 'fake',
    store: new Store(join(dir, 'data')),
    token: TOKEN,
    port: PORT,
    extraOrigins: [],
    publicDir: join(dir, 'public'),
    env: { AWS_CONFIG_FILE: join(dir, 'config'), AWS_SHARED_CREDENTIALS_FILE: join(dir, 'credentials') },
    awsDir: dir,
  });
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
    const list = (await call({ url: '/api/resources' })).json() as { id: string }[];
    expect(list.map((r) => r.id)).toEqual(['ec2', 's3', 'lambda', 'rds', 'cloudformation', 'alarms']);
    expect((await call({ url: '/api/resources/nope?profile=default' })).statusCode).toBe(404);
  });
});

describe('settings', () => {
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
