import './fonts.css'
import './style.css'
import { AudioCapture, SampleRingBuffer } from './audioCapture'
import {
  KEYBOARD_STEPS,
  highlightDetectedKey,
  renderKeyboard,
  setKeyState,
} from './keyboard'
import { ONNXService } from './onnxService'
import {
  MODEL_FMAX,
  MODEL_FMIN,
  TARGET_SAMPLE_RATE,
  analyzePitch,
  formatNote,
  midiToHz,
  type DetectedNote,
} from './pitch'
import { Synth } from './synth'
import { PitchTrail } from './trail'
import { tuningColor } from './tuning'

const WINDOW_SECONDS = 0.85
const WINDOW_SAMPLES = Math.round(TARGET_SAMPLE_RATE * WINDOW_SECONDS)
const INFER_EVERY_MS = 70
const CONFIDENCE_THRESHOLD = 0.85
const MIN_AUDIO_SAMPLES = 256
const DEFAULT_TARGET_HOLD_SECONDS = 2

const noteDisplayEl = document.querySelector<HTMLDivElement>('#noteDisplay')!
const noteNameEl = document.querySelector<HTMLSpanElement>('#noteName')!
const noteHzEl = document.querySelector<HTMLSpanElement>('#noteHz')!
const noteConfEl = document.querySelector<HTMLSpanElement>('#noteConf')!
const centsNeedleEl = document.querySelector<HTMLDivElement>('#centsNeedle')!
const centsValueEl = document.querySelector<HTMLParagraphElement>('#centsValue')!
const levelFillEl = document.querySelector<HTMLDivElement>('#levelFill')!
const listenBtn = document.querySelector<HTMLButtonElement>('#listenBtn')!
const listenLabel = document.querySelector<HTMLSpanElement>('#listenLabel')!
const trailCanvas = document.querySelector<HTMLCanvasElement>('#trail')!
const keyboardEl = document.querySelector<HTMLDivElement>('#keyboard')!
const octaveDownBtn = document.querySelector<HTMLButtonElement>('#octaveDown')!
const octaveUpBtn = document.querySelector<HTMLButtonElement>('#octaveUp')!
const octaveValueEl = document.querySelector<HTMLElement>('#octaveValue')!
const targetStatusEl = document.querySelector<HTMLParagraphElement>('#targetStatus')!
const holdSecondsInput = document.querySelector<HTMLInputElement>('#holdSeconds')!

const onnx = new ONNXService('model.onnx')
const capture = new AudioCapture()
const ring = new SampleRingBuffer(TARGET_SAMPLE_RATE * 2)
const trail = new PitchTrail(trailCanvas, 8)
const synth = new Synth()

let listening = false
let inferTimer: number | null = null
let lastInferAt = 0
let smoothedCents = 0
let holdUntil = 0
let lastNote: DetectedNote | null = null
let keyboardOctave = 3
let targetMidi: number | null = null
let targetHeldSince: number | null = null
let targetCompleted = false
let suppressDetectionUntil = 0
const heldComputerKeys = new Map<string, number>()
const heldPointerNotes = new Set<number>()

// Also seeds the scope viewport and the octave readout for the default octave.
setKeyboardOctave(keyboardOctave)

function setListenLabel(text: string, kind: 'idle' | 'listening' | 'error' = 'idle'): void {
  listenLabel.textContent = text
  listenBtn.classList.toggle('error', kind === 'error')
  listenBtn.classList.toggle('active', kind === 'listening')
}

function setTuningColor(cents: number | null): void {
  if (cents == null) {
    noteDisplayEl.style.removeProperty('--note-color')
    centsNeedleEl.style.removeProperty('background')
    return
  }
  const color = tuningColor(cents)
  noteDisplayEl.style.setProperty('--note-color', color)
  centsNeedleEl.style.background = color
}

