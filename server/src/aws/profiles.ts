import type { LoginKind, Profile, ProfileType } from '../../../shared/types';
import type { AwsFiles } from './configParser';

function parseArn(arn: string | undefined): { accountId?: string; resource?: string } {
  const match = arn ? /^arn:[^:]*:(?:iam|sts)::(\d{12}):(.+)$/.exec(arn) : null;
  return match ? { accountId: match[1], resource: match[2] } : {};
}

/** Turns the parsed config files into the profile list shown by the dashboard. */
export function buildProfiles(files: AwsFiles): Profile[] {
  const names = [...new Set([...files.profiles.keys(), ...files.credentials.keys()])];
  const byName = new Map<string, Profile>();

  for (const name of names) {
    const sec = files.profiles.get(name) ?? {};
    const problems: string[] = [];
    let type: ProfileType;
    let loginKind: LoginKind = 'none';
    let authGroup: string;
    let accountId: string | undefined;
    let roleName: string | undefined;
    let ssoSession: string | undefined;
    let ssoStartUrl: string | undefined;

    if (sec.role_arn && (sec.source_profile || sec.credential_source)) {
      type = 'assume-role';
      const arn = parseArn(sec.role_arn);
      accountId = arn.accountId;
      roleName = arn.resource?.split('/').pop();
      authGroup = `role:${name}`;
    } else if (sec.role_arn && sec.web_identity_token_file) {
      type = 'web-identity';
      const arn = parseArn(sec.role_arn);
      accountId = arn.accountId;
      roleName = arn.resource?.split('/').pop();
      authGroup = `web-identity:${name}`;
    } else if (sec.sso_session || sec.sso_start_url || sec.sso_account_id) {
      type = 'sso';
      loginKind = 'sso';
      ssoSession = sec.sso_session;
      const session = ssoSession ? files.ssoSessions.get(ssoSession) : undefined;
      if (ssoSession && !session) problems.push(`sso-session "${ssoSession}" is not defined in the config file`);
      ssoStartUrl = session?.sso_start_url ?? sec.sso_start_url;
      accountId = sec.sso_account_id;
      roleName = sec.sso_role_name;
      authGroup = `sso:${ssoSession ?? ssoStartUrl ?? name}`;
    } else if (sec.login_session) {
      type = 'login';
      loginKind = 'login';
      const arn = parseArn(sec.login_session);
      accountId = arn.accountId;
      roleName = arn.resource;
      authGroup = `login:${sec.login_session}`;
    } else if (sec.credential_process) {
      type = 'process';
      authGroup = `process:${name}`;
    } else if (files.credentials.get(name)?.hasKeys) {
      type = 'keys';
      authGroup = `keys:${name}`;
    } else {
      type = 'unknown';
      authGroup = `unknown:${name}`;
      problems.push('No sign-in settings found for this profile in the config files');
    }

    byName.set(name, {
      name,
      type,
      region: sec.region,
      accountId,
      roleName,
      ssoSession,
      ssoStartUrl,
      loginSession: sec.login_session,
      sourceProfile: sec.source_profile,
      authProfile: name,
      loginKind,
      authGroup,
      problems,
    });
  }

  // Assume-role profiles sign in through the profile at the end of their source_profile chain.
  for (const profile of byName.values()) {
    if (profile.type !== 'assume-role' || !profile.sourceProfile) continue;
    const seen = new Set([profile.name]);
    let current = profile;
    let broken = false;
    while (current.type === 'assume-role' && current.sourceProfile) {
      const next = byName.get(current.sourceProfile);
      if (!next) {
        profile.problems.push(`source_profile "${current.sourceProfile}" does not exist`);
        broken = true;
        break;
      }
      if (seen.has(next.name)) {
        profile.problems.push('The source_profile chain loops back on itself');
        broken = true;
        break;
      }
      seen.add(next.name);
      current = next;
    }
    if (!broken && current !== profile && current.type !== 'assume-role') {
      profile.authProfile = current.name;
      profile.loginKind = current.loginKind;
      profile.authGroup = current.authGroup;
    }
  }

  return [...byName.values()];
}

/** The profile that actually signs in for the given one. */
export function authRoot(profile: Profile, all: Profile[]): Profile {
  return all.find((p) => p.name === profile.authProfile) ?? profile;
}
