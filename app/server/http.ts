// Endpoint plumbing: bot authentication and public URL resolution.

/** Minimum accepted length for RECEIPTS_BOT_SECRET. */
export const MIN_BOT_SECRET_LENGTH = 24;

/** True when `authorization` is exactly "Bearer <secret>". Compares in constant time. */
export function bearerMatches(authorization: string | null, secret: string | undefined): boolean {
  if (!authorization || !secret) {
    return false;
  }
  const expected = `Bearer ${secret}`;
  // Length is not secret: the secret's length is fixed by configuration.
  if (authorization.length !== expected.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= authorization.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

/** Public web origin for links: APP_URL when set, else the request origin. No trailing slash. */
export function resolveAppUrl(configured: string | undefined, requestUrl: string): string {
  const base = configured?.trim() || new URL(requestUrl).origin;
  return base.replace(/\/+$/, "");
}
