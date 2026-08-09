// Tuning colour stops in OKLCH: hue sweeps green -> yellow -> red as |cents| grows.
// Lightness stays near 56% so no stop (especially the yellow) washes out on the
// light readout background; chroma is trimmed mid-sweep where yellow peaks early.
const TUNING_STOPS = [
  { at: 0, l: 57, c: 0.16, h: 148 },
  { at: 0.5, l: 57, c: 0.14, h: 80 },
  { at: 1, l: 55, c: 0.19, h: 27 },
]

export function tuningColor(cents: number): string {
  const t = Math.min(1, Math.abs(cents) / 50)
  const hi = TUNING_STOPS.findIndex((stop) => stop.at >= t)
  const upper = TUNING_STOPS[Math.max(1, hi)]
  const lower = TUNING_STOPS[Math.max(0, Math.max(1, hi) - 1)]
  const span = upper.at - lower.at
  const k = span === 0 ? 0 : (t - lower.at) / span
  const lerp = (a: number, b: number): number => a + (b - a) * k
  const l = lerp(lower.l, upper.l)
  const c = lerp(lower.c, upper.c)
  const h = lerp(lower.h, upper.h)
  return `oklch(${l.toFixed(1)}% ${c.toFixed(3)} ${h.toFixed(1)})`
}
