import { MODEL_FMAX, MODEL_FMIN, hzToMidi, midiToCents, midiToNoteName } from './pitch'
import { tuningColor } from './tuning'

export interface TrailPoint {
  t: number
  midi: number
  voiced: boolean
  /** Tuning colour frozen at push time so the history keeps how in tune it was. */
  color: string
}

export interface PushOptions {
  now?: number
  /** Skip smoothing and place the point exactly, e.g. for keyboard-triggered notes. */
  snap?: boolean
}

/** A captured take: the same trail points, timed from the start of the recording. */
export interface RecordedTrail {
  points: TrailPoint[]
  duration: number
}

/** Weight given to a fresh detection when blending in MIDI space. */
const PITCH_ALPHA = 0.6
/** A step larger than this is treated as a possible octave error until confirmed. */
const JUMP_SEMITONES = 3
/** Silence longer than this re-seeds the smoothers instead of gliding across it. */
const VOICE_GAP_SEC = 0.3
/** Time constant of the per-frame marker easing. */
const RENDER_TAU_SEC = 0.055
/** Semitones of headroom kept above and below the framed octave. */
const RANGE_PAD = 5
/** Time constant of the viewport ease when the framed octave changes. */
const RANGE_TAU_SEC = 0.16
const MODEL_MIDI_MIN = hzToMidi(MODEL_FMIN)
const MODEL_MIDI_MAX = hzToMidi(MODEL_FMAX)
/** Pitch classes drawn as shaded rows, matching the black keys of a piano roll. */
const ACCIDENTALS = new Set([1, 3, 6, 8, 10])
/** Below this row height the semitone rules are dropped so the grid stays legible. */
const MIN_SEMITONE_PX = 5
const GRID_LABEL_FONT = `400 9px 'Suisse Intl', system-ui, -apple-system, 'Helvetica Neue', sans-serif`
const MARKER_HALF = 3
const LABEL_SIZE = 10
const LABEL_FONT = `500 ${LABEL_SIZE}px 'Suisse Intl', system-ui, -apple-system, 'Helvetica Neue', sans-serif`
const LABEL_GAP = 5
const LABEL_PAD_X = 3
const LABEL_HEIGHT = LABEL_SIZE + 4
/** Semitones of headroom around the pitches actually sung in a reviewed take. */
const REVIEW_PAD = 3
/** A take that never leaves one note still gets this much scale around it. */
const REVIEW_MIN_SPAN = 14
/** How far from the playhead a point may sit and still name the pitch under it. */
const PLAYHEAD_TOLERANCE_SEC = 0.12
const PLAYHEAD_COLOR = '#1a1a1a'
const TICK_STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
/** Time gridlines aim for roughly this spacing before the next step up is used. */
const TICK_TARGET_PX = 110

/** Canvas pitch trail rendered in MIDI space over a rolling time window. */
export class PitchTrail {
  private points: TrailPoint[] = []
  private readonly windowSec: number
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly reduceMotion: boolean
  private dpr = 1

  private smoothMidi = NaN
  private pendingJump: number | null = null
  private lastVoicedT = -Infinity

  private renderMidi = NaN
  private renderSeeded = false
  private lastFrameT = NaN

  private octaveBase = 48
  private targetMin = octaveLow(48)
  private targetMax = octaveHigh(48)
  private viewMin = this.targetMin
  private viewMax = this.targetMax

  private capturing = false
  private captureStart = 0
  private captured: TrailPoint[] = []
  private review: RecordedTrail | null = null
  private playhead = 0

