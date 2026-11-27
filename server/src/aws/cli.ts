import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** The executable that stands for "aws". */
export interface CliTarget {
  command: string;
  prefixArgs: string[];
  /** Path shown to the user. */
  display: string;
}

/**
 * Finds the AWS CLI. AWS_DASHBOARD_CLI overrides the search; when it points at a
 * JavaScript file it is run with Node (used by the tests to fake the CLI).
 */
export function findAwsCli(env: NodeJS.ProcessEnv = process.env): CliTarget | null {
  const override = env.AWS_DASHBOARD_CLI;
  if (override) {
    if (/\.(mjs|cjs|js)$/i.test(override)) return { command: process.execPath, prefixArgs: [override], display: override };
    return { command: override, prefixArgs: [], display: override };
  }
  const fileName = process.platform === 'win32' ? 'aws.exe' : 'aws';
  const pathValue = env.PATH ?? env.Path ?? '';
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir.replace(/^"(.*)"$/, '$1'), fileName);
    if (existsSync(candidate)) return { command: candidate, prefixArgs: [], display: candidate };
  }
  return null;
}

/** Temporary keys of an assumed role. */
export interface RoleCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export interface RunOptions {
  profile?: string;
  region?: string;
  /** Run as an assumed role. The profile is still used for its region and other settings. */
  credentials?: RoleCredentials;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  cancelled: boolean;
  ms: number;
}

/** Variables that would silently override the chosen profile if they leaked into the child. */
const OVERRIDING_VARS = new Set([
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
]);

export function childEnv(
  base: NodeJS.ProcessEnv,
  profile?: string,
  region?: string,
  credentials?: RoleCredentials,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!OVERRIDING_VARS.has(key.toUpperCase())) env[key] = value;
  }
  if (profile) env.AWS_PROFILE = profile;
  if (credentials) {
    // Keys in the environment win over the profile's own sign-in, while the profile
    // named by AWS_PROFILE still supplies the region and other settings.
    env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
    env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
    env.AWS_SESSION_TOKEN = credentials.sessionToken;
  }
  if (region) {
    env.AWS_REGION = region;
    env.AWS_DEFAULT_REGION = region;
  }
  env.AWS_PAGER = '';
  env.AWS_CLI_AUTO_PROMPT = 'off';
  env.PYTHONUTF8 = '1';
  return env;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // aws.exe can start helper processes; taskkill /T ends the whole tree.
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () =>
      child.kill(),
    );
  } else {
    child.kill('SIGTERM');
  }
}

/**
 * Runs the AWS CLI with the given arguments. No shell is involved: the arguments
 * go straight to the executable, so shell operators in them have no meaning.
 */
export function runAws(target: CliTarget, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const child = spawn(target.command, [...target.prefixArgs, ...args], {
      env: childEnv(process.env, options.profile, options.region, options.credentials),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs ?? 60_000);

    const onAbort = () => {
      cancelled = true;
      killTree(child);
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number | null, startError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (startError) stderr += startError;
      resolve({ code, stdout, stderr, timedOut, truncated, cancelled, ms: Date.now() - started });
    };

    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      if (truncated) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        truncated = true;
        killTree(child);
        return;
      }
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr!.on('data', (chunk: string) => {
      if (stderr.length < 200_000) stderr += chunk;
      options.onStderr?.(chunk);
    });
    child.on('error', (err) => finish(null, `Could not start the AWS CLI: ${err.message}`));
    child.on('close', (code) => finish(code));
  });
}
