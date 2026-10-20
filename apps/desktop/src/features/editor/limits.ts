/** Notes above this size get the reduced Live Preview set (M2a §3.2). */
export const LARGE_NOTE_CHARS = 200 * 1024;

/** The most a text file the app edits may hold, as UTF-8 (M4b part 2 §6;
 *  `liber_session::TEXT_MAX_BYTES`). */
export const TEXT_MAX_BYTES = 2 * 1024 * 1024;