  constructor(canvas: HTMLCanvasElement, windowSec = 8) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D unavailable')
    this.canvas = canvas
    this.ctx = ctx
    this.windowSec = windowSec
    this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    this.resize()
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    const rect = this.canvas.getBoundingClientRect()
    this.canvas.width = Math.max(1, Math.floor(rect.width * this.dpr))
    this.canvas.height = Math.max(1, Math.floor(rect.height * this.dpr))
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
  }

  /**
   * Frames the octave starting at `baseMidi` so it fills most of the height, with a
   * few semitones of headroom on each side and clamped to what the model can detect.
   */
  setOctave(baseMidi: number): void {
    this.octaveBase = baseMidi
    // A reviewed take frames its own pitch range, so leave the viewport alone and
    // let closeRecording() pick the octave back up.
    if (this.review) return
    this.frameRange(octaveLow(baseMidi), octaveHigh(baseMidi))
  }

  push(hz: number | null, voiced: boolean, options: PushOptions = {}): void {
    const now = options.now ?? performance.now() / 1000
    const raw = hz && voiced ? hzToMidi(hz) : NaN

    if (!voiced || !Number.isFinite(raw)) {
      this.commit({ t: now, midi: NaN, voiced: false, color: '' })
      return
    }

    const restarted =
      options.snap ||
      !Number.isFinite(this.smoothMidi) ||
      now - this.lastVoicedT > VOICE_GAP_SEC

    if (restarted) {
      this.smoothMidi = raw
      this.pendingJump = null
    } else if (Math.abs(raw - this.smoothMidi) > JUMP_SEMITONES) {
      // A large step is only trusted once a second detection agrees with it, so a
      // lone octave error or glitch frame cannot yank the trail.
      const confirmed =
        this.pendingJump != null &&
        Math.abs(raw - this.pendingJump) <= JUMP_SEMITONES
      if (confirmed) {
        this.smoothMidi = raw
        this.pendingJump = null
      } else {
        this.pendingJump = raw
      }
    } else {
      this.pendingJump = null
      this.smoothMidi += (raw - this.smoothMidi) * PITCH_ALPHA
    }

    this.lastVoicedT = now
    this.commit({
      t: now,
      midi: this.smoothMidi,
      voiced: true,
      color: tuningColor(midiToCents(this.smoothMidi)),
    })
  }

  private commit(point: TrailPoint): void {
    this.points.push(point)
    if (this.capturing) {
      this.captured.push({ ...point, t: point.t - this.captureStart })
    }
    this.trim(point.t)
  }

  clear(): void {
    this.points = []
    this.smoothMidi = NaN
    this.pendingJump = null
    this.lastVoicedT = -Infinity
    this.renderMidi = NaN
    this.renderSeeded = false
    this.lastFrameT = NaN
    this.draw()
  }

  /** Starts collecting an untrimmed copy of the trail, timed from this moment. */
  startRecording(now = performance.now() / 1000): void {
    this.capturing = true
    this.captureStart = now
    this.captured = []
  }

  stopRecording(now = performance.now() / 1000): RecordedTrail {
    const points = this.captured
    const duration = this.capturing ? Math.max(0, now - this.captureStart) : 0
    this.capturing = false
    this.captured = []
    return { points, duration }
  }

  /** Freezes the scope on a finished take, with a playhead at its start. */
  showRecording(recording: RecordedTrail): void {
    this.review = { ...recording, duration: Math.max(recording.duration, 0.05) }
    this.playhead = 0
    this.renderSeeded = false
    this.frameRecording(recording.points)
  }

  closeRecording(): void {
    if (!this.review) return
    this.review = null
    this.frameRange(octaveLow(this.octaveBase), octaveHigh(this.octaveBase))
  }

  get reviewing(): boolean {
    return this.review != null
  }

  get duration(): number {
    return this.review?.duration ?? 0
  }

  get playheadSeconds(): number {
    return this.playhead
  }

  setPlayhead(seconds: number): void {
    if (!this.review) return
    this.playhead = Math.max(0, Math.min(this.review.duration, seconds))
  }

  /** Time under a pointer, for click-and-drag scrubbing. */
  timeAtClientX(clientX: number): number {
    if (!this.review) return 0
    const rect = this.canvas.getBoundingClientRect()
    const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
    return Math.max(0, Math.min(1, ratio)) * this.review.duration
  }

  /** Voiced point nearest `seconds`, or null where the take is silent. */
  pointAt(seconds: number): TrailPoint | null {
    if (!this.review) return null
    let best: TrailPoint | null = null
    let bestGap = PLAYHEAD_TOLERANCE_SEC
    for (const p of this.review.points) {
      if (!p.voiced || !Number.isFinite(p.midi)) continue
      const gap = Math.abs(p.t - seconds)
      if (gap > bestGap) continue
      bestGap = gap
      best = p
    }
    return best
  }

  private frameRange(min: number, max: number): void {
    this.targetMin = min
    this.targetMax = max
    if (this.reduceMotion) {
      this.viewMin = min
      this.viewMax = max
    }
  }

  /** Fits the viewport to the pitches actually sung, so a take fills the scope. */
  private frameRecording(points: TrailPoint[]): void {
    let min = Infinity
    let max = -Infinity
    for (const p of points) {
      if (!p.voiced || !Number.isFinite(p.midi)) continue
      min = Math.min(min, p.midi)
      max = Math.max(max, p.midi)
    }
    if (!Number.isFinite(min)) return

    const span = Math.max(REVIEW_MIN_SPAN, max - min + REVIEW_PAD * 2)
    const center = (min + max) / 2
    this.frameRange(
      Math.max(MODEL_MIDI_MIN, center - span / 2),
      Math.min(MODEL_MIDI_MAX, center + span / 2),
    )
  }

  draw(now = performance.now() / 1000): void {
    const dt = Number.isFinite(this.lastFrameT)
      ? Math.min(0.1, Math.max(0, now - this.lastFrameT))
      : 0
    this.lastFrameT = now

    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    const ctx = this.ctx
    ctx.clearRect(0, 0, w, h)

    // Flat clip-editor background
    ctx.fillStyle = '#d4d4d4'
    ctx.fillRect(0, 0, w, h)

    // Ease the viewport so switching octaves slides the trail instead of teleporting it.
    const rangeK = dt > 0 && !this.reduceMotion ? 1 - Math.exp(-dt / RANGE_TAU_SEC) : 1
    this.viewMin += (this.targetMin - this.viewMin) * rangeK
    this.viewMax += (this.targetMax - this.viewMax) * rangeK
    const yMin = this.viewMin
    const yMax = this.viewMax

    this.drawPitchGrid(w, h, yMin, yMax)

    if (this.review) {
      this.drawReview(w, h, yMin, yMax)
      return
    }

    this.drawTimeGrid(w, h, this.windowSec, false)

    if (!this.points.length) {
      this.renderSeeded = false
      return
    }

    let head: TrailPoint | null = null
    for (let i = this.points.length - 1; i >= 0; i--) {
      const p = this.points[i]
      if (p.voiced && Number.isFinite(p.midi)) {
        head = p
        break
      }
    }
    const live = head != null && now - head.t <= VOICE_GAP_SEC

    if (!live) {
      this.renderSeeded = false
    } else if (!this.renderSeeded || this.reduceMotion) {
      this.renderMidi = head!.midi
      this.renderSeeded = true
    } else {
      // Frame-rate independent ease so the marker glides between the ~14Hz updates.
      this.renderMidi += (head!.midi - this.renderMidi) * (1 - Math.exp(-dt / RENDER_TAU_SEC))
    }

    const t0 = now - this.windowSec
    const markerX = w - MARKER_HALF
    const markerY = midiToY(this.renderMidi, yMin, yMax, h)

    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.lineCap = 'butt'
    this.strokeTrail(this.points, (t) => ((t - t0) / this.windowSec) * w, yMin, yMax, h)

    // Extend the line to the eased marker so the two never separate.
    const liveColor = live ? tuningColor(midiToCents(this.renderMidi)) : ''
    if (live && head) {
      ctx.strokeStyle = liveColor
      ctx.beginPath()
      ctx.moveTo(((head.t - t0) / this.windowSec) * w, midiToY(head.midi, yMin, yMax, h))
      ctx.lineTo(markerX, markerY)
      ctx.stroke()
    }

    // Flat marker on the latest voiced point, like an automation breakpoint
    if (live) {
      ctx.fillStyle = liveColor
      ctx.fillRect(markerX - MARKER_HALF, markerY - MARKER_HALF, MARKER_HALF * 2, MARKER_HALF * 2)
      this.drawNoteLabel(markerX, markerY, w, h, this.renderMidi)
    }
  }

  /**
   * Runs of segments sharing a colour are stroked as one subpath, so the trail keeps
   * its round joins and stays linear in the number of points.
   */
  private strokeTrail(
    points: TrailPoint[],
    toX: (t: number) => number,
    yMin: number,
    yMax: number,
    h: number,
  ): void {
    const ctx = this.ctx
    let open = false
    let openColor = ''
    let prevX = 0
    let prevY = 0
    let hasPrev = false

    for (const p of points) {
      if (!p.voiced || !Number.isFinite(p.midi)) {
        hasPrev = false
        continue
      }
      const x = toX(p.t)
      const y = midiToY(p.midi, yMin, yMax, h)
      if (hasPrev) {
        if (!open || p.color !== openColor) {
          if (open) ctx.stroke()
          openColor = p.color
          ctx.strokeStyle = openColor
          ctx.beginPath()
          ctx.moveTo(prevX, prevY)
          open = true
        }
        ctx.lineTo(x, y)
      } else if (open) {
        ctx.stroke()
        open = false
      }
      prevX = x
      prevY = y
      hasPrev = true
    }
    if (open) ctx.stroke()
  }

  /** The whole take laid out across the scope, with the scrub cursor on top. */
  private drawReview(w: number, h: number, yMin: number, yMax: number): void {
    const review = this.review!
    const ctx = this.ctx
    const toX = (t: number): number => (t / review.duration) * w

    this.drawTimeGrid(w, h, review.duration, true)

    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.lineCap = 'butt'
    this.strokeTrail(review.points, toX, yMin, yMax, h)

    const x = Math.round(toX(this.playhead)) + 0.5
    ctx.strokeStyle = PLAYHEAD_COLOR
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()

    // Grab handle, so the cursor reads as something you can drag.
    ctx.fillStyle = PLAYHEAD_COLOR
    ctx.beginPath()
    ctx.moveTo(x - 5, 0)
    ctx.lineTo(x + 5, 0)
    ctx.lineTo(x, 7)
    ctx.closePath()
    ctx.fill()

    const point = this.pointAt(this.playhead)
    if (!point) return

    const y = midiToY(point.midi, yMin, yMax, h)
    ctx.fillStyle = point.color
    ctx.fillRect(x - MARKER_HALF, y - MARKER_HALF, MARKER_HALF * 2, MARKER_HALF * 2)
    this.drawNoteLabel(x, y, w, h, point.midi)
  }

  private drawTimeGrid(w: number, h: number, span: number, labelled: boolean): void {
    const ctx = this.ctx
    const step = tickStep(span, w)
    const decimals = step < 1 ? 1 : 0

    ctx.strokeStyle = '#c6c6c6'
    ctx.lineWidth = 1
    ctx.fillStyle = '#6f6f6f'
    ctx.font = GRID_LABEL_FONT
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'

    for (let i = 1; i * step < span; i++) {
      const seconds = i * step
      const x = Math.round((seconds / span) * w) + 0.5
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
      if (labelled) ctx.fillText(formatClock(seconds, decimals), x + 3, 3)
    }
  }

  /**
   * Piano-roll style pitch scale: shaded accidental rows, semitone rules, and a labelled
   * rule at every C. Drawn before the trail so the note chip always paints over it.
   */
  private drawPitchGrid(w: number, h: number, yMin: number, yMax: number): void {
    const ctx = this.ctx
    const rowPx = h / (yMax - yMin)
    const low = Math.floor(yMin)
    const high = Math.ceil(yMax)

    ctx.fillStyle = '#cbcbcb'
    for (let m = low; m <= high; m++) {
      if (!ACCIDENTALS.has(((m % 12) + 12) % 12)) continue
      const top = midiToY(m + 0.5, yMin, yMax, h)
      ctx.fillRect(0, top, w, rowPx)
    }

    ctx.lineWidth = 1
    if (rowPx >= MIN_SEMITONE_PX) {
      ctx.strokeStyle = '#c6c6c6'
      for (let m = low; m <= high; m++) {
        const y = Math.round(midiToY(m - 0.5, yMin, yMax, h)) + 0.5
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
      }
    }

    ctx.strokeStyle = '#a8a8a8'
    ctx.fillStyle = '#6f6f6f'
    ctx.font = GRID_LABEL_FONT
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    for (let m = Math.ceil((low - 0.5) / 12) * 12; m <= high; m += 12) {
      const y = Math.round(midiToY(m - 0.5, yMin, yMax, h)) + 0.5
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
      const center = midiToY(m, yMin, yMax, h)
      if (center > 6 && center < h - 6) {
        ctx.fillText(`C${m / 12 - 1}`, 4, center)
      }
    }
  }

  /** Names the pitch at a marker, preferring the right side and flipping when it would clip. */
  private drawNoteLabel(
    markerX: number,
    markerY: number,
    w: number,
    h: number,
    midi: number,
  ): void {
    const { name, octave } = midiToNoteName(midi)
    const ctx = this.ctx
    const label = `${name}${octave}`

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

    // Flat chip so the name stays readable where it crosses the trail or a gridline.
    ctx.fillStyle = '#d4d4d4'
    ctx.fillRect(chipX, chipY, chipW, LABEL_HEIGHT)
    ctx.fillStyle = '#1a1a1a'
    ctx.fillText(label, chipX + LABEL_PAD_X, chipY + LABEL_HEIGHT / 2)
  }

  private trim(now: number): void {
    const cutoff = now - this.windowSec
    while (this.points.length && this.points[0].t < cutoff) {
      this.points.shift()
    }
  }
}

function midiToY(midi: number, yMin: number, yMax: number, h: number): number {
  const t = (midi - yMin) / (yMax - yMin)
  return h - t * h
}

function octaveLow(baseMidi: number): number {
  return Math.max(MODEL_MIDI_MIN, baseMidi - RANGE_PAD)
}

function octaveHigh(baseMidi: number): number {
  return Math.min(MODEL_MIDI_MAX, baseMidi + 12 + RANGE_PAD)
}

function tickStep(span: number, w: number): number {
  const wanted = (span / Math.max(w, 1)) * TICK_TARGET_PX
  return TICK_STEPS.find((step) => step >= wanted) ?? TICK_STEPS[TICK_STEPS.length - 1]
}

/** `m:ss` transport time, e.g. 1:05.4 */
export function formatClock(seconds: number, decimals = 0): string {
  const safe = Math.max(0, seconds)
  const minutes = Math.floor(safe / 60)
  const rest = safe - minutes * 60
  return `${minutes}:${rest.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0')}`
}
