import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAwsCli, runAws } from './aws/cli';
import { buildApp, type AppContext } from './routes';
import { createToken } from './security';
import { Store } from './store';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4780;
const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

const argv = process.argv.slice(2);
const hasFlag = (name: string) => argv.includes(name);
const optionValue = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, HOST, () => probe.close(() => resolve(true)));
  });
}

function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(command as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: true })
    .on('error', () => console.log('  Could not open the browser. Open the link above yourself.'))
    .unref();
}

async function main(): Promise<void> {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log('Usage: node aws-dashboard.mjs [--port <number>] [--no-open] [--allow-changes]');
    console.log('  --allow-changes  let the command runner run commands that change resources (it asks first)');
    return;
  }
  const dev = hasFlag('--dev');
  const allowChanges = hasFlag('--allow-changes');
  const fixedPort = optionValue('--port') ?? process.env.AWS_DASHBOARD_PORT;
  let port = Number(fixedPort ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`"${fixedPort}" is not a port number`);

  // Without an explicit port, move up to the next free one. The dev setup needs the default port.
  if (!fixedPort && !dev) {
    for (let tries = 0; tries < 20 && !(await portIsFree(port)); tries++) port++;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const publicDir =
    [join(here, 'public'), join(here, '..', '..', 'dist', 'public')].find((dir) => existsSync(join(dir, 'index.html'))) ?? null;

  const cli = findAwsCli();
  const ctx: AppContext = {
    cli,
    cliVersion: null,
    store: new Store(),
    token: createToken(),
    port,
    extraOrigins: dev ? DEV_ORIGINS : [],
    publicDir,
    allowChanges,
  };
  if (cli) {
    void runAws(cli, ['--version'], { timeoutMs: 15_000 }).then((result) => {
      ctx.cliVersion = result.code === 0 ? result.stdout.trim() : null;
    });
  }

  const app = buildApp(ctx);
  await app.listen({ host: HOST, port });

  const base = dev ? 'http://localhost:5173' : `http://${HOST}:${port}`;
  const url = `${base}/#token=${ctx.token}`;
  console.log('');
  console.log('AWS Console Dashboard');
  console.log(`  Open:     ${url}`);
  console.log(`  AWS CLI:  ${cli ? cli.display : 'not found - install the AWS CLI and restart'}`);
  console.log(
    allowChanges
      ? '  Mode:     changes allowed - the command runner asks before a command that may change resources'
      : '  Mode:     read-only - the command runner refuses commands that may change resources',
  );
  if (!publicDir && !dev) console.log('  The browser app is not built yet. Run: npm run build');
  console.log('  The link holds a one-time access token for this run. Stop with Ctrl+C.');
  console.log('');

  if (!dev && !hasFlag('--no-open') && publicDir) openInBrowser(url);

  const stop = () => {
    void app.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
