import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  REGION_PATTERN,
  type AppInfo,
  type Profile,
  type ProfilesResponse,
  type ResourceInfo,
  type ResourceResult,
  type StreamEvent,
} from '../../shared/types';
import { StatusService, classifyCliError, loginCommand, logoutCommand } from './aws/auth';
import { runAws, type CliTarget } from './aws/cli';
import { analyseCommand, withDefaultOutput } from './aws/commandLine';
import { loadAwsFiles } from './aws/configParser';
import { authRoot, buildProfiles } from './aws/profiles';
import { RESOURCES } from './aws/resources';
import { SECURITY_HEADERS, isAllowedHost, isAllowedOrigin, tokenMatches } from './security';
import { resolveStatic } from './static';
import type { Store } from './store';

const RUN_TIMEOUT_MS = 10 * 60_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const RESOURCE_TIMEOUT_MS = 60_000;
const MAX_COMMAND_LENGTH = 20_000;
const NO_CLI = 'The AWS CLI was not found on this computer. Install it, then restart the dashboard.';

export interface AppContext {
  cli: CliTarget | null;
  cliVersion: string | null;
  store: Store;
  token: string;
  /** The port the server listens on; checked against the Host header. */
  port: number;
  /** Extra allowed origins, used for the Vite dev server only. */
  extraOrigins: string[];
  /** Folder with the built browser app, or null when it has not been built. */
  publicDir: string | null;
  /** Environment used to locate the AWS config files (tests point it at fixtures). */
  env?: NodeJS.ProcessEnv;
  /** The ~/.aws folder holding the sign-in caches (tests point it elsewhere). */
  awsDir?: string;
}

type Fields = Record<string, unknown>;