function setVoicedUi(note: DetectedNote | null): void {
  const voiced = note != null
  noteDisplayEl.classList.toggle('voiced', voiced)

  if (!voiced) {
    if (performance.now() < holdUntil && lastNote) {
      // Keep last note briefly so the display doesn't flicker between syllables.
      return
    }
    noteNameEl.textContent = '—'
    noteHzEl.textContent = '— Hz'
    noteConfEl.textContent = '—%'
    centsNeedleEl.style.left = '50%'
    centsValueEl.textContent = '0 ¢'
    setTuningColor(null)
    highlightDetectedKey(keyboardEl, null)
    return
  }

  lastNote = note
  holdUntil = performance.now() + 180
  noteNameEl.textContent = formatNote(note)
  noteHzEl.textContent = `${note.hz.toFixed(1)} Hz`
  noteConfEl.textContent = `${Math.round(note.confidence * 100)}%`

  smoothedCents = smoothedCents * 0.65 + note.cents * 0.35
  const clamped = Math.max(-50, Math.min(50, smoothedCents))
  const pct = ((clamped + 50) / 100) * 100
  centsNeedleEl.style.left = `${pct}%`
  const sign = clamped > 0 ? '+' : ''
  centsValueEl.textContent = `${sign}${clamped.toFixed(0)} ¢`
  setTuningColor(clamped)
  highlightDetectedKey(keyboardEl, Math.round(note.midi))
}

function showPlayedNote(midi: number): void {
  const note = analyzePitch(midiToHz(midi), 1)
  noteDisplayEl.classList.add('voiced')
  noteNameEl.textContent = formatNote(note)
  noteHzEl.textContent = `${note.hz.toFixed(1)} Hz`
  noteConfEl.textContent = 'Keyboard'
  centsNeedleEl.style.left = '50%'
  centsValueEl.textContent = '0 ¢'
  setTuningColor(0)
  trail.push(note.hz, true, { snap: true })
}

function targetName(midi: number): string {
  return formatNote(analyzePitch(midiToHz(midi), 1))
}

function targetHoldSeconds(): number {
  const value = holdSecondsInput.valueAsNumber
  return Number.isFinite(value) ? Math.max(0.5, Math.min(10, value)) : DEFAULT_TARGET_HOLD_SECONDS
}

function targetPrompt(midi: number): string {
  return `Target ${targetName(midi)} · sing and hold for ${targetHoldSeconds().toFixed(1)}s`
}

function selectTarget(midi: number): void {
  keyboardEl.querySelectorAll('.key.target, .key.achieved').forEach((key) => {
    key.classList.remove('target', 'achieved')
  })
  targetMidi = midi
  targetHeldSince = null
  targetCompleted = false
  setKeyState(keyboardEl, midi, 'target', true)
  targetStatusEl.textContent = targetPrompt(midi)
}

function updateTargetProgress(note: DetectedNote | null): void {
  if (targetMidi == null || targetCompleted) return

  const targetIsPlaying =
    heldPointerNotes.has(targetMidi) ||
    [...heldComputerKeys.values()].includes(targetMidi)
  const matchesTarget = note != null && Math.round(note.midi) === targetMidi

  if (!matchesTarget || targetIsPlaying) {
    targetHeldSince = null
    targetStatusEl.textContent = targetPrompt(targetMidi)
    return
  }

  const now = performance.now()
  targetHeldSince ??= now
  const heldMs = now - targetHeldSince
  const targetHoldMs = targetHoldSeconds() * 1000
  const remainingSeconds = Math.max(0, (targetHoldMs - heldMs) / 1000)
  targetStatusEl.textContent =
    `Target ${targetName(targetMidi)} · ${remainingSeconds.toFixed(1)}s`

  if (heldMs < targetHoldMs) return

  targetCompleted = true
  suppressDetectionUntil = Number.POSITIVE_INFINITY
  void synth.playSuccessSound().then((durationSeconds) => {
    // Ignore the sound itself plus one analysis window, so its trailing audio
    // cannot appear as a detected note.
    suppressDetectionUntil =
      performance.now() + durationSeconds * 1000 + WINDOW_SECONDS * 1000 + 200
  })
  const seconds = targetHoldSeconds()
  targetStatusEl.textContent =
    `${targetName(targetMidi)} held for ${seconds} ${seconds === 1 ? 'second' : 'seconds'} ✓`
  keyboardEl
    .querySelector(`.key[data-midi="${targetMidi}"]`)
    ?.classList.add('achieved')
}

