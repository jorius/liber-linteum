// React Flow in jsdom (imported by Global View tests): jsdom has no layout,
// so nodes get their size from their inline style (cards are 240 × 300) and
// the observers React Flow needs exist (reactflow.dev "Testing").
class ResizeObserverStub {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(target: Element) {
    const el = target as HTMLElement;
    const contentRect = { width: el.offsetWidth, height: el.offsetHeight } as DOMRectReadOnly;
    this.cb([{ target, contentRect } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

class DOMMatrixReadOnlyStub {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([0-9.]+)\)/)?.[1];
    this.m22 = scale !== undefined ? Number(scale) : 1;
  }
}

const sized = (axis: 'width' | 'height', fallback: number) =>
  function (this: HTMLElement) {
    if (this.classList?.contains('react-flow__node')) return axis === 'width' ? 240 : 300;
    return parseFloat(this.style?.[axis]) || fallback;
  };

export function installReactFlowStubs() {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly = DOMMatrixReadOnlyStub;
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: sized('width', 1220) },
    offsetHeight: { configurable: true, get: sized('height', 760) },
  });
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
    ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
}
