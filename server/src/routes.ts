import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  REGION_PATTERN,
  ROLE_ARN_PATTERN,
  type AppInfo,
  type Profile,
  type ProfilesResponse,
  type RegionFailure,
  type ResourceInfo,
  type ResourceResult,
  type SessionState,
  type SessionStatus,
  type StreamEvent,
} from '../../shared/types';
import { StatusService, classifyCliError, loginCommand, logoutCommand } from './aws/auth';
import { runAws, type CliTarget, type RunOptions } from './aws/cli';
import { analyseCommand, withDefaultOutput } from './aws/commandLine';
import { loadAwsFiles } from './aws/configParser';
import { authRoot, buildProfiles } from './aws/profiles';
import { RegionService, mapLimit } from './aws/regions';
import { RESOURCES, type ResourceDef } from './aws/resources';
import { RoleSessions, type RoleResult } from './aws/roles';
import { SECURITY_HEADERS, isAllowedHost, isAllowedOrigin, tokenMatches } from './security';
import { resolveStatic } from './static';
import type { Store } from './store';

const RUN_TIMEOUT_MS = 10 * 60_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const RESOURCE_TIMEOUT_MS = 60_000;
const MAX_COMMAND_LENGTH = 20_000;
const REGIONS_IN_PARALLEL = 6;
const NO_CLI = 'The AWS CLI was not found on this computer. Install it, then restart the dashboard.';
const READ_ONLY =
  'Read-only mode: this command may change or delete resources, so it was not run. Only commands that read (describe, list, get and similar) are allowed. To allow it, switch to Write in the top bar.';

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
  /**
   * False (the way the dashboard starts) makes the command runner refuse commands that may
   * change resources. It can be switched while running; it is never saved, so every start
   * is read-only again.
   */
  allowChanges: boolean;
  /** Told when the mode is switched, so the terminal can show it. */
  onModeChange?: (allowChanges: boolean) => void;
  /** Environment used to locate the AWS config files (tests point it at fixtures). */
  env?: NodeJS.ProcessEnv;
  /** The ~/.aws folder holding the sign-in caches (tests point it elsewhere). */
  awsDir?: string;
}

