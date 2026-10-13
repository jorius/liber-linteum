// Percent-decoding that never throws (I4): link targets come from page text,
// and a bare `%` (`#100%`, `B.md#50%`) is not valid percent-encoding.

/** `decodeURIComponent(s)`, or `s` as written when it isn't valid encoding. */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