function playNote(midi: number): void {
  selectTarget(midi)
  synth.noteOn(midi)
  setKeyState(keyboardEl, midi, 'played', true)
  showPlayedNote(midi)
}

function releaseNote(midi: number): void {
  synth.noteOff(midi)
  setKeyState(keyboardEl, midi, 'played', false)
}

function setKeyboardOctave(next: number): void {
  keyboardOctave = Math.max(2, Math.min(6, next))
  octaveValueEl.textContent = String(keyboardOctave)
  const base = (keyboardOctave + 1) * 12
  renderKeyboard(keyboardEl, 48, 84, base)
  if (targetMidi != null) {
    setKeyState(keyboardEl, targetMidi, 'target', true)
    if (targetCompleted) {
      keyboardEl
        .querySelector(`.key[data-midi="${targetMidi}"]`)
        ?.classList.add('achieved')
    }
  }
  // Keep the scope looking at the octave you can play.
  trail.setOctave(base)
}

function normalize(samples: Float32Array): Float32Array {
  let max = 0
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i])
    if (a > max) max = a
  }
  if (max < 1e-6) return samples
  const out = new Float32Array(samples.length)
  const scale = 1 / max
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * scale
  return out
}

function pickLatestVoiced(
  pitch: Float32Array,
  confidence: Float32Array,
): DetectedNote | null {
  // Prefer the most recent stable voiced frames near the end of the window.
  const start = Math.max(0, pitch.length - 8)
  let bestIdx = -1
  let bestConf = CONFIDENCE_THRESHOLD

  for (let i = pitch.length - 1; i >= start; i--) {
    const hz = pitch[i]
    const conf = confidence[i]
    if (
      conf > bestConf &&
      hz >= MODEL_FMIN &&
      hz <= MODEL_FMAX
    ) {
      bestConf = conf
      bestIdx = i
      break
    }
  }

  // Fallback: scan a wider recent range for any voiced frame.
  if (bestIdx < 0) {
    for (let i = pitch.length - 1; i >= Math.max(0, pitch.length - 20); i--) {
      const hz = pitch[i]
      const conf = confidence[i]
      if (conf > CONFIDENCE_THRESHOLD && hz >= MODEL_FMIN && hz <= MODEL_FMAX) {
        bestIdx = i
        break
      }
    }
  }

  if (bestIdx < 0) return null
  return analyzePitch(pitch[bestIdx], confidence[bestIdx])
}

async function runInference(): Promise<void> {
  if (!listening || !onnx.ready) return
  if (ring.length < MIN_AUDIO_SAMPLES) return

  const now = performance.now()
  if (now - lastInferAt < INFER_EVERY_MS) return
  lastInferAt = now

  const window = ring.latest(Math.min(WINDOW_SAMPLES, ring.length))
  const level = ring.peak(Math.min(2048, ring.length))
  levelFillEl.style.width = `${Math.min(100, level * 220)}%`

  if (performance.now() < suppressDetectionUntil) {
    setVoicedUi(null)
    trail.push(null, false)
    return
  }

  try {
    const result = await onnx.runInference(normalize(window))
    if (performance.now() < suppressDetectionUntil) {
      setVoicedUi(null)
      trail.push(null, false)
      return
    }
    const note = pickLatestVoiced(result.pitch_hz, result.confidence)
    updateTargetProgress(note)
    setVoicedUi(note)
    trail.push(note?.hz ?? null, note != null)
  } catch (err) {
    if (err instanceof Error && err.message === 'Superseded') return
    console.error(err)
  }
}

function animate(): void {
  trail.draw()
  requestAnimationFrame(animate)
}

async function startListening(): Promise<void> {
  try {
    setListenLabel('Requesting microphone…')
    ring.clear()
    trail.clear()
    smoothedCents = 0
    lastNote = null
    targetHeldSince = null

    await capture.start((chunk) => {
      ring.push(chunk)
      void runInference()
    })

    listening = true
    setListenLabel('stop listening', 'listening')

    if (inferTimer != null) window.clearInterval(inferTimer)
    inferTimer = window.setInterval(() => {
      void runInference()
    }, INFER_EVERY_MS)
  } catch (err) {
    listening = false
    const message =
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone permission denied'
        : err instanceof Error
          ? err.message
          : 'Could not open microphone'
    setListenLabel(message, 'error')
  }
}