type Fields = Record<string, unknown>;
type Problem = { state: SessionState; message: string };

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
  const roles = new RoleSessions(ctx.cli);
  const regions = new RegionService();

  const loadProfiles = (): Profile[] => buildProfiles(loadAwsFiles(ctx.env));
  const findProfile = (profiles: Profile[], name: unknown) =>
    typeof name === 'string' ? profiles.find((p) => p.name === name) : undefined;
  /** undefined = no override, null = not a region name. */
  const readRegion = (value: unknown): string | undefined | null => {
    if (value === undefined || value === null || value === '') return undefined;
    return typeof value === 'string' && REGION_PATTERN.test(value) ? value : null;
  };
  /** null = the request runs as the profile itself; otherwise the outcome of switching to the role. */
  const resolveRole = async (profile: Profile, role: unknown, force = false): Promise<RoleResult | null> => {
    if (role === undefined || role === null || role === '') return null;
    if (typeof role !== 'string' || !ROLE_ARN_PATTERN.test(role)) {
      return { ok: false, state: 'error', message: 'That is not the ARN of an IAM role' };
    }
    return roles.get(profile, role, force);
  };

  /** Runs the CLI call of one resource view and shapes its rows. */
  const fetchRows = async (
    cli: CliTarget,
    def: ResourceDef,
    paramArgs: string[],
    options: RunOptions,
  ): Promise<{ rows: Record<string, unknown>[] } | { error: Problem }> => {
    const result = await runAws(cli, [...def.args, ...paramArgs, '--query', def.query, '--output', 'json'], {
      ...options,
      timeoutMs: RESOURCE_TIMEOUT_MS,
    });
    if (result.timedOut) return { error: { state: 'network', message: 'No answer from AWS after 60 seconds' } };
    if (result.truncated) {
      return { error: { state: 'error', message: 'The list is larger than 10 MB. Use the command runner with a --query filter instead.' } };
    }
    if (result.code !== 0) return { error: classifyCliError(result.stderr) };
    try {
      const parsed: unknown = JSON.parse(result.stdout || 'null');
      const rows = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
      return { rows: def.mapRow ? rows.map(def.mapRow) : rows };
    } catch {
      return { error: { state: 'error', message: 'The AWS CLI returned an answer that is not JSON' } };
    }
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
      allowChanges: ctx.allowChanges,
    };
  });

  /**
   * Switches between read-only and write mode. Going to write mode needs the user's
   * explicit acknowledgement of the risk; going back to read-only needs nothing.
   */
  app.put('/api/mode', async (req, reply) => {
    const body = (req.body ?? {}) as Fields;
    const allow = body.allowChanges === true;
    if (allow && body.acknowledged !== true) {
      return reply.code(400).send({ error: 'Write mode needs the risk to be acknowledged first' });
    }
    if (ctx.allowChanges !== allow) {
      ctx.allowChanges = allow;
      ctx.onModeChange?.(allow);
    }
    return { allowChanges: ctx.allowChanges };
  });

  app.get('/api/profiles', async (): Promise<ProfilesResponse> => ({ profiles: loadProfiles() }));

  /** Status of a profile, or with "role" of that role switched to from the profile. */
  app.get('/api/status', async (req, reply): Promise<SessionStatus | FastifyReply> => {
    const query = req.query as Fields;
    const profiles = loadProfiles();
    const profile = findProfile(profiles, query.profile);
    if (!profile) return reply.code(400).send({ error: 'Unknown profile' });
    const force = query.force === '1';

    const role = await resolveRole(profile, query.role, force);
    if (!role) return statuses.get(profile, profiles, force);

    const base = { profile: profile.name, checkedAt: new Date().toISOString() };
    if (!role.ok) return { ...base, state: role.state, message: role.message };
    return {
      ...base,
      state: 'valid',
      accountId: /::(\d{12}):/.exec(String(query.role))?.[1],
      arn: role.session.assumedArn,
      expiresAt: role.session.expiresAt,
      autoRenews: true,
    };
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
    roles.invalidate();
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
    roles.invalidate();
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
    if (!check.readOnly && !ctx.allowChanges) return reply.code(403).send({ error: READ_ONLY, check });
    if (!check.readOnly && body.confirmed !== true) {
      return reply.code(409).send({ error: 'This command may change resources and needs confirmation', check });
    }

    const role = await resolveRole(profile, body.role);
    if (role && !role.ok) return reply.code(400).send({ error: `Could not switch to the role. ${role.message}` });

    const args = withDefaultOutput(check.args);
    const stream = openStream(reply);
    stream.send({ t: 'start', args });
    const result = await runAws(ctx.cli, args, {
      profile: profile.name,
      region,
      credentials: role?.session.credentials,
      timeoutMs: RUN_TIMEOUT_MS,
      signal: stream.signal,
      onStdout: (d) => stream.send({ t: 'out', d }),
      onStderr: (d) => stream.send({ t: 'err', d }),
    });
    ctx.store.addHistory({
      profile: profile.name,
      role: role ? String(body.role) : undefined,
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
    RESOURCES.map(({ id, title, global, columns, parent, hidden, drill }) => ({ id, title, global, columns, parent, hidden, drill })),
  );

  app.get('/api/resources/:id', async (req, reply): Promise<ResourceResult | FastifyReply> => {
    const query = req.query as Fields;
    const def = RESOURCES.find((r) => r.id === (req.params as Fields).id);
    if (!def) return reply.code(404).send({ error: 'Unknown resource view' });
    if (!ctx.cli) return reply.code(503).send({ error: NO_CLI });
    const cli = ctx.cli;
    const profile = findProfile(loadProfiles(), query.profile);
    if (!profile) return reply.code(400).send({ error: 'Unknown profile' });
    const region = readRegion(query.region);
    if (region === null) return reply.code(400).send({ error: 'That is not a region name' });

    // A view opened from a row of another view gets one value from that row. It must look
    // like the identifier it stands for, so it can never be read as another CLI option.
    const paramArgs: string[] = [];
    if (def.param) {
      const value = typeof query.param === 'string' ? query.param : '';
      if (!def.param.pattern.test(value)) return reply.code(400).send({ error: 'Open this view from a row of its parent list' });
      paramArgs.push(def.param.option, value);
    }

    const fetchedAt = new Date().toISOString();
    const role = await resolveRole(profile, query.role);
    if (role && !role.ok) return { rows: [], fetchedAt, error: { state: role.state, message: role.message } };
    const identity: RunOptions = { profile: profile.name, credentials: role?.session.credentials };

    if (query.allRegions !== '1' || def.global) {
      const one = await fetchRows(cli, def, paramArgs, { ...identity, region });
      return 'error' in one ? { rows: [], fetchedAt, error: one.error } : { rows: one.rows, fetchedAt };
    }

    // Every region: find the regions of the account, then run the same list in each.
    const found = await regions.list(cli, `${profile.name}|${role ? String(query.role) : ''}`, {
      ...identity,
      region: region ?? profile.region ?? 'us-east-1',
    });
    if (!found.ok) return { rows: [], fetchedAt, error: { state: found.state, message: found.message } };

    const perRegion = await mapLimit(found.regions, REGIONS_IN_PARALLEL, async (name) => ({
      name,
      result: await fetchRows(cli, def, paramArgs, { ...identity, region: name }),
    }));
    const rows: Record<string, unknown>[] = [];
    const failed: RegionFailure[] = [];
    for (const { name, result } of perRegion) {
      if ('error' in result) failed.push({ region: name, ...result.error });
      else for (const row of result.rows) rows.push({ region: name, ...row });
    }
    // When no region answered, the first reason is the reason (an expired session, for example).
    if (failed.length === found.regions.length && failed[0]) {
      return { rows: [], fetchedAt, error: { state: failed[0].state, message: failed[0].message } };
    }
    return { rows, fetchedAt, regions: { checked: found.regions.length, standardList: found.standardList, failed } };
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