/** Starts a newline-delimited JSON answer that stays open while a command runs. */
function openStream(reply: FastifyReply) {
  reply.hijack();
  const res = reply.raw;
  const abort = new AbortController();
  let ended = false;
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  // The browser closing the connection is how a running command gets cancelled.
  res.on('close', () => {
    if (!ended) abort.abort();
  });
  return {
    signal: abort.signal,
    send(event: StreamEvent) {
      if (!ended && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
    },
    end() {
      ended = true;
      res.end();
    },
  };
}

export function buildApp(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  const statuses = new StatusService(ctx.cli, ctx.awsDir);

  const loadProfiles = (): Profile[] => buildProfiles(loadAwsFiles(ctx.env));
  const findProfile = (profiles: Profile[], name: unknown) =>
    typeof name === 'string' ? profiles.find((p) => p.name === name) : undefined;
  /** undefined = no override, null = not a region name. */
  const readRegion = (value: unknown): string | undefined | null => {
    if (value === undefined || value === null || value === '') return undefined;
    return typeof value === 'string' && REGION_PATTERN.test(value) ? value : null;
  };

  app.addHook('onRequest', async (req, reply) => {
    reply.headers(SECURITY_HEADERS);
    if (!isAllowedHost(req.headers.host, ctx.port)) {
      return reply.code(403).send({ error: 'This address is not allowed to reach the dashboard' });
    }
    if (!isAllowedOrigin(req.headers.origin, ctx.port, ctx.extraOrigins) || req.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send({ error: 'Requests from other sites are not allowed' });
    }
    if (req.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      if (!tokenMatches(req.headers.authorization, ctx.token)) {
        return reply.code(401).send({ error: 'Missing or wrong access token' });
      }
    }
  });

  app.get('/api/info', async (): Promise<AppInfo> => {
    const files = loadAwsFiles(ctx.env);
    return {
      cliPath: ctx.cli?.display ?? null,
      cliVersion: ctx.cliVersion,
      configFile: files.configPath,
      credentialsFile: files.credentialsPath,
      dataDir: ctx.store.dir,
    };
  });

  app.get('/api/profiles', async (): Promise<ProfilesResponse> => ({ profiles: loadProfiles() }));

  app.get('/api/status', async (req, reply) => {
    const query = req.query as Fields;
    const profiles = loadProfiles();
    const profile = findProfile(profiles, query.profile);
    if (!profile) return reply.code(400).send({ error: 'Unknown profile' });
    return statuses.get(profile, profiles, query.force === '1');
  });

  // --- settings, history, favourites -------------------------------------------------

  app.get('/api/state', async () => ctx.store.snapshot);
  app.put('/api/settings', async (req) => ctx.store.updateSettings(req.body));
  app.put('/api/favourites', async (req) => ctx.store.setFavourites(((req.body ?? {}) as Fields).favourites));
  app.delete('/api/history', async () => {
    ctx.store.clearHistory();
    return { ok: true };
  });

  // --- sign in and sign out ----------------------------------------------------------

  app.post('/api/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as Fields;
    if (!ctx.cli) return reply.code(503).send({ error: NO_CLI });
    const profiles = loadProfiles();
    const profile = findProfile(profiles, body.profile);
    if (!profile) return reply.code(400).send({ error: 'Unknown profile' });
    const root = authRoot(profile, profiles);
    const args = loginCommand(root, body.useDeviceCode === true);
    if (!args) return reply.code(400).send({ error: 'This kind of profile has no sign-in step' });

    const stream = openStream(reply);
    stream.send({ t: 'start', args });
    const result = await runAws(ctx.cli, args, {
      profile: root.name,
      timeoutMs: LOGIN_TIMEOUT_MS,
      signal: stream.signal,
      onStdout: (d) => stream.send({ t: 'out', d }),
      onStderr: (d) => stream.send({ t: 'err', d }),
    });
    statuses.invalidate();
    const { code, ms, timedOut, truncated, cancelled } = result;
    stream.send({ t: 'end', code, ms, timedOut, truncated, cancelled });
    stream.end();
    return reply;
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const body = (req.body ?? {}) as Fields;
    if (!ctx.cli) return reply.code(503).send({ error: NO_CLI });
    const profiles = loadProfiles();
    const profile = findProfile(profiles, body.profile);
    if (!profile) return reply.code(400).send({ error: 'Unknown profile' });
    const root = authRoot(profile, profiles);
    const args = logoutCommand(root);
    if (!args) return reply.code(400).send({ error: 'This kind of profile has no sign-out step' });
    const result = await runAws(ctx.cli, args, { profile: root.name, timeoutMs: 30_000 });
    statuses.invalidate();
    return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim() };
  });

  // --- command runner ----------------------------------------------------------------

  app.post('/api/run/check', async (req) => {
    const command = String(((req.body ?? {}) as Fields).command ?? '').slice(0, MAX_COMMAND_LENGTH);
    return analyseCommand(command);
  });

  app.post('/api/run', async (req, reply) => {
    const body = (req.body ?? {}) as Fields;
    if (!ctx.cli) return reply.code(503).send({ error: NO_CLI });
    const profile = findProfile(loadProfiles(), body.profile);
    if (!profile) return reply.code(400).send({ error: 'Unknown profile' });
    const region = readRegion(body.region);
    if (region === null) return reply.code(400).send({ error: 'That is not a region name' });
    const command = typeof body.command === 'string' ? body.command.trim() : '';
    if (command.length > MAX_COMMAND_LENGTH) return reply.code(400).send({ error: 'The command is too long' });

    const check = analyseCommand(command);
    if (check.blocked) return reply.code(400).send({ error: check.blocked });
    if (!check.readOnly && body.confirmed !== true) {
      return reply.code(409).send({ error: 'This command may change resources and needs confirmation', check });
    }

    const args = withDefaultOutput(check.args);
    const stream = openStream(reply);
    stream.send({ t: 'start', args });
    const result = await runAws(ctx.cli, args, {
      profile: profile.name,
      region,
      timeoutMs: RUN_TIMEOUT_MS,
      signal: stream.signal,
      onStdout: (d) => stream.send({ t: 'out', d }),
      onStderr: (d) => stream.send({ t: 'err', d }),
    });
    ctx.store.addHistory({
      profile: profile.name,
      region,
      command,
      at: new Date().toISOString(),
      exitCode: result.code,
    });
    const { code, ms, timedOut, truncated, cancelled } = result;
    stream.send({ t: 'end', code, ms, timedOut, truncated, cancelled });
    stream.end();
    return reply;
  });

  // --- resource views ----------------------------------------------------------------

  app.get('/api/resources', async (): Promise<ResourceInfo[]> =>
    RESOURCES.map(({ id, title, global, columns }) => ({ id, title, global, columns })),
  );

  app.get('/api/resources/:id', async (req, reply): Promise<ResourceResult | FastifyReply> => {
    const query = req.query as Fields;
    const def = RESOURCES.find((r) => r.id === (req.params as Fields).id);
    if (!def) return reply.code(404).send({ error: 'Unknown resource view' });
    if (!ctx.cli) return reply.code(503).send({ error: NO_CLI });
    const profile = findProfile(loadProfiles(), query.profile);
    if (!profile) return reply.code(400).send({ error: 'Unknown profile' });
    const region = readRegion(query.region);
    if (region === null) return reply.code(400).send({ error: 'That is not a region name' });

    const fetchedAt = new Date().toISOString();
    const result = await runAws(ctx.cli, [...def.args, '--query', def.query, '--output', 'json'], {
      profile: profile.name,
      region,
      timeoutMs: RESOURCE_TIMEOUT_MS,
    });
    if (result.timedOut) {
      return { rows: [], fetchedAt, error: { state: 'network', message: 'No answer from AWS after 60 seconds' } };
    }
    if (result.code !== 0) return { rows: [], fetchedAt, error: classifyCliError(result.stderr) };
    try {
      const rows: unknown = JSON.parse(result.stdout || 'null');
      return { rows: Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [], fetchedAt };
    } catch {
      return { rows: [], fetchedAt, error: { state: 'error', message: 'The AWS CLI returned an answer that is not JSON' } };
    }
  });

  // --- the browser app ---------------------------------------------------------------

  app.get('/*', async (req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
    if (!ctx.publicDir) {
      return reply.code(503).type('text/plain').send('The browser app has not been built yet. Run: npm run build');
    }
    const file = resolveStatic(ctx.publicDir, req.url);
    if (!file) return reply.code(404).type('text/plain').send('Not found');
    return reply.header('Cache-Control', file.cacheControl).type(file.type).send(readFileSync(file.path));
  });

  return app;
}
