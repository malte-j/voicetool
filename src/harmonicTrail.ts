import { MAX_HARMONICS, type HarmonicAnalysis } from './harmonics'
import { formatClock, tickStep } from './trail'

export interface HarmonicPoint {
  t: number
  /** Smoothed harmonic count, so the line glides between the ~14Hz updates. */
  count: number
  possible: number
  voiced: boolean
}

export interface RecordedHarmonics {
  points: HarmonicPoint[]
  duration: number
}

/** Weight given to a fresh count when blending with the running value. */
const COUNT_ALPHA = 0.4
/** Silence longer than this re-seeds the smoother instead of gliding across it. */
const VOICE_GAP_SEC = 0.3
/** Smallest top of the scale, so a thin tone still has room above it. */
const SCALE_MIN = 8
/** Time constant of the vertical scale ease when the range changes. */
const SCALE_TAU_SEC = 0.25
/** How far from the playhead a point may sit and still label the take. */
const PLAYHEAD_TOLERANCE_SEC = 0.12
const GRID_LABEL_FONT = `400 9px 'Suisse Intl', system-ui, -apple-system, 'Helvetica Neue', sans-serif`
const LINE_COLOR = '#f09000'
const FILL_COLOR = 'rgba(240, 144, 0, 0.22)'
const CEILING_COLOR = '#9a9a9a'
const PLAYHEAD_COLOR = '#1a1a1a'
const MARKER_HALF = 3
const LABEL_SIZE = 10
const LABEL_FONT = `500 ${LABEL_SIZE}px 'Suisse Intl', system-ui, -apple-system, 'Helvetica Neue', sans-serif`
const LABEL_GAP = 5
const LABEL_PAD_X = 3
const LABEL_HEIGHT = LABEL_SIZE + 4

/**
 * Harmonic count over the same rolling window as the pitch trail, and the same
 * frozen-take review once a recording is open.
 */
export class HarmonicTrail {
  private points: HarmonicPoint[] = []
  private readonly windowSec: number
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly reduceMotion: boolean
  private dpr = 1

  private smoothCount = NaN
  private lastVoicedT = -Infinity
  private lastFrameT = NaN

  private targetScale = SCALE_MIN
  private viewScale = SCALE_MIN

  private capturing = false
  private captureStart = 0
  private captured: HarmonicPoint[] = []
  private review: RecordedHarmonics | null = null
  private playhead = 0
  private reviewViewStart = 0
  private reviewViewEnd = 0

