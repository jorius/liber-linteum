import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useLayoutEffect, useRef } from 'react';

/** Draws TeX into `el` (M4b part 2 §3): no trusted commands, no throwing —
 *  broken TeX shows its source in the error colour, with KaTeX's message as
 *  its title — and MathML alongside the HTML for screen readers. */
export function renderMath(tex: string, el: HTMLElement, display: boolean): void {
  katex.render(tex, el, {
    displayMode: display,
    throwOnError: false,
    trust: false,
    strict: 'ignore',
    output: 'htmlAndMathml',
  });
}

/** Maths in the rendered pane and Live Preview widgets. */
export function MathView({ tex, display }: { tex: string; display: boolean }) {
  const el = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (el.current) renderMath(tex, el.current, display);
  }, [tex, display]);
  return display ? (
    <div ref={el as React.RefObject<HTMLDivElement>} data-nimw="math" />
  ) : (
    <span ref={el as React.RefObject<HTMLSpanElement>} data-nimw="math" />
  );
}