async function stopListening(): Promise<void> {
  listening = false
  if (inferTimer != null) {
    window.clearInterval(inferTimer)
    inferTimer = null
  }
  await capture.stop()
  setListenLabel('start listening')
  levelFillEl.style.width = '0%'
  targetHeldSince = null
  setVoicedUi(null)
}

listenBtn.addEventListener('click', () => {
  if (listening) void stopListening()
  else void startListening()
})

window.addEventListener('keydown', (event) => {
  if (
    event.repeat ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement
  ) {
    return
  }

  const key = event.key.toLowerCase()
  if (key === 'z') {
    setKeyboardOctave(keyboardOctave - 1)
    event.preventDefault()
    return
  }
  if (key === 'x') {
    setKeyboardOctave(keyboardOctave + 1)
    event.preventDefault()
    return
  }

  const step = KEYBOARD_STEPS[key]
  if (step == null) return
  const midi = (keyboardOctave + 1) * 12 + step
  heldComputerKeys.set(key, midi)
  playNote(midi)
  event.preventDefault()
})

window.addEventListener('keyup', (event) => {
  const key = event.key.toLowerCase()
  const midi = heldComputerKeys.get(key)
  if (midi == null) return
  heldComputerKeys.delete(key)
  releaseNote(midi)
})

keyboardEl.addEventListener('pointerdown', (event) => {
  const key = (event.target as HTMLElement).closest<HTMLElement>('.key')
  if (!key?.dataset.midi) return
  const midi = Number(key.dataset.midi)
  key.setPointerCapture(event.pointerId)
  heldPointerNotes.add(midi)
  playNote(midi)
  event.preventDefault()
})

function releasePointerNote(event: PointerEvent): void {
  const key = (event.target as HTMLElement).closest<HTMLElement>('.key')
  if (!key?.dataset.midi) return
  const midi = Number(key.dataset.midi)
  if (!heldPointerNotes.has(midi)) return
  heldPointerNotes.delete(midi)
  releaseNote(midi)
}

keyboardEl.addEventListener('pointerup', releasePointerNote)
keyboardEl.addEventListener('pointercancel', releasePointerNote)
octaveDownBtn.addEventListener('click', () => setKeyboardOctave(keyboardOctave - 1))
octaveUpBtn.addEventListener('click', () => setKeyboardOctave(keyboardOctave + 1))
holdSecondsInput.addEventListener('change', () => {
  const seconds = targetHoldSeconds()
  holdSecondsInput.value = String(seconds)
  targetHeldSince = null
  targetCompleted = false
  keyboardEl.querySelectorAll('.key.achieved').forEach((key) => {
    key.classList.remove('achieved')
  })
  if (targetMidi != null) targetStatusEl.textContent = targetPrompt(targetMidi)
})

window.addEventListener('blur', () => {
  heldComputerKeys.clear()
  heldPointerNotes.clear()
  synth.allNotesOff()
  keyboardEl.querySelectorAll('.key.played').forEach((key) => {
    key.classList.remove('played')
  })
})

// The scope now spans the stage and its height is viewport-relative, so watch the
// canvas box itself instead of window resizes to keep the backing store crisp.
new ResizeObserver(() => {
  trail.resize()
}).observe(trailCanvas)

// Backing store scale depends on devicePixelRatio, which the observer does not track.
window.addEventListener('resize', () => {
  trail.resize()
})

async function boot(): Promise<void> {
  animate()
  try {
    setListenLabel('Loading F0 model…')
    await onnx.initialize()
    setListenLabel('start listening')
    listenBtn.disabled = false
  } catch (err) {
    console.error(err)
    setListenLabel(
      err instanceof Error ? err.message : 'Failed to load pitch model',
      'error',
    )
  }
}

void boot()
