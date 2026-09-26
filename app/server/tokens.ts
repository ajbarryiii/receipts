// Unguessable link tokens for join and invite URLs.

/** No 0/O, 1/I/L: easy to read aloud and type from a phone. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** 14 characters of a 31-letter alphabet ≈ 69 bits. */
export const TOKEN_LENGTH = 14;

export function randomToken(length = TOKEN_LENGTH): string {
  // Rejection sampling keeps every letter equally likely. Four bytes per letter
  // leaves a vanishing chance of running short; if it ever happens, fail loudly.
  const limit = 256 - (256 % ALPHABET.length);
  const bytes = crypto.getRandomValues(new Uint8Array(length * 4));
  let token = "";
  for (const byte of bytes) {
    if (token.length === length) break;
    if (byte < limit) token += ALPHABET[byte % ALPHABET.length];
  }
  if (token.length < length) {
    throw new Error("Could not generate a link token. Try again.");
  }
  return token;
}

export function isTokenShaped(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 64 && /^[A-Za-z0-9]+$/.test(value);
}
