// The editor works on LF text; a CRLF file is written back as CRLF so a save
// never rewrites every line of it (Review Focus: CRLF).

export type Eol = '\n' | '\r\n';

/** The file's line ending, taken from its first line break. */
export function detectEol(text: string): Eol {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

export const toLf = (text: string): string => text.replace(/\r\n?/g, '\n');

export const fromLf = (text: string, eol: Eol): string =>
  eol === '\n' ? text : text.replace(/\n/g, '\r\n');
