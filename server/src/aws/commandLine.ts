import type { CommandCheck } from '../../../shared/types';

/**
 * Splits typed command text into arguments, the way a simple shell would:
 * spaces separate arguments, single and double quotes group them, and inside
 * double quotes \" and \\ are escapes. Nothing else is interpreted, so | & > $ are plain text.
 * A line ending in \, ` or ^ continues on the next line, to allow pasted multi-line commands.
 */
export function splitCommandLine(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && ch === '\\' && (input[i + 1] === '"' || input[i + 1] === '\\')) current += input[++i];
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if ((ch === '\\' || ch === '`' || ch === '^') && /^\r?\n/.test(input.slice(i + 1))) {
      i += input[i + 1] === '\r' ? 2 : 1;
    } else if (/\s/.test(ch)) {
      if (started || current) args.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
    }
  }
  if (quote) throw new Error(`The command has an unclosed ${quote} quote`);
  if (started || current) args.push(current);
  return args;
}

/** Global CLI options that are followed by a value. */
const VALUE_OPTIONS = new Set([
  '--profile',
  '--region',
  '--output',
  '--query',
  '--endpoint-url',
  '--color',
  '--ca-bundle',
  '--cli-read-timeout',
  '--cli-connect-timeout',
  '--cli-binary-format',
]);

/** Operation names that only read. Anything else asks for confirmation. */
const READ_ONLY_OPERATION =
  /^(describe|list|get|ls|head|search|lookup|scan|query|batch-get|view|show|check|validate|estimate|simulate|filter|preview|wait|help|select|detect|discover|tail|presign|decode|verify)(-|$)/;

const INTERACTIVE = 'This command needs keyboard input, which the dashboard cannot give. Run it in a terminal.';
const USE_PROFILES_PAGE = 'Use the Sign in and Sign out buttons on the Profiles page for this.';

/** The service and operation: the first two arguments that are not options. */
function serviceAndOperation(args: string[]): [string | undefined, string | undefined] {
  const found: string[] = [];
  for (let i = 0; i < args.length && found.length < 2; i++) {
    const arg = args[i]!;
    if (arg.startsWith('-')) {
      if (VALUE_OPTIONS.has(arg)) i++;
      continue;
    }
    found.push(arg.toLowerCase());
  }
  return [found[0], found[1]];
}

function blockReason(args: string[], service?: string, operation?: string): string | undefined {
  if (args.some((a) => a.includes('\0'))) return 'The command contains a character that is not allowed.';
  if (args.includes('--cli-auto-prompt')) return INTERACTIVE;
  if (service === 'login' || service === 'logout') return USE_PROFILES_PAGE;
  if (service === 'sso' && (operation === 'login' || operation === 'logout')) return USE_PROFILES_PAGE;
  if (service === 'configure') {
    if (!operation || ['sso', 'sso-session', 'wizard', 'import'].includes(operation)) return INTERACTIVE;
    const secret = /secret_access_key|session_token/i;
    if (operation === 'export-credentials' || (operation === 'get' && args.some((a) => secret.test(a)))) {
      return 'This command prints secret keys. The dashboard does not display credentials; run it in a terminal.';
    }
  }
  if (service === 'ssm' && operation === 'start-session') return INTERACTIVE;
  if (service === 'ecs' && operation === 'execute-command') return INTERACTIVE;
  if (service === 'ec2-instance-connect' && (operation === 'ssh' || operation === 'open-tunnel')) return INTERACTIVE;
  return undefined;
}

function isReadOnly(service?: string, operation?: string): boolean {
  if (!service || !operation) return true; // only global options such as --version, or a bare service: prints usage
  if (service === 'help') return true;
  if (service === 'configure') return ['list', 'list-profiles', 'get'].includes(operation);
  return READ_ONLY_OPERATION.test(operation);
}

/** Checks typed command text before it is run. */
export function analyseCommand(input: string): CommandCheck {
  let args: string[];
  try {
    args = splitCommandLine(input);
  } catch (err) {
    return { args: [], readOnly: false, blocked: (err as Error).message };
  }
  if (/^aws(\.exe)?$/i.test(args[0] ?? '')) args = args.slice(1);
  if (args.length === 0) return { args, readOnly: false, blocked: 'Type an AWS CLI command, for example: s3 ls' };

  const [service, operation] = serviceAndOperation(args);
  const blocked = blockReason(args, service, operation);
  return { args, readOnly: !blocked && isReadOnly(service, operation), blocked };
}

/** Adds --output json unless a format was chosen or the command prints plain text anyway. */
export function withDefaultOutput(args: string[]): string[] {
  if (args.some((a) => a === '--output' || a.startsWith('--output=') || a === '--version')) return args;
  const [service, operation] = serviceAndOperation(args);
  if (!service || !operation) return args;
  if (['s3', 'configure', 'help'].includes(service)) return args;
  if (operation === 'help' || operation === 'wait' || args.includes('help')) return args;
  if (service === 'logs' && operation === 'tail') return args;
  return [...args, '--output', 'json'];
}
