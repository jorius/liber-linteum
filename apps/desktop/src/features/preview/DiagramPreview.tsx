import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../dialogs/Dialog';
import styles from './DiagramPreview.module.css';
import { fit, panBy, STEP, zoomAt, type View } from './panZoom';

const PAN = 40;

/** Zoom and pan a drawn diagram or block maths (Part B): wheel or pinch
 *  zooms around the pointer, the buttons and + / − / 0 around the centre or
 *  to fit, a drag or the arrows pan. Opens fitted. */
export function DiagramPreview({
  html,
  kind,
  returnTo,
  onClose,
}: {
  html: string;
  kind: 'diagram' | 'math';
  returnTo: HTMLElement | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const natural = useRef({ w: 0, h: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });

  const size = () => ({ w: box.current?.clientWidth ?? 0, h: box.current?.clientHeight ?? 0 });
  const toFit = () => setView(fit(natural.current, size()));
  const zoom = (factor: number) => {
    const { w, h } = size();
    setView((v) => zoomAt(v, factor, w / 2, h / 2));
  };

  useLayoutEffect(() => {
    const el = layer.current!;
    // Mermaid sizes its svg to the page (width 100%, max-width): give it the
    // natural size its viewBox says, so fit and zoom measure the drawing.
    const svg = el.querySelector<SVGSVGElement>(':scope > svg');
    const [, , w, h] = (svg?.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
    if (svg && w > 0 && h > 0) {
      svg.setAttribute('width', String(w));
      svg.setAttribute('height', String(h));
      svg.style.maxWidth = 'none';
    }
    natural.current = { w: el.offsetWidth, h: el.offsetHeight };
    toFit();
    // Measured once, when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React's wheel listener is passive; this one must stop the page scrolling.
  useEffect(() => {
    const el = box.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // Pinch arrives as ctrl + wheel in Chromium and WebKit: the same zoom.
      const factor = Math.exp(-e.deltaY * 0.002);
      setView((v) => zoomAt(v, factor, e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const pans: Record<string, [number, number]> = {
      ArrowLeft: [PAN, 0],
      ArrowRight: [-PAN, 0],
      ArrowUp: [0, PAN],
      ArrowDown: [0, -PAN],
    };
    if (e.key === '+' || e.key === '=') zoom(STEP);
    else if (e.key === '-') zoom(1 / STEP);
    else if (e.key === '0') toFit();
    else if (pans[e.key]) setView((v) => panBy(v, ...pans[e.key]));
    else return;
    e.preventDefault();
  };

  return (
    <Dialog
      title={t('diagram.previewTitle')}
      onClose={onClose}
      returnFocus={() => returnTo}
      dismissible
      wide
    >
      <div className={styles.body} onKeyDown={onKeyDown}>
        <div className={styles.toolbar}>
          <button
            type="button"
            className="btn btn-secondary"
            aria-label={t('diagram.zoomOut')}
            onClick={() => zoom(1 / STEP)}
          >
            −
          </button>
          <output className={styles.percent}>{Math.round(view.scale * 100)}%</output>
          <button
            type="button"
            className="btn btn-secondary"
            aria-label={t('diagram.zoomIn')}
            onClick={() => zoom(STEP)}
          >
            +
          </button>
          <button type="button" className="btn btn-secondary" onClick={toFit}>
            {t('diagram.fit')}
          </button>
        </div>
        <div
          ref={box}
          className={styles.viewport}
          tabIndex={0}
          data-autofocus
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerMove={(e) => {
            const from = drag.current;
            if (!from) return;
            drag.current = { x: e.clientX, y: e.clientY };
            setView((v) => panBy(v, e.clientX - from.x, e.clientY - from.y));
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        >
          <div
            ref={layer}
            className={styles.layer}
            // Maths keeps KaTeX's MathML readable; a diagram is one picture.
            role={kind === 'diagram' ? 'img' : undefined}
            aria-label={kind === 'diagram' ? t('diagram.previewLabel') : undefined}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            // A copy of markup already on the page, already sanitised (Mermaid
            // via inertSvg, KaTeX with trust: false); never drawn again.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </div>
    </Dialog>
  );
}
