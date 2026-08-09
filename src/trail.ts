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

  private targetMin = octaveLow(48)
  private targetMax = octaveHigh(48)
  private viewMin = this.targetMin
  private viewMax = this.targetMax

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
    this.targetMin = octaveLow(baseMidi)
    this.targetMax = octaveHigh(baseMidi)
    if (this.reduceMotion) {
      this.viewMin = this.targetMin
      this.viewMax = this.targetMax
    }
  }

  push(hz: number | null, voiced: boolean, options: PushOptions = {}): void {
    const now = options.now ?? performance.now() / 1000
    const raw = hz && voiced ? hzToMidi(hz) : NaN

    if (!voiced || !Number.isFinite(raw)) {
      this.points.push({ t: now, midi: NaN, voiced: false, color: '' })
      this.trim(now)
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
    this.points.push({
      t: now,
      midi: this.smoothMidi,
      voiced: true,
      color: tuningColor(midiToCents(this.smoothMidi)),
    })
    this.trim(now)
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

    // Vertical time grid, one line per second
    ctx.strokeStyle = '#c6c6c6'
    ctx.lineWidth = 1
    for (let s = 1; s < this.windowSec; s++) {
      const x = (s / this.windowSec) * w
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
    }

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

    // Runs of segments sharing a colour are stroked as one subpath, so the trail keeps
    // its round joins and stays linear in the number of points.
    let open = false
    let openColor = ''
    let prevX = 0
    let prevY = 0
    let hasPrev = false
    for (const p of this.points) {
      if (!p.voiced || !Number.isFinite(p.midi)) {
        hasPrev = false
        continue
      }
      const x = ((p.t - t0) / this.windowSec) * w
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
      this.drawNoteLabel(markerX, markerY, h)
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

  /** Names the eased pitch, kept left of the marker since the marker hugs the right edge. */
  private drawNoteLabel(markerX: number, markerY: number, h: number): void {
    const { name, octave } = midiToNoteName(this.renderMidi)
    const ctx = this.ctx
    const label = `${name}${octave}`

    ctx.font = LABEL_FONT
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'

    const chipW = ctx.measureText(label).width + LABEL_PAD_X * 2
    const chipX = Math.round(Math.max(1, markerX - MARKER_HALF - LABEL_GAP - chipW))
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
