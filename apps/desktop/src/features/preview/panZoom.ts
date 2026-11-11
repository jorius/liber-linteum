/** A content point (cx, cy) is drawn at (x + cx·scale, y + cy·scale). */
export type View = { scale: number; x: number; y: number };

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 8;
/** One step of the buttons and + / − keys. */
export const STEP = 1.25;

const clamp = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** Zooms by `factor`, keeping the point under (px, py) where it is. */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const scale = clamp(v.scale * factor);
  const k = scale / v.scale;
  return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

export function panBy(v: View, dx: number, dy: number): View {
  return { scale: v.scale, x: v.x + dx, y: v.y + dy };
}

/** The whole content, centred in the box; never enlarged. An unmeasured
 *  side (0) leaves the scale at 1. */
export function fit(content: { w: number; h: number }, box: { w: number; h: number }): View {
  const scale = clamp(Math.min(1, box.w / content.w || 1, box.h / content.h || 1));
  return { scale, x: (box.w - content.w * scale) / 2, y: (box.h - content.h * scale) / 2 };
}
