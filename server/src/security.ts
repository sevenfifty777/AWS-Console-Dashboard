import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The dashboard can run AWS commands, so the local server must only answer the
 * browser tab it opened itself. Three checks together give that:
 *  - a random token, created at each start, required on every API call;
 *  - the Host header must name this server (stops DNS rebinding);
 *  - a request that says where it comes from (Origin) must come from this server.
 */

export function createToken(): string {
  return randomBytes(24).toString('base64url');
}

export function isAllowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function isAllowedOrigin(origin: string | undefined, port: number, extraOrigins: string[] = []): boolean {
  if (origin === undefined) return true; // same-origin GET requests carry no Origin header
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}` || extraOrigins.includes(origin);
}

export function tokenMatches(authorization: string | undefined, token: string): boolean {
  if (!authorization?.startsWith('Bearer ')) return false;
  const given = Buffer.from(authorization.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Headers sent with every answer. The page loads nothing from outside this server. */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};
