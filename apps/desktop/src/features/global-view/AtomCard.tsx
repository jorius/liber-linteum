// The cards of the atoms map (M4b part 3 §6): one per section, one per
// block, and "+N more" past the card budget. Like a level's cards, each is a
// named group whose button lies over the whole card; the map is read-only,
// so a click (or Enter) opens the page at the block.
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { GripIcon } from '../../app/icons';
import { assetUrl } from '../../ipc';
import { MathView } from '../preview/MathView';
import { MermaidView } from '../preview/MermaidView';
import type { Atom, AtomKind, More, Section } from './atoms';
import {
  AudioAtomIcon,
  CodeAtomIcon,
  DiagramIcon,
  FileAtomIcon,
  HeadingIcon,
  ImageAtomIcon,
  ListIcon,
  MathIcon,
  MoreIcon,
  NoteEmbedIcon,
  ParagraphIcon,
  QuoteIcon,
  TableIcon,
  TaskIcon,
} from './gvIcons';
import styles from './Atoms.module.css';

const ICONS: Record<AtomKind, () => ReactElement> = {
  paragraph: ParagraphIcon,
  list: ListIcon,
  tasks: TaskIcon,
  quote: QuoteIcon,
  callout: QuoteIcon,
  code: CodeAtomIcon,
  table: TableIcon,
  image: ImageAtomIcon,
  audio: AudioAtomIcon,
  file: FileAtomIcon,
  note: NoteEmbedIcon,
  math: MathIcon,
  diagram: DiagramIcon,
  html: CodeAtomIcon,
};

/** A button's name stays a line long. */
const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface PressProps {
  id: string;
  name: string;
  focusable: boolean;
  onOpen: () => void;
  onFocus: () => void;
}

/** The card's button: over the whole card, holding no text. */
function Press({ id, name, focusable, onOpen, onFocus }: PressProps) {
  return (
    <div
      className={styles.press}
      role="button"
      tabIndex={focusable ? 0 : -1}
      aria-label={name}
      data-gv-card={id}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      onFocus={onFocus}
    />
  );
}

function Head({ icon: Icon, label }: { icon: () => ReactElement; label: string }) {
  const { t } = useTranslation();
  return (
    <div className={styles.head}>
      <span className={styles.icon}>
        <Icon />
      </span>
      <span className={styles.kind}>{label}</span>
      <span className={`${styles.grip} gv-grip`} title={t('gv.move')} aria-hidden="true">
        <GripIcon />
      </span>
    </div>
  );
}

export interface AtomCardProps {
  atom: Atom;
  /** An image's or audio's vault path, once resolved (`null`: not found). */
  file?: string | null;
  focusable: boolean;
  onOpen: () => void;
  onFocus: () => void;
}

export function AtomCard({ atom, file, focusable, onOpen, onFocus }: AtomCardProps) {
  const { t } = useTranslation();
  const kind = t(`gv.atoms.kind.${atom.kind}`);
  const label = atom.kind === 'code' && atom.lang ? `${kind} · ${atom.lang}` : kind;
  let body: ReactElement;
  switch (atom.kind) {
    case 'list':
    case 'tasks':
      body = (
        <>
          <ul className={styles.lines}>
            {(atom.lines ?? []).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          <p className={styles.meta}>
            {atom.kind === 'tasks'
              ? t('gv.atoms.done', { done: atom.done ?? 0, count: atom.count ?? 0 })
              : t('gv.atoms.items', { count: atom.count ?? 0 })}
          </p>
        </>
      );
      break;
    case 'code':
      body = <pre className={styles.code}>{(atom.lines ?? []).join('\n')}</pre>;
      break;
    case 'table':
      body = (
        <>
          <p className={styles.text}>{(atom.lines ?? []).join(' · ')}</p>
          <p className={styles.meta}>{t('gv.atoms.rows', { count: atom.count ?? 0 })}</p>
        </>
      );
      break;
    case 'image':
      body = file ? (
        <div className={styles.thumb}>
          <img src={assetUrl(file)} alt="" loading="lazy" draggable={false} />
        </div>
      ) : (
        <p className={styles.text}>{atom.text}</p>
      );
      break;
    case 'math':
      body = (
        <div className={styles.math}>
          <MathView tex={atom.source ?? atom.text} display />
        </div>
      );
      break;
    case 'diagram':
      body = (
        <div className={styles.diagram}>
          <MermaidView source={atom.source ?? ''} />
        </div>
      );
      break;
    default:
      body = <p className={styles.text}>{atom.text}</p>;
  }
  // Lists and tables are named by their first items or columns.
  const listed = atom.kind === 'list' || atom.kind === 'tasks' || atom.kind === 'table';
  const name = short(`${label}: ${listed ? (atom.lines ?? []).join(', ') : atom.text}`);
  return (
    <div className={styles.atom} role="group" aria-label={label} data-atom-kind={atom.kind}>
      <Head icon={ICONS[atom.kind]} label={label} />
      <div className={styles.body} aria-hidden="true">
        {body}
      </div>
      <Press id={atom.id} name={name} focusable={focusable} onOpen={onOpen} onFocus={onFocus} />
    </div>
  );
}

export interface SectionCardProps {
  section: Section;
  focusable: boolean;
  onOpen: () => void;
  onFocus: () => void;
}

export function SectionCard({ section, focusable, onOpen, onFocus }: SectionCardProps) {
  const { t } = useTranslation();
  const level = t('gv.atoms.level', { level: section.level });
  const blocks = t('gv.atoms.blocks', { count: section.blocks });
  return (
    <div className={styles.section} role="group" aria-label={level}>
      <Head icon={HeadingIcon} label={`${level} · ${blocks}`} />
      <p className={styles.title} aria-hidden="true">
        {section.title}
      </p>
      <Press
        id={section.id}
        name={short(t('gv.atoms.sectionName', { level: section.level, title: section.title }))}
        focusable={focusable}
        onOpen={onOpen}
        onFocus={onFocus}
      />
    </div>
  );
}

export interface MoreCardProps {
  more: More;
  focusable: boolean;
  onOpen: () => void;
  onFocus: () => void;
}

export function MoreCard({ more, focusable, onOpen, onFocus }: MoreCardProps) {
  const { t } = useTranslation();
  return (
    <div
      className={styles.more}
      role="group"
      aria-label={t('gv.atoms.more', { count: more.count })}
    >
      <span className={styles.icon}>
        <MoreIcon />
      </span>
      <span aria-hidden="true">{t('gv.atoms.more', { count: more.count })}</span>
      <Press
        id={more.id}
        name={t('gv.atoms.moreLabel', { count: more.count })}
        focusable={focusable}
        onOpen={onOpen}
        onFocus={onFocus}
      />
    </div>
  );
}
