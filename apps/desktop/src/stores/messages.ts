import i18next from 'i18next';
import type { CommandError } from '../ipc';

/** Translated message for a backend error (`errors.<kind>`). */
export const errorMessage = (e: CommandError): string =>
  i18next.t(`errors.${e.kind}`, { message: e.message });
