import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Section = Record<string, string>;

export interface CredentialsEntry {
  hasKeys: boolean;
  hasSessionToken: boolean;
}

export interface AwsFiles {
  configPath: string;
  credentialsPath: string;
  /** Profile settings by profile name. Secret values are never kept. */
  profiles: Map<string, Section>;
  ssoSessions: Map<string, Section>;
  /** Which profiles have access keys, without the keys themselves. */
  credentials: Map<string, CredentialsEntry>;
}

const SECRET_KEYS = ['aws_access_key_id', 'aws_secret_access_key', 'aws_session_token', 'aws_security_token'];

/**
 * Parses the INI dialect used by the AWS CLI.
 * Keys are lower-cased, like the CLI does. Indented lines are nested settings
 * (for example the block under "s3 =") and are skipped: the dashboard does not need them.
 */
export function parseIni(text: string): Map<string, Section> {
  const sections = new Map<string, Section>();
  let current: Section | null = null;
  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const indented = /^\s/.test(rawLine);
    const header = indented ? null : /^\[([^\]]+)\]/.exec(trimmed);
    if (header) {
      const name = header[1]!.trim();
      current = sections.get(name) ?? {};
      sections.set(name, current);
      continue;
    }
    if (!current || indented) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    current[trimmed.slice(0, eq).trim().toLowerCase()] = trimmed.slice(eq + 1).trim();
  }
  return sections;
}

function unquote(name: string): string {
  return name.trim().replace(/^(["'])(.*)\1$/, '$2');
}

export function awsPaths(env: NodeJS.ProcessEnv = process.env): { configPath: string; credentialsPath: string } {
  const dir = join(homedir(), '.aws');
  return {
    configPath: env.AWS_CONFIG_FILE || join(dir, 'config'),
    credentialsPath: env.AWS_SHARED_CREDENTIALS_FILE || join(dir, 'credentials'),
  };
}

function withoutSecrets(section: Section): Section {
  const copy: Section = { ...section };
  for (const key of SECRET_KEYS) delete copy[key];
  return copy;
}

export function parseAwsFiles(
  configText: string,
  credentialsText: string,
  paths: { configPath: string; credentialsPath: string },
): AwsFiles {
  const profiles = new Map<string, Section>();
  const ssoSessions = new Map<string, Section>();
  const credentials = new Map<string, CredentialsEntry>();

  const noteKeys = (name: string, section: Section) => {
    if (!('aws_access_key_id' in section)) return;
    const entry = credentials.get(name) ?? { hasKeys: false, hasSessionToken: false };
    entry.hasKeys = true;
    entry.hasSessionToken ||= 'aws_session_token' in section;
    credentials.set(name, entry);
  };

  for (const [header, section] of parseIni(configText)) {
    const ssoSession = /^sso-session\s+(.+)$/.exec(header);
    if (ssoSession) {
      ssoSessions.set(unquote(ssoSession[1]!), section);
      continue;
    }
    const profile = /^profile\s+(.+)$/.exec(header);
    const name = header === 'default' ? 'default' : profile ? unquote(profile[1]!) : null;
    if (name === null) continue; // other section kinds, such as [services x]
    noteKeys(name, section);
    profiles.set(name, { ...profiles.get(name), ...withoutSecrets(section) });
  }

  // The credentials file names profiles directly: [name], not [profile name].
  for (const [header, section] of parseIni(credentialsText)) {
    const name = unquote(header);
    noteKeys(name, section);
    const extra = withoutSecrets(section);
    if (Object.keys(extra).length > 0) profiles.set(name, { ...extra, ...profiles.get(name) });
    else if (!credentials.has(name) && !profiles.has(name)) profiles.set(name, {});
  }

  return { ...paths, profiles, ssoSessions, credentials };
}

function readIfPresent(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export function loadAwsFiles(env: NodeJS.ProcessEnv = process.env): AwsFiles {
  const paths = awsPaths(env);
  return parseAwsFiles(readIfPresent(paths.configPath), readIfPresent(paths.credentialsPath), paths);
}
