// Relationships between pages (M3b §2, §3, §5): read from and written to the
// source page's `related:`. A page with a live editor document gets the edit
// there (undoable when it's on screen); any other page is read, edited and
// written back against its hash, retried once when it changed meanwhile.
import i18next from 'i18next';
import { detectEol, fromLf, toLf } from '../features/editor/eol';
import { linksResolve, linkTarget, pageRead, pageWrite } from '../ipc';
import type { FrontmatterEdit } from '../markdown/frontmatterEdit';
import {
  appendRelated,
  readRelated,
  removeRelated,
  updateRelated,
  type RelatedChange,
  type RelatedEntry,
} from '../markdown/related';
import { useEditorStore } from './editorStore';
import { errorMessage } from './messages';
import { useToastStore } from './toastStore';
import { nameOf } from './tree';

/** A relationship of `source`, with the page its link resolves to. */
export interface Relation extends RelatedEntry {
  source: string;
  /** The target page's vault path; `null` when the link resolves to nothing. */
  path: string | null;
}

/** `pending`: made in the page's live document, but its save hasn't
 *  reached the disk yet (it keeps retrying; final review m6). */
export type RelateResult =
  | { status: 'created'; pending?: true }
  | { status: 'exists'; index: number }
  | { status: 'failed' };

/** An edit that found the list changed under it: refused without a toast
 *  (the caller re-reads). */
const STALE = 'stale' as const;
type Edit = (text: string) => FrontmatterEdit | typeof STALE;

const toast = (message: string) => useToastStore.getState().push({ message, tone: 'error' });
const pageName = (path: string) => nameOf(path).replace(/\.md$/i, '');

/** The page's text: its live editor document's (the current page or one
 *  open in the background, final review m7), else the file's (LF). */
async function textOf(page: string): Promise<string | null> {
  const live = useEditorStore.getState().liveText(page);
  if (live !== null) return live;
  const res = await pageRead(page);
  return res.ok ? toLf(res.value.text) : null;
}

/** `page`'s relationships, each with the page it points to. */
export async function relationsOf(page: string): Promise<Relation[]> {
  const text = await textOf(page);
  if (text === null) return [];
  const entries = readRelated(text);
  if (!entries.length) return [];
  const res = await linksResolve(
    page,
    entries.map((e) => ({ kind: 'related' as const, target: e.target })),
  );
  return entries.map((e, i) => ({
    ...e,
    source: page,
    path: res.ok ? (res.value[i] ?? null) : null,
  }));
}

/** Applies `edit` to `page`'s frontmatter: `saved`, `pending` (made in its
 *  live document, whose save is still retrying), or `false` when refused or
 *  failed (with a toast, except for a stale list). Also how a page's icon is
 *  set (M5b §4). */
export async function editRelations(
  page: string,
  edit: Edit,
): Promise<'saved' | 'pending' | false> {
  let stale = false;
  const guarded = (text: string): FrontmatterEdit => {
    const res = edit(text);
    if (res === STALE) {
      stale = true;
      return { ok: true, change: null };
    }
    return res;
  };
  const live = await useEditorStore.getState().editPage(page, guarded);
  if (live !== null) return live === 'refused' || stale ? false : live;
  for (let attempt = 0; attempt < 2; attempt++) {
    const read = await pageRead(page);
    if (!read.ok) {
      toast(errorMessage(read.error));
      return false;
    }
    const eol = detectEol(read.value.text);
    const text = toLf(read.value.text);
    const res = guarded(text);
    if (stale) return false;
    if (!res.ok) {
      toast(i18next.t('page.frontmatterInvalid'));
      return false;
    }
    if (!res.change) return 'saved';
    const c = res.change;
    const next = fromLf(text.slice(0, c.from) + c.insert + text.slice(c.to), eol);
    const written = await pageWrite(page, next, read.value.hash);
    if (written.ok) return 'saved';
    if (written.error.kind !== 'conflict') {
      toast(errorMessage(written.error));
      return false;
    }
  }
  toast(i18next.t('gv.relations.changedOnDisk', { name: pageName(page) }));
  return false;
}

/** A wiki target a `[[…]]` link can hold: `#`, `|` and `^` would start a
 *  heading, an alias or a block, `[`/`]` end the link, and both kinds of
 *  quote can't be written without YAML escapes, which liber-markdown
 *  doesn't index (final review m4). */
const linkable = (target: string) =>
  !/[#|^[\]]/.test(target) && !(target.includes("'") && target.includes('"'));

/** Wiki targets name the same page whatever their case or Unicode form. */
const sameTarget = (a: string, b: string) =>
  a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase();

/** Relates `source` to the page `target` (M3b §2): a new `related:` item,
 *  unless one already points there. */
export async function relate(source: string, target: string): Promise<RelateResult> {
  const existing = (await relationsOf(source)).find((r) => r.path === target);
  if (existing) return { status: 'exists', index: existing.index };
  const link = await linkTarget(source, target);
  if (!link.ok) {
    toast(errorMessage(link.error));
    return { status: 'failed' };
  }
  if (!linkable(link.value)) {
    toast(i18next.t('gv.relations.unlinkable', { name: pageName(target) }));
    return { status: 'failed' };
  }
  // Checked again on the text the item is appended to: another connect may
  // have written it meanwhile (final review m7).
  let found: number | null = null;
  const done = await editRelations(source, (text) => {
    const same = readRelated(text).find((e) => sameTarget(e.target, link.value));
    if (!same) return appendRelated(text, link.value);
    found = same.index;
    return { ok: true, change: null };
  });
  if (found !== null) return { status: 'exists', index: found };
  if (!done) return { status: 'failed' };
  return done === 'pending' ? { status: 'created', pending: true } : { status: 'created' };
}

/** The entry the caller read, if the list still has it there. */
const still = (text: string, r: Relation) =>
  readRelated(text).find((e) => e.index === r.index && e.link === r.link);

/** Changes a relationship's label and arrow (M3b §3). */
export const updateRelation = async (r: Relation, change: RelatedChange): Promise<boolean> =>
  (await editRelations(r.source, (text) =>
    still(text, r) ? updateRelated(text, r.index, change) : STALE,
  )) !== false;

/** Deletes a relationship (M3b §3). */
export const removeRelation = async (r: Relation): Promise<boolean> =>
  (await editRelations(r.source, (text) =>
    still(text, r) ? removeRelated(text, r.index) : STALE,
  )) !== false;
