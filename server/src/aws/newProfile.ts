import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { REGION_PATTERN } from '../../../shared/types';
import { runAws, type CliTarget } from './cli';
import type { AwsFiles } from './configParser';

/**
 * Creating profiles, the three ways the AWS CLI offers:
 *   access keys  -> "aws configure", with the answers typed in for the user
 *   aws login    -> "aws login --profile NAME --region REGION" (run by the route, as it opens the browser)
 *   SSO          -> "aws configure set" for each setting of the profile
 *
 * The CLI does the writing, with one exception: it has no command that creates an
 * [sso-session] block without a keyboard, so that block is appended here.
 */

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@+=-]{0,63}$/;
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const START_URL = /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~/#-]*)?$/;
const ACCOUNT_ID = /^\d{12}$/;
const ROLE_NAME = /^[A-Za-z0-9_+=,.@][A-Za-z0-9_+=,.@-]{0,63}$/;
const ACCESS_KEY_ID = /^[A-Z0-9]{16,128}$/;
/** One line, no spaces: the value is typed into the CLI as a single answer. */
const SECRET_KEY = /^[A-Za-z0-9/+=]{16,256}$/;

const NOT_A_REGION = 'That is not a region name. A region looks like eu-west-1.';

type Fields = Record<string, unknown>;
export type Outcome = { ok: true; name: string } | { ok: false; error: string };

const fail = (error: string): Outcome => ({ ok: false, error });
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const lastLine = (stderr: string) => stderr.trim().split(/\r?\n/).pop() || 'no reason given';

/** A name that is well formed and not taken yet. Creating never overwrites a profile. */
function newName(value: unknown, files: AwsFiles): { name: string } | { error: string } {
  const name = text(value);
  if (!PROFILE_NAME.test(name)) {
    return { error: 'The profile name must be 1 to 64 characters: letters, digits and _ . @ + = - , starting with a letter or digit.' };
  }
  if (files.profiles.has(name) || files.credentials.has(name)) return { error: `A profile named "${name}" already exists.` };
  return { name };
}

/** Checks the request for a new "aws login" profile; the route then runs the sign-in. */
export function readLoginRequest(files: AwsFiles, body: Fields): { ok: true; name: string; region: string } | { ok: false; error: string } {
  const named = newName(body.name, files);
  if ('error' in named) return { ok: false, error: named.error };
  const region = text(body.region);
  if (!REGION_PATTERN.test(region)) return { ok: false, error: NOT_A_REGION };
  return { ok: true, name: named.name, region };
}

/** Access keys, stored by "aws configure" itself: keys in the credentials file, region in the config file. */
export async function createKeysProfile(cli: CliTarget, files: AwsFiles, body: Fields): Promise<Outcome> {
  const named = newName(body.name, files);
  if ('error' in named) return fail(named.error);
  const accessKeyId = text(body.accessKeyId);
  if (!ACCESS_KEY_ID.test(accessKeyId)) return fail('The access key ID should be 16 or more capital letters and digits, for example AKIA….');
  const secretAccessKey = text(body.secretAccessKey);
  if (!SECRET_KEY.test(secretAccessKey)) return fail('The secret access key does not look right. Paste it again, without spaces.');
  const region = text(body.region);
  if (!REGION_PATTERN.test(region)) return fail(NOT_A_REGION);

  // "aws configure" asks four questions: key ID, secret key, region, output format.
  // Answering them here keeps the secret key out of the command line.
  const result = await runAws(cli, ['configure', '--profile', named.name], {
    input: `${[accessKeyId, secretAccessKey, region, 'json'].join('\n')}\n`,
    timeoutMs: 30_000,
  });
  if (result.code !== 0) return fail(`The AWS CLI could not save the profile: ${lastLine(result.stderr)}`);
  return { ok: true, name: named.name };
}

/** Adds an [sso-session] block at the end of the config file. Existing content is left as it is. */
export function appendSsoSession(configPath: string, name: string, startUrl: string, region: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
  let existing = '';
  try {
    existing = readFileSync(configPath, 'utf8');
  } catch {
    // No config file yet: the block becomes its first content.
  }
  const gap = existing === '' ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  const block = [`[sso-session ${name}]`, `sso_start_url = ${startUrl}`, `sso_region = ${region}`, 'sso_registration_scopes = sso:account:access'];
  appendFileSync(configPath, `${gap}${block.join('\n')}\n`);
}

/** An SSO profile on an existing SSO session, or on a new one described by body.newSession. */
export async function createSsoProfile(cli: CliTarget, files: AwsFiles, body: Fields): Promise<Outcome> {
  const named = newName(body.name, files);
  if ('error' in named) return fail(named.error);
  const session = text(body.session);
  if (!SESSION_NAME.test(session)) return fail('The SSO session name must be 1 to 64 letters, digits, - or _ .');
  const accountId = text(body.accountId);
  if (!ACCOUNT_ID.test(accountId)) return fail('The account ID must be 12 digits.');
  const roleName = text(body.roleName);
  if (!ROLE_NAME.test(roleName)) return fail('The role name may hold letters, digits and _ + = , . @ - , for example ReadOnlyAccess.');
  const region = text(body.region);
  if (!REGION_PATTERN.test(region)) return fail(NOT_A_REGION);

  const fresh = body.newSession && typeof body.newSession === 'object' ? (body.newSession as Fields) : null;
  if (fresh) {
    if (files.ssoSessions.has(session)) return fail(`An SSO session named "${session}" already exists. Choose it from the list instead.`);
    const startUrl = text(fresh.startUrl);
    if (!START_URL.test(startUrl)) return fail('The start URL must begin with https:// , for example https://my-company.awsapps.com/start');
    const ssoRegion = text(fresh.region);
    if (!REGION_PATTERN.test(ssoRegion)) return fail(`The SSO region is not a region name. ${NOT_A_REGION}`);
    try {
      appendSsoSession(files.configPath, session, startUrl, ssoRegion);
    } catch (err) {
      return fail(`Could not add the SSO session to ${files.configPath}: ${(err as Error).message}`);
    }
  } else if (!files.ssoSessions.has(session)) {
    return fail(`There is no SSO session named "${session}".`);
  }

  const settings: [string, string][] = [
    ['sso_session', session],
    ['sso_account_id', accountId],
    ['sso_role_name', roleName],
    ['region', region],
  ];
  for (const [key, value] of settings) {
    const result = await runAws(cli, ['configure', 'set', key, value, '--profile', named.name], { timeoutMs: 30_000 });
    if (result.code !== 0) return fail(`The AWS CLI could not save ${key}: ${lastLine(result.stderr)}`);
  }
  return { ok: true, name: named.name };
}
