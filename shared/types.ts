/** Types and constants shared by the server and the browser app. */

export type ProfileType = 'sso' | 'login' | 'keys' | 'assume-role' | 'process' | 'web-identity' | 'unknown';
export type LoginKind = 'sso' | 'login' | 'none';

export interface Profile {
  name: string;
  type: ProfileType;
  region?: string;
  accountId?: string;
  /** Role name for SSO and assume-role profiles; "user/name" style identity for aws login. */
  roleName?: string;
  ssoSession?: string;
  ssoStartUrl?: string;
  loginSession?: string;
  sourceProfile?: string;
  /** Profile whose sign-in this one relies on. Itself, unless it assumes a role from another profile. */
  authProfile: string;
  /** How authProfile signs in. */
  loginKind: LoginKind;
  /** Profiles with the same authGroup share one sign-in. */
  authGroup: string;
  /** Configuration problems worth showing, for example a missing sso-session. */
  problems: string[];
}

export type SessionState = 'valid' | 'expired' | 'no-credentials' | 'access-denied' | 'network' | 'error';

export interface SessionStatus {
  profile: string;
  state: SessionState;
  accountId?: string;
  arn?: string;
  message?: string;
  /** When the cached sign-in token expires (ISO date), if known and still in the future. */
  expiresAt?: string;
  /** True when the CLI holds a refresh token and renews the session by itself. */
  autoRenews?: boolean;
  checkedAt: string;
}

export const LABEL_COLORS = ['red', 'amber', 'green', 'blue', 'purple'] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

export interface ProfileLabel {
  color: LabelColor;
  text?: string;
}

/** An IAM role switched to from a profile. */
export interface ActiveRole {
  /** The profile the role is assumed from. */
  profile: string;
  arn: string;
}

export interface Settings {
  activeProfile?: string;
  /** Region override. Empty means "use the region of the profile". */
  region?: string;
  pins: string[];
  labels: Record<string, ProfileLabel>;
  /** Resource lists cover every enabled region instead of one. */
  allRegions?: boolean;
  /** The role in use. It only applies while its profile is the active one. */
  activeRole?: ActiveRole;
  /** Roles switched to lately, newest first. */
  recentRoles?: ActiveRole[];
}

/** A settings change. null clears the role in use. */
export type SettingsPatch = Partial<Omit<Settings, 'activeRole'>> & { activeRole?: ActiveRole | null };

export interface HistoryEntry {
  profile: string;
  /** ARN of the role the command ran as, when one was in use. */
  role?: string;
  region?: string;
  command: string;
  at: string;
  exitCode: number | null;
}

export interface Favourite {
  name: string;
  command: string;
}

export interface AppState {
  settings: Settings;
  history: HistoryEntry[];
  favourites: Favourite[];
}

export interface AppInfo {
  cliPath: string | null;
  cliVersion: string | null;
  configFile: string;
  credentialsFile: string;
  dataDir: string;
  /** False in read-only mode: the command runner refuses commands that may change resources. */
  allowChanges: boolean;
}

export interface ProfilesResponse {
  profiles: Profile[];
}

export interface CommandCheck {
  /** Arguments passed to the AWS CLI, without the leading "aws". */
  args: string[];
  /** False when the command may change something and needs confirmation. */
  readOnly: boolean;
  /** Set when the dashboard refuses to run the command; explains why. */
  blocked?: string;
}

/** One line of the newline-delimited JSON stream sent while a command runs. */
export type StreamEvent =
  | { t: 'start'; args: string[] }
  | { t: 'out'; d: string }
  | { t: 'err'; d: string }
  | { t: 'end'; code: number | null; ms: number; timedOut: boolean; truncated: boolean; cancelled: boolean };

export interface ResourceColumn {
  key: string;
  label: string;
}

export interface ResourceInfo {
  id: string;
  title: string;
  /** True when the service lists the same items whatever the region. */
  global: boolean;
  columns: ResourceColumn[];
  /** Set on a view that is opened from a row of another view (its id) instead of from the tab bar. */
  parent?: string;
  /** True for a view that another page shows, so it is left out of the Resources tab bar. */
  hidden?: boolean;
  /** Present when each row of this view can open another view. */
  drill?: ResourceDrill;
}

export interface ResourceDrill {
  /** id of the view to open. */
  view: string;
  /** Row key whose value is passed to that view. */
  paramKey: string;
  /** Row key shown as the heading of the opened view. */
  titleKey: string;
  /** Text of the button on each row. */
  label: string;
}

export interface RegionFailure {
  region: string;
  state: SessionState;
  message: string;
}

export interface ResourceResult {
  rows: Record<string, unknown>[];
  error?: { state: SessionState; message: string };
  fetchedAt: string;
  /** Present when the list was run in every region. Each row then has a "region" value. */
  regions?: {
    checked: number;
    /** True when the account's own region list could not be read and the usual regions were tried. */
    standardList: boolean;
    failed: RegionFailure[];
  };
}

/** AWS region names such as eu-west-1, us-gov-west-1, ap-southeast-2. */
export const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;

/** The ARN of an IAM role, for example arn:aws:iam::123456789012:role/path/Name. */
export const ROLE_ARN_PATTERN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,576}$/;
