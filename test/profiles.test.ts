import { describe, expect, it } from 'vitest';
import { parseAwsFiles, parseIni } from '../server/src/aws/configParser';
import { buildProfiles } from '../server/src/aws/profiles';

// A config file shaped like a work setup: one SSO session shared by several
// profiles, an older-style SSO profile, assume-role chains, and a home-style aws login profile.
const CONFIG = `
[default]
region = eu-west-1
login_session = arn:aws:iam::111111111111:user/alice

[sso-session corp]
sso_start_url = https://corp.awsapps.com/start
sso_region = eu-west-1
sso_registration_scopes = sso:account:access

[profile dev-admin]
sso_session = corp
sso_account_id = 222222222222
sso_role_name = AdministratorAccess
region = eu-west-1
output = json

# production, read only
[profile prod-readonly]
sso_session = corp
sso_account_id = 333333333333
sso_role_name = ReadOnlyAccess
s3 =
  max_concurrent_requests = 20
  region = should-be-ignored
region = eu-central-1

[profile legacy-sso]
sso_start_url = https://old.awsapps.com/start#/
sso_region = us-east-1
sso_account_id = 444444444444
sso_role_name = PowerUser

[profile prod-deploy]
role_arn = arn:aws:iam::333333333333:role/deploy/Deployer
source_profile = dev-admin

[profile chained]
role_arn = arn:aws:iam::555555555555:role/Auditor
source_profile = prod-deploy

[profile broken-sso]
sso_session = missing
sso_account_id = 666666666666
sso_role_name = Anything

[profile loop-a]
role_arn = arn:aws:iam::777777777777:role/A
source_profile = loop-b

[profile loop-b]
role_arn = arn:aws:iam::777777777777:role/B
source_profile = loop-a

[profile vault]
credential_process = "C:\\Program Files\\vault\\vault.exe" aws dev
region = us-east-1

[profile "quoted name"]
region = us-west-2

[profile config-keys]
aws_access_key_id = FAKE_KEY_ID_IN_CONFIG
aws_secret_access_key = FAKE_SECRET_IN_CONFIG
`;

const CREDENTIALS = `
[legacy-keys]
aws_access_key_id = FAKE_KEY_ID
aws_secret_access_key = FAKE_SECRET

[temp-keys]
aws_access_key_id = FAKE_TEMP_KEY_ID
aws_secret_access_key = FAKE_TEMP_SECRET
aws_session_token = FAKE_SESSION_TOKEN
`;

const files = parseAwsFiles(CONFIG, CREDENTIALS, { configPath: 'config', credentialsPath: 'credentials' });
const profiles = buildProfiles(files);
const get = (name: string) => {
  const profile = profiles.find((p) => p.name === name);
  if (!profile) throw new Error(`profile ${name} was not parsed`);
  return profile;
};

describe('parseIni', () => {
  it('reads sections and keys, ignoring comments, nested settings, a BOM and Windows line endings', () => {
    const parsed = parseIni('\uFEFF[one]\r\n# comment\r\n; other\r\nKey = Value = x\r\nnested =\r\n  inner = 1\r\n[two]\r\nb=2\r\n');
    expect([...parsed.keys()]).toEqual(['one', 'two']);
    expect(parsed.get('one')).toEqual({ key: 'Value = x', nested: '' });
    expect(parsed.get('two')).toEqual({ b: '2' });
  });
});

describe('profiles from the config files', () => {
  it('lists every profile from both files, in file order', () => {
    expect(profiles.map((p) => p.name)).toEqual([
      'default',
      'dev-admin',
      'prod-readonly',
      'legacy-sso',
      'prod-deploy',
      'chained',
      'broken-sso',
      'loop-a',
      'loop-b',
      'vault',
      'quoted name',
      'config-keys',
      'legacy-keys',
      'temp-keys',
    ]);
  });

  it('recognises an aws login profile and reads the account from its ARN', () => {
    expect(get('default')).toMatchObject({
      type: 'login',
      loginKind: 'login',
      accountId: '111111111111',
      roleName: 'user/alice',
      region: 'eu-west-1',
      authProfile: 'default',
    });
  });

  it('groups SSO profiles that share an sso-session', () => {
    const dev = get('dev-admin');
    const prod = get('prod-readonly');
    expect(dev).toMatchObject({ type: 'sso', loginKind: 'sso', accountId: '222222222222', roleName: 'AdministratorAccess' });
    expect(dev.ssoStartUrl).toBe('https://corp.awsapps.com/start');
    expect(prod.authGroup).toBe(dev.authGroup);
    expect(dev.authGroup).toBe('sso:corp');
  });

  it('does not let a nested settings block change the profile', () => {
    expect(get('prod-readonly').region).toBe('eu-central-1');
  });

  it('supports older SSO profiles without an sso-session', () => {
    const legacy = get('legacy-sso');
    expect(legacy).toMatchObject({ type: 'sso', loginKind: 'sso', accountId: '444444444444' });
    expect(legacy.ssoSession).toBeUndefined();
    expect(legacy.ssoStartUrl).toBe('https://old.awsapps.com/start#/');
    expect(legacy.authGroup).not.toBe(get('dev-admin').authGroup);
  });

  it('makes assume-role profiles sign in through the end of their source_profile chain', () => {
    expect(get('prod-deploy')).toMatchObject({
      type: 'assume-role',
      accountId: '333333333333',
      roleName: 'Deployer',
      authProfile: 'dev-admin',
      loginKind: 'sso',
      authGroup: 'sso:corp',
    });
    expect(get('chained')).toMatchObject({ authProfile: 'dev-admin', loginKind: 'sso', accountId: '555555555555' });
  });

  it('reports configuration problems instead of failing', () => {
    expect(get('broken-sso').problems.join(' ')).toContain('sso-session "missing"');
    expect(get('loop-a').problems.join(' ')).toContain('loops');
    expect(get('loop-a').loginKind).toBe('none');
    expect(get('quoted name')).toMatchObject({ type: 'unknown', region: 'us-west-2' });
    expect(get('quoted name').problems).toHaveLength(1);
  });

  it('recognises access keys and external credential processes', () => {
    expect(get('legacy-keys')).toMatchObject({ type: 'keys', loginKind: 'none' });
    expect(get('temp-keys').type).toBe('keys');
    expect(get('config-keys').type).toBe('keys');
    expect(get('vault')).toMatchObject({ type: 'process', region: 'us-east-1' });
    expect(files.credentials.get('temp-keys')).toEqual({ hasKeys: true, hasSessionToken: true });
  });

  it('never keeps secret values', () => {
    const everything = JSON.stringify([[...files.profiles], [...files.credentials], profiles]);
    expect(everything).not.toContain('FAKE');
  });
});
