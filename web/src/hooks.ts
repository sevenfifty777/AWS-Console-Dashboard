import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  AppInfo,
  AppState,
  LabelColor,
  ProfileType,
  ProfilesResponse,
  SessionState,
  SessionStatus,
  Settings,
  SettingsPatch,
} from '../../shared/types';
import { api } from './api';

export const REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ca-central-1',
  'sa-east-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'eu-south-1',
  'eu-south-2',
  'ap-south-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-east-1',
  'me-south-1',
  'me-central-1',
  'af-south-1',
  'il-central-1',
];

/** Ready-made labels to mark what a profile is used for. */
export const LABEL_PRESETS: { color: LabelColor; text: string }[] = [
  { color: 'red', text: 'Production' },
  { color: 'amber', text: 'Staging' },
  { color: 'green', text: 'Development' },
  { color: 'blue', text: 'Sandbox' },
  { color: 'purple', text: 'Shared' },
];

export const TYPE_LABEL: Record<ProfileType, string> = {
  sso: 'SSO',
  login: 'AWS login',
  keys: 'Access keys',
  'assume-role': 'Assume role',
  process: 'External process',
  'web-identity': 'Web identity',
  unknown: 'Unknown',
};

export const STATE_LABEL: Record<SessionState, string> = {
  valid: 'Signed in',
  expired: 'Expired',
  'no-credentials': 'No valid credentials',
  'access-denied': 'Access denied',
  network: 'Network problem',
  error: 'Error',
};

export const EMPTY_SETTINGS: Settings = { pins: [], labels: {} };

export function useInfo() {
  return useQuery({ queryKey: ['info'], queryFn: () => api<AppInfo>('/api/info') });
}

/** Re-read when the tab gets focus, so edits to the config file show up. */
export function useProfiles() {
  return useQuery({
    queryKey: ['profiles'],
    queryFn: () => api<ProfilesResponse>('/api/profiles'),
    refetchOnWindowFocus: true,
  });
}

export function useAppState() {
  return useQuery({ queryKey: ['state'], queryFn: () => api<AppState>('/api/state') });
}

/** The role name at the end of a role ARN. */
export const roleName = (arn: string) => arn.split('/').pop() ?? arn;

/** The account ID inside a role ARN. */
export const roleAccount = (arn: string) => /::(\d{12}):/.exec(arn)?.[1];

export function statusUrl(profile: string, role?: string, force = false): string {
  const params = new URLSearchParams({ profile });
  if (role) params.set('role', role);
  if (force) params.set('force', '1');
  return `/api/status?${params.toString()}`;
}

/** Status of a profile, or of a role switched to from that profile. */
export function useStatus(profile: string | undefined, enabled = true, role?: string) {
  return useQuery({
    queryKey: ['status', profile, role ?? ''],
    queryFn: () => api<SessionStatus>(statusUrl(profile!, role)),
    enabled: enabled && profile !== undefined,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}

/** Checks a profile again now, skipping the server's short cache. */
export async function recheckStatus(queryClient: QueryClient, profile: string): Promise<void> {
  const status = await api<SessionStatus>(statusUrl(profile, undefined, true));
  queryClient.setQueryData(['status', profile, ''], status);
}

export function useSaveSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => api<Settings>('/api/settings', { method: 'PUT', body: patch }),
    onSuccess: (settings) => {
      queryClient.setQueryData<AppState>(['state'], (old) => (old ? { ...old, settings } : old));
    },
  });
}