  constructor(canvas: HTMLCanvasElement, windowSec = 8) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D unavailable')
    this.canvas = canvas
    this.ctx = ctx
    this.windowSec = windowSec
    this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    this.resize()
  }

  push(analysis: HarmonicAnalysis | null, now = performance.now() / 1000): void {
    if (!analysis) {
      this.commit({ t: now, count: NaN, possible: 0, voiced: false })
      return
    }

    const restarted =
      !Number.isFinite(this.smoothCount) || now - this.lastVoicedT > VOICE_GAP_SEC
    this.smoothCount = restarted
      ? analysis.count
      : this.smoothCount + (analysis.count - this.smoothCount) * COUNT_ALPHA
    this.lastVoicedT = now

    this.commit({
      t: now,
      count: this.smoothCount,
      possible: analysis.possible,
      voiced: true,
    })
  }

  private commit(point: HarmonicPoint): void {
    this.points.push(point)
    if (this.capturing) {
      this.captured.push({ ...point, t: point.t - this.captureStart })
    }
    const cutoff = point.t - this.windowSec
    while (this.points.length && this.points[0].t < cutoff) this.points.shift()
  }

  clear(): void {
    this.points = []
    this.smoothCount = NaN
    this.lastVoicedT = -Infinity
    this.lastFrameT = NaN
    this.draw()
  }

  /** Starts collecting an untrimmed copy of the trail, timed from this moment. */
  startRecording(now = performance.now() / 1000): void {
    this.capturing = true
    this.captureStart = now
    this.captured = []
  }

  stopRecording(now = performance.now() / 1000): RecordedHarmonics {
    const points = this.captured
    const duration = this.capturing ? Math.max(0, now - this.captureStart) : 0
    this.capturing = false
    this.captured = []
    return { points, duration }
  }

  showRecording(recording: RecordedHarmonics): void {
    this.review = { ...recording, duration: Math.max(recording.duration, 0.05) }
    this.playhead = 0
    this.reviewViewStart = 0
    this.reviewViewEnd = this.review.duration
  }

  closeRecording(): void {
    this.review = null
    this.reviewViewStart = 0
    this.reviewViewEnd = 0
  }

  get reviewing(): boolean {
    return this.review != null
  }

  setPlayhead(seconds: number): void {
    if (!this.review) return
    this.playhead = Math.max(0, Math.min(this.review.duration, seconds))
  }

  /** Uses the pitch scope's horizontal viewport so both review canvases stay aligned. */
  setReviewViewport(start: number, end: number): void {
    if (!this.review) return
    this.reviewViewStart = Math.max(0, Math.min(this.review.duration, start))
    this.reviewViewEnd = Math.max(this.reviewViewStart, Math.min(this.review.duration, end))
  }

  /** Time under a pointer, for click-and-drag scrubbing. */
  timeAtClientX(clientX: number): number {
    if (!this.review) return 0
    const rect = this.canvas.getBoundingClientRect()
    const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
    return this.reviewViewStart +
      Math.max(0, Math.min(1, ratio)) * (this.reviewViewEnd - this.reviewViewStart)
  }

  /** Voiced point nearest `seconds`, or null where the take is silent. */
  pointAt(seconds: number): HarmonicPoint | null {
    if (!this.review) return null
    let best: HarmonicPoint | null = null
    let bestGap = PLAYHEAD_TOLERANCE_SEC
    for (const p of this.review.points) {
      if (!p.voiced || !Number.isFinite(p.count)) continue
      const gap = Math.abs(p.t - seconds)
      if (gap > bestGap) continue
      bestGap = gap
      best = p
    }
    return best
  }

  /** Latest live reading, for the panel readout. */
  get current(): HarmonicPoint | null {
    for (let i = this.points.length - 1; i >= 0; i--) {
      const p = this.points[i]
      if (p.voiced && Number.isFinite(p.count)) {
        return performance.now() / 1000 - p.t <= VOICE_GAP_SEC ? p : null
      }
    }
    return null
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    const rect = this.canvas.getBoundingClientRect()
    this.canvas.width = Math.max(1, Math.floor(rect.width * this.dpr))
    this.canvas.height = Math.max(1, Math.floor(rect.height * this.dpr))
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
  }

  draw(now = performance.now() / 1000): void {
    const dt = Number.isFinite(this.lastFrameT)
      ? Math.min(0.1, Math.max(0, now - this.lastFrameT))
      : 0
    this.lastFrameT = now

    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    const ctx = this.ctx
    const visible = this.review ? this.review.points : this.points

    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#d4d4d4'
    ctx.fillRect(0, 0, w, h)

    this.targetScale = scaleFor(visible)
    const scaleK = dt > 0 && !this.reduceMotion ? 1 - Math.exp(-dt / SCALE_TAU_SEC) : 1
    this.viewScale += (this.targetScale - this.viewScale) * scaleK
    const scale = this.viewScale

    this.drawCountGrid(w, h, scale)

    if (this.review) {
      this.drawReview(w, h, scale)
      return
    }

    this.drawTimeGrid(w, h, 0, this.windowSec, false)

    const t0 = now - this.windowSec
    const toX = (t: number): number => ((t - t0) / this.windowSec) * w
    this.strokeSeries(visible, toX, scale, h)

    const head = this.current
    if (!head) return

    const x = toX(head.t)
    const y = countToY(head.count, scale, h)
    ctx.fillStyle = LINE_COLOR
    ctx.fillRect(x - MARKER_HALF, y - MARKER_HALF, MARKER_HALF * 2, MARKER_HALF * 2)
    this.drawCountLabel(x, y, w, h, head.count)
  }

  /** The whole take laid out across the box, with the scrub cursor on top. */
  private drawReview(w: number, h: number, scale: number): void {
    const review = this.review!
    const ctx = this.ctx
    const start = this.reviewViewStart
    const span = Math.max(0.001, this.reviewViewEnd - start)
    const toX = (t: number): number => ((t - start) / span) * w

    this.drawTimeGrid(w, h, start, span, true)
    this.strokeSeries(review.points, toX, scale, h)

    const x = Math.round(toX(this.playhead)) + 0.5
    ctx.strokeStyle = PLAYHEAD_COLOR
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()

    ctx.fillStyle = PLAYHEAD_COLOR
    ctx.beginPath()
    ctx.moveTo(x - 5, 0)
    ctx.lineTo(x + 5, 0)
    ctx.lineTo(x, 7)
    ctx.closePath()
    ctx.fill()

    const point = this.pointAt(this.playhead)
    if (!point) return

    const y = countToY(point.count, scale, h)
    ctx.fillStyle = LINE_COLOR
    ctx.fillRect(x - MARKER_HALF, y - MARKER_HALF, MARKER_HALF * 2, MARKER_HALF * 2)
    this.drawCountLabel(x, y, w, h, point.count)
  }

  /**
   * Each run of voiced points is filled down to the baseline and topped with a
   * line, so silences read as gaps rather than as a drop to zero. The harmonics
   * the pitch could carry are traced above it as a faint ceiling.
   */
  private strokeSeries(
    points: HarmonicPoint[],
    toX: (t: number) => number,
    scale: number,
    h: number,
  ): void {
    const ctx = this.ctx
    let run: HarmonicPoint[] = []

    const flush = (): void => {
      if (run.length > 1) {
        ctx.beginPath()
        ctx.moveTo(toX(run[0].t), h)
        for (const p of run) ctx.lineTo(toX(p.t), countToY(p.count, scale, h))
        ctx.lineTo(toX(run[run.length - 1].t), h)
        ctx.closePath()
        ctx.fillStyle = FILL_COLOR
        ctx.fill()

        ctx.strokeStyle = CEILING_COLOR
        ctx.lineWidth = 1
        ctx.setLineDash([2, 3])
        ctx.beginPath()
        for (const [i, p] of run.entries()) {
          const x = toX(p.t)
          const y = countToY(p.possible, scale, h)
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
        ctx.setLineDash([])

        ctx.strokeStyle = LINE_COLOR
        ctx.lineWidth = 1.5
        ctx.lineJoin = 'round'
        ctx.beginPath()
        for (const [i, p] of run.entries()) {
          const x = toX(p.t)
          const y = countToY(p.count, scale, h)
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
      run = []
    }

    for (const p of points) {
      if (!p.voiced || !Number.isFinite(p.count)) {
        flush()
        continue
      }
      if (run.length && p.t - run[run.length - 1].t > VOICE_GAP_SEC) flush()
      run.push(p)
    }
    flush()
  }

  private drawCountGrid(w: number, h: number, scale: number): void {
    const ctx = this.ctx
    const step = scale <= 10 ? 2 : scale <= 20 ? 4 : 8

    ctx.strokeStyle = '#c6c6c6'
    ctx.lineWidth = 1
    ctx.fillStyle = '#6f6f6f'
    ctx.font = GRID_LABEL_FONT
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'

    for (let count = step; count <= scale; count += step) {
      const y = Math.round(countToY(count, scale, h)) + 0.5
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
      if (y > 8) ctx.fillText(String(count), 4, y)
    }
  }

  private drawTimeGrid(
    w: number,
    h: number,
    start: number,
    span: number,
    labelled: boolean,
  ): void {
    const ctx = this.ctx
    const step = tickStep(span, w)
    const decimals = step < 1 ? 1 : 0

    ctx.strokeStyle = '#c6c6c6'
    ctx.lineWidth = 1
    ctx.fillStyle = '#6f6f6f'
    ctx.font = GRID_LABEL_FONT
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'

    const end = start + span
    for (let seconds = Math.ceil(start / step) * step; seconds < end; seconds += step) {
      if (seconds <= start + 1e-6) continue
      const x = Math.round(((seconds - start) / span) * w) + 0.5
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
      if (labelled) ctx.fillText(formatClock(seconds, decimals), x + 3, 3)
    }
  }

  private drawCountLabel(
    markerX: number,
    markerY: number,
    w: number,
    h: number,
    count: number,
  ): void {
    const ctx = this.ctx
    const label = String(Math.round(count))

    ctx.font = LABEL_FONT
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'

    const chipW = ctx.measureText(label).width + LABEL_PAD_X * 2
    const right = markerX + MARKER_HALF + LABEL_GAP
    const chipX = Math.round(
      right + chipW <= w - 1 ? right : Math.max(1, markerX - MARKER_HALF - LABEL_GAP - chipW),
    )
    const above = markerY - MARKER_HALF - LABEL_GAP - LABEL_HEIGHT
    const chipY = Math.round(
      above >= 1
        ? above
        : Math.min(markerY + MARKER_HALF + LABEL_GAP, h - LABEL_HEIGHT - 1),
    )

    ctx.fillStyle = '#d4d4d4'
    ctx.fillRect(chipX, chipY, chipW, LABEL_HEIGHT)
    ctx.fillStyle = '#1a1a1a'
    ctx.fillText(label, chipX + LABEL_PAD_X, chipY + LABEL_HEIGHT / 2)
  }
}

function countToY(count: number, scale: number, h: number): number {
  return h - (Math.max(0, count) / scale) * h
}

/** Top of the scale, rounded up in steps of four so it does not creep. */
function scaleFor(points: HarmonicPoint[]): number {
  let max = 0
  for (const p of points) {
    if (!p.voiced || !Number.isFinite(p.count)) continue
    max = Math.max(max, p.count, Math.min(p.possible, MAX_HARMONICS))
  }
  return Math.min(MAX_HARMONICS, Math.max(SCALE_MIN, Math.ceil(max / 4) * 4))
}
