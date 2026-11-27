import type { StreamEvent } from '../../shared/types';

// The server prints a link ending in #token=... at each start. The token stays in
// this tab only (sessionStorage) and is sent with every API call.
const STORAGE_KEY = 'aws-dashboard-token';
let token = sessionStorage.getItem(STORAGE_KEY) ?? '';
let unauthorizedListener: (() => void) | null = null;

/** Accepts the bare token or the whole link that contains it. */
export function setToken(value: string): void {
  const fromLink = /token=([A-Za-z0-9_-]+)/.exec(value);
  token = (fromLink ? fromLink[1] : value).trim();
  sessionStorage.setItem(STORAGE_KEY, token);
}

/** Picks the token up from the address bar, then removes it from there. */
export function initToken(): boolean {
  const match = /[#&]token=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  if (match) {
    setToken(match[1]);
    history.replaceState(null, '', window.location.pathname);
  }
  return token !== '';
}

/** Registers what to do when the server rejects the token. Returns an unsubscribe function. */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListener = listener;
  return () => {
    if (unauthorizedListener === listener) unauthorizedListener = null;
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

async function toError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // The answer had no JSON body.
  }
  if (res.status === 401) {
    sessionStorage.removeItem(STORAGE_KEY);
    token = '';
    unauthorizedListener?.();
  }
  const message = (body as { error?: string } | null)?.error ?? `The request failed (${res.status})`;
  return new ApiError(res.status, message, body);
}

function request(path: string, method: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await request(path, init.method ?? 'GET', init.body);
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

/** Calls a route that answers with one JSON event per line while a command runs. */
export async function streamApi(
  path: string,
  body: unknown,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await request(path, 'POST', body, signal);
  if (!res.ok) throw await toError(res);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) onEvent(JSON.parse(line) as StreamEvent);
    }
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
