import './fonts.css'
import './style.css'
import { AudioCapture, SampleRingBuffer } from './audioCapture'
import {
  DEFAULT_CODE_LABELS,
  KEYBOARD_STEPS,
  OCTAVE_DOWN_CODE,
  OCTAVE_UP_CODE,
  codeLabels,
  highlightDetectedKey,
  onKeyboardLayoutChange,
  renderKeyboard,
  setKeyState,
} from './keyboard'
import { HarmonicTrail, type RecordedHarmonics } from './harmonicTrail'
import { analyzeHarmonics } from './harmonics'
import { analyzeSong, decodeSong } from './karaoke'
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
import { RecordingPlayer } from './playback'
import { Synth } from './synth'
import {
  PitchTrail,
  formatClock,
  type RecordedTrail,
  type TrailPoint,
} from './trail'
import { tuningColor } from './tuning'

const WINDOW_SECONDS = 0.85
const WINDOW_SAMPLES = Math.round(TARGET_SAMPLE_RATE * WINDOW_SECONDS)
const INFER_EVERY_MS = 70
const CONFIDENCE_THRESHOLD = 0.85
const MIN_AUDIO_SAMPLES = 256
const DEFAULT_TARGET_HOLD_SECONDS = 2
const INPUT_SOURCE_STORAGE_KEY = 'voicetool.inputSource'

const noteDisplayEl = document.querySelector<HTMLDivElement>('#noteDisplay')!
const noteNameEl = document.querySelector<HTMLSpanElement>('#noteName')!
const noteHzEl = document.querySelector<HTMLSpanElement>('#noteHz')!
const noteConfEl = document.querySelector<HTMLSpanElement>('#noteConf')!
const centsNeedleEl = document.querySelector<HTMLDivElement>('#centsNeedle')!
const centsValueEl = document.querySelector<HTMLParagraphElement>('#centsValue')!
const levelFillEl = document.querySelector<HTMLDivElement>('#levelFill')!
const listenBtn = document.querySelector<HTMLButtonElement>('#listenBtn')!
const listenLabel = document.querySelector<HTMLSpanElement>('#listenLabel')!
const inputSourceEl = document.querySelector<HTMLSelectElement>('#inputSource')!
const trailCanvas = document.querySelector<HTMLCanvasElement>('#trail')!
const harmonicCanvas = document.querySelector<HTMLCanvasElement>('#harmonicTrail')!
const keyboardEl = document.querySelector<HTMLDivElement>('#keyboard')!
const octaveDownBtn = document.querySelector<HTMLButtonElement>('#octaveDown')!
const octaveUpBtn = document.querySelector<HTMLButtonElement>('#octaveUp')!
const octaveValueEl = document.querySelector<HTMLElement>('#octaveValue')!
const targetStatusEl = document.querySelector<HTMLParagraphElement>('#targetStatus')!
const holdSecondsInput = document.querySelector<HTMLInputElement>('#holdSeconds')!
const monitorInput = document.querySelector<HTMLInputElement>('#monitorInput')!
const micGainControlEl = document.querySelector<HTMLDivElement>('#micGainControl')!
const micGainButton = document.querySelector<HTMLButtonElement>('#micGainButton')!
const micGainButtonValueEl = document.querySelector<HTMLSpanElement>('#micGainButtonValue')!
const micGainPopover = document.querySelector<HTMLDivElement>('#micGainPopover')!
const micGainInput = document.querySelector<HTMLInputElement>('#micGain')!
const micGainValueEl = document.querySelector<HTMLOutputElement>('#micGainValue')!
const recordStatusEl = document.querySelector<HTMLParagraphElement>('#recordStatus')!
const recordingDownload = document.querySelector<HTMLAnchorElement>('#recordingDownload')!
const transportEl = document.querySelector<HTMLDivElement>('#transport')!
const playBtn = document.querySelector<HTMLButtonElement>('#playBtn')!
const playLabel = document.querySelector<HTMLSpanElement>('#playLabel')!
const transportTimeEl = document.querySelector<HTMLSpanElement>('#transportTime')!
const closeTakeBtn = document.querySelector<HTMLButtonElement>('#closeTakeBtn')!
const backBtn = document.querySelector<HTMLButtonElement>('#backBtn')!
const zoomOutBtn = document.querySelector<HTMLButtonElement>('#zoomOutBtn')!
const zoomInBtn = document.querySelector<HTMLButtonElement>('#zoomInBtn')!
const zoomLevelEl = document.querySelector<HTMLSpanElement>('#zoomLevel')!
const transportModeEl = document.querySelector<HTMLSpanElement>('#transportMode')!
const karaokeAudioControlsEl = document.querySelector<HTMLDivElement>('#karaokeAudioControls')!
const karaokeMicPlaybackInput = document.querySelector<HTMLInputElement>('#karaokeMicPlayback')!
const karaokeSongPlaybackInput = document.querySelector<HTMLInputElement>('#karaokeSongPlayback')!
const karaokeFileEl = document.querySelector<HTMLInputElement>('#karaokeFile')!
const karaokeUploadEl = document.querySelector<HTMLLabelElement>('#karaokeUpload')!
const karaokeStatusEl = document.querySelector<HTMLParagraphElement>('#karaokeStatus')!

const onnx = new ONNXService('model.onnx')
const capture = new AudioCapture()
const ring = new SampleRingBuffer(TARGET_SAMPLE_RATE * 2)
const trail = new PitchTrail(trailCanvas, 8)
const harmonics = new HarmonicTrail(harmonicCanvas, 8)
const synth = new Synth()
const player = new RecordingPlayer()

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
let recordingUrl: string | null = null
let scrubPointer: number | null = null
let resumeAfterScrub = false
let shownPlayheadMidi: number | null | undefined
let reviewKind: 'take' | 'karaoke' | null = null
let karaokeJob = 0
const heldComputerKeys = new Map<string, number>()
const heldPointerNotes = new Set<number>()
const playedNoteOrder: number[] = []
const keyboardHelpEl = document.querySelector<HTMLParagraphElement>('.keyboard-help')!
let keyLabels = DEFAULT_CODE_LABELS

// Also seeds the scope viewport and the octave readout for the default octave.
setKeyboardOctave(keyboardOctave)
void refreshKeyLabels()
onKeyboardLayoutChange(() => {
  void refreshKeyLabels()
})

async function refreshKeyLabels(): Promise<void> {
  keyLabels = await codeLabels()
  setKeyboardOctave(keyboardOctave)
  const down = keyLabels[OCTAVE_DOWN_CODE] ?? 'Z'
  const up = keyLabels[OCTAVE_UP_CODE] ?? 'X'
  keyboardHelpEl.replaceChildren()
  const downKbd = document.createElement('kbd')
  downKbd.textContent = down
  const upKbd = document.createElement('kbd')
  upKbd.textContent = up
  keyboardHelpEl.append(downKbd, '/', upKbd, ' octave')
}

function setListenLabel(text: string, kind: 'idle' | 'listening' | 'error' = 'idle'): void {
  listenLabel.textContent = text
  listenBtn.classList.toggle('error', kind === 'error')
  listenBtn.classList.toggle('active', kind === 'listening')
}

function savedInputSource(): string {
  try {
    return localStorage.getItem(INPUT_SOURCE_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function saveInputSource(deviceId: string): void {
  try {
    if (deviceId) localStorage.setItem(INPUT_SOURCE_STORAGE_KEY, deviceId)
    else localStorage.removeItem(INPUT_SOURCE_STORAGE_KEY)
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

async function refreshInputSources(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) return

  const selected = inputSourceEl.value || savedInputSource()
  const inputs = (await navigator.mediaDevices.enumerateDevices())
    .filter((device) => device.kind === 'audioinput')
  inputSourceEl.replaceChildren(new Option('Default input', ''))
  inputs.forEach((device, index) => {
    inputSourceEl.add(new Option(device.label || `Microphone ${index + 1}`, device.deviceId))
  })
  if ([...inputSourceEl.options].some((option) => option.value === selected)) {
    inputSourceEl.value = selected
  } else {
    inputSourceEl.value = ''
    saveInputSource('')
  }
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

/** Counts the harmonics in the same window the pitch was read from. */
function pushHarmonics(samples: Float32Array | null, note: DetectedNote | null): void {
  harmonics.push(
    samples && note ? analyzeHarmonics(samples, note.hz, TARGET_SAMPLE_RATE) : null,
  )
}

function setVoicedUi(note: DetectedNote | null): void {
  // A take under review owns the panel; detection keeps filling the live trail
  // in the background so it is ready when you go back to it.
  if (trail.reviewing && reviewKind !== 'karaoke') return

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
  // Let a reviewed take repaint the panel as soon as its playhead moves again.
  shownPlayheadMidi = undefined
  noteDisplayEl.classList.add('voiced')
  noteNameEl.textContent = formatNote(note)
  noteHzEl.textContent = `${note.hz.toFixed(1)} Hz`
  noteConfEl.textContent = 'Keyboard'
  centsNeedleEl.style.left = '50%'
  centsValueEl.textContent = '0 ¢'
  setTuningColor(0)
}

/** Drives the note panel from the take's playhead instead of the microphone. */
function showPlayheadNote(point: TrailPoint | null): void {
  const midi = point?.midi ?? null
  if (midi === shownPlayheadMidi) return
  shownPlayheadMidi = midi

  if (midi == null) {
    noteDisplayEl.classList.remove('voiced')
    noteNameEl.textContent = '—'
    noteHzEl.textContent = '— Hz'
    noteConfEl.textContent = reviewKind === 'karaoke' ? 'Target' : 'Take'
    centsNeedleEl.style.left = '50%'
    centsValueEl.textContent = '0 ¢'
    setTuningColor(null)
    highlightDetectedKey(keyboardEl, null)
    return
  }

  const note = analyzePitch(midiToHz(midi), 1)
  noteDisplayEl.classList.add('voiced')
  noteNameEl.textContent = formatNote(note)
  noteHzEl.textContent = `${note.hz.toFixed(1)} Hz`
  noteConfEl.textContent = reviewKind === 'karaoke' ? 'Target' : 'Take'
  const clamped = Math.max(-50, Math.min(50, note.cents))
  centsNeedleEl.style.left = `${((clamped + 50) / 100) * 100}%`
  centsValueEl.textContent = `${clamped > 0 ? '+' : ''}${clamped.toFixed(0)} ¢`
  setTuningColor(clamped)
  highlightDetectedKey(keyboardEl, Math.round(note.midi))
}

function updateTransport(): void {
  transportTimeEl.textContent =
    `${formatClock(trail.playheadSeconds, 1)} / ${formatClock(trail.duration, 1)}`
  playBtn.classList.toggle('playing', player.isPlaying)
  playLabel.textContent = player.isPlaying ? 'Pause' : 'Play'
  zoomLevelEl.textContent = `${Math.round(trail.zoom * 100)}%`
  zoomOutBtn.disabled = !trail.canZoomOut
  zoomInBtn.disabled = !trail.canZoomIn
}

function syncReviewViewport(): void {
  harmonics.setReviewViewport(trail.visibleStart, trail.visibleEnd)
}

function movePlayhead(seconds: number): void {
  trail.setPlayhead(seconds)
  syncReviewViewport()
  const at = trail.playheadSeconds
  harmonics.setPlayhead(at)
  player.seek(at)
  showPlayheadNote(trail.pointAt(at))
  updateTransport()
}

function openTake(
  recording: RecordedTrail,
  harmonicTake: RecordedHarmonics,
  kind: 'take' | 'karaoke' = 'take',
): void {
  reviewKind = kind
  trail.showRecording(recording)
  harmonics.showRecording(harmonicTake)
  syncReviewViewport()
  transportEl.hidden = false
  trailCanvas.classList.add('scrubbable')
  harmonicCanvas.classList.add('scrubbable')
  document.body.classList.toggle('karaoke-mode', kind === 'karaoke')
  karaokeAudioControlsEl.hidden = kind !== 'karaoke'
  player.setMuted(kind === 'karaoke' && !karaokeSongPlaybackInput.checked)
  closeTakeBtn.textContent = kind === 'karaoke' ? 'Exit karaoke' : 'Back to live'
  shownPlayheadMidi = undefined
  showPlayheadNote(trail.pointAt(0))
  updateTransport()
}

function closeTake(): void {
  if (!trail.reviewing) return
  player.pause()
  player.unload()
  trail.closeRecording()
  harmonics.closeRecording()
  transportEl.hidden = true
  trailCanvas.classList.remove('scrubbable')
  harmonicCanvas.classList.remove('scrubbable')
  scrubPointer = null
  resumeAfterScrub = false
  shownPlayheadMidi = undefined
  reviewKind = null
  document.body.classList.remove('karaoke-mode')
  karaokeAudioControlsEl.hidden = true
  transportModeEl.textContent = ''
  closeTakeBtn.textContent = 'Back to live'
  recordStatusEl.textContent = ''
  lastNote = null
  holdUntil = 0
  setVoicedUi(null)
}

function goBack(seconds = 5): void {
  movePlayhead(trail.playheadSeconds - seconds)
}

function zoomReview(multiplier: number): void {
  trail.setReviewZoom(trail.zoom * multiplier)
  syncReviewViewport()
  updateTransport()
}

function enableTrackpadZoom(canvas: HTMLCanvasElement): void {
  canvas.addEventListener('wheel', (event) => {
    // macOS browsers expose a trackpad pinch as a ctrl-modified wheel event.
    // Leave ordinary two-finger scrolling alone so the canvas does not trap the page.
    if (!trail.reviewing) return
    if (event.ctrlKey) {
      const delta = Math.max(-50, Math.min(50, event.deltaY))
      trail.zoomAtClientX(Math.exp(-delta * 0.02), event.clientX)
      syncReviewViewport()
      updateTransport()
      event.preventDefault()
      return
    }

    // A predominantly horizontal two-finger gesture pans a zoomed timeline.
    // Scale line/page wheel units for non-trackpad pointing devices too.
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? canvas.clientWidth
        : 1
    if (!trail.panReviewByPixels(event.deltaX * unit, canvas.clientWidth)) return
    syncReviewViewport()
    event.preventDefault()
  }, { passive: false })

  // Safari exposes the same trackpad pinch through WebKit gesture events.
  // Apply each incremental scale change so it behaves like the wheel path above.
  let previousGestureScale = 1
  const onGestureStart = (event: Event): void => {
    if (!trail.reviewing) return
    previousGestureScale = 1
    event.preventDefault()
  }
  const onGestureChange = (event: Event): void => {
    if (!trail.reviewing) return
    const gesture = event as Event & { scale?: number; clientX?: number }
    const scale = gesture.scale ?? 1
    const rect = canvas.getBoundingClientRect()
    const clientX = gesture.clientX ?? rect.left + rect.width / 2
    trail.zoomAtClientX(scale / previousGestureScale, clientX)
    previousGestureScale = scale
    syncReviewViewport()
    updateTransport()
    event.preventDefault()
  }
  canvas.addEventListener('gesturestart', onGestureStart, { passive: false })
  canvas.addEventListener('gesturechange', onGestureChange, { passive: false })
}

async function loadKaraokeFile(file: File): Promise<void> {
  const job = ++karaokeJob
  karaokeUploadEl.classList.add('busy')
  karaokeFileEl.disabled = true
  karaokeStatusEl.textContent = `Decoding ${file.name}…`

  try {
    if (listening) await stopListening()
    closeTake()
    player.unload()

    const decoded = await decodeSong(file)
    if (job !== karaokeJob) return

    karaokeStatusEl.textContent = 'Analyzing vocals… 0%'
    const target = await analyzeSong(
      decoded.samples16k,
      decoded.buffer.duration,
      (audio) => onnx.runInference(audio),
      (ratio) => {
        if (job === karaokeJob) {
          karaokeStatusEl.textContent = `Analyzing vocals… ${Math.round(ratio * 100)}%`
        }
      },
    )
    if (job !== karaokeJob) return

    player.loadBuffer(decoded.buffer)
    playBtn.disabled = false
    recordingDownload.hidden = true
    recordStatusEl.textContent = ''
    transportModeEl.textContent = `Karaoke · ${file.name}`
    openTake(target, { points: [], duration: target.duration }, 'karaoke')
    karaokeStatusEl.textContent = `${file.name} ready`
    playBtn.focus()
  } catch (err) {
    if (job !== karaokeJob) return
    console.error(err)
    player.unload()
    karaokeStatusEl.textContent =
      err instanceof Error ? `Could not analyze MP3: ${err.message}` : 'Could not analyze MP3'
  } finally {
    if (job === karaokeJob) {
      karaokeUploadEl.classList.remove('busy')
      karaokeFileEl.disabled = false
      karaokeFileEl.value = ''
    }
  }
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

/**
 * Ends a finished attempt so the target can be won again, while the guard in
 * updateTargetProgress keeps the cue from retriggering under a held note.
 */
function rearmTarget(): void {
  targetHeldSince = null
  if (!targetCompleted) return
  targetCompleted = false
  keyboardEl.querySelectorAll('.key.achieved').forEach((key) => {
    key.classList.remove('achieved')
  })
  if (targetMidi != null) targetStatusEl.textContent = targetPrompt(targetMidi)
}

function updateTargetProgress(note: DetectedNote | null): void {
  if (targetMidi == null || trail.reviewing) return

  const targetIsPlaying =
    heldPointerNotes.has(targetMidi) ||
    [...heldComputerKeys.values()].includes(targetMidi)
  const matchesTarget = note != null && Math.round(note.midi) === targetMidi

  if (!matchesTarget || targetIsPlaying) {
    rearmTarget()
    targetStatusEl.textContent = targetPrompt(targetMidi)
    return
  }

  if (targetCompleted) return

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
  const previousIndex = playedNoteOrder.indexOf(midi)
  if (previousIndex >= 0) playedNoteOrder.splice(previousIndex, 1)
  playedNoteOrder.push(midi)
  trail.beginPlayedNote(midi)
  showPlayedNote(midi)
}

function releaseNote(midi: number): void {
  const stillHeld =
    [...heldComputerKeys.values()].includes(midi) || heldPointerNotes.has(midi)
  if (stillHeld) return

  synth.noteOff(midi)
  setKeyState(keyboardEl, midi, 'played', false)
  trail.endPlayedNote(midi)
  const index = playedNoteOrder.indexOf(midi)
  if (index >= 0) playedNoteOrder.splice(index, 1)

  // If a second key is still down, make it the sustained timeline note again
  // immediately rather than waiting for the next animation-frame update.
  const previousMidi = playedNoteOrder.at(-1)
  if (previousMidi != null) {
    showPlayedNote(previousMidi)
  }
}

function setKeyboardOctave(next: number): void {
  keyboardOctave = Math.max(2, Math.min(6, next))
  octaveValueEl.textContent = String(keyboardOctave)
  const base = (keyboardOctave + 1) * 12
  renderKeyboard(keyboardEl, 48, 84, base, keyLabels)
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
    pushHarmonics(null, null)
    trail.push(null, false)
    return
  }

  try {
    const result = await onnx.runInference(normalize(window))
    if (performance.now() < suppressDetectionUntil) {
      setVoicedUi(null)
      pushHarmonics(null, null)
      trail.push(null, false)
      return
    }
    const note = pickLatestVoiced(result.pitch_hz, result.confidence)
    pushHarmonics(window, note)
    updateTargetProgress(note)
    setVoicedUi(note)
    if (reviewKind === 'karaoke') {
      if (player.isPlaying) {
        trail.pushPerformance(note?.hz ?? null, note != null, player.currentTime)
      }
    } else {
      trail.push(note?.hz ?? null, note != null)
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'Superseded') return
    console.error(err)
  }
}

function animate(): void {
  if (trail.reviewing && player.isPlaying && scrubPointer == null) {
    trail.setPlayhead(player.currentTime)
    syncReviewViewport()
    const at = trail.playheadSeconds
    harmonics.setPlayhead(at)
    if (reviewKind !== 'karaoke' || !listening) {
      showPlayheadNote(trail.pointAt(at))
    }
    updateTransport()
  }
  trail.draw()
  harmonics.draw()
  requestAnimationFrame(animate)
}

async function startListening(): Promise<void> {
  try {
    const joiningKaraoke = reviewKind === 'karaoke'
    setListenLabel('Requesting microphone…')
    if (!joiningKaraoke) closeTake()
    ring.clear()
    if (!joiningKaraoke) trail.clear()
    harmonics.clear()
    smoothedCents = 0
    lastNote = null
    rearmTarget()

    await capture.start((chunk) => {
      ring.push(chunk)
      void runInference()
    }, inputSourceEl.value || undefined)

    listening = true
    inputSourceEl.disabled = true
    await refreshInputSources()
    setListenLabel('stop listening', 'listening')
    // Karaoke keeps its imported target in the scope. Regular listening sessions
    // are captured as reviewable takes as before.
    if (joiningKaraoke) {
      trail.startPerformancePass()
    } else {
      if ('MediaRecorder' in window) capture.startRecording()
      trail.startRecording()
      harmonics.startRecording()
    }

    if (inferTimer != null) window.clearInterval(inferTimer)
    inferTimer = window.setInterval(() => {
      void runInference()
    }, INFER_EVERY_MS)
  } catch (err) {
    listening = false
    inputSourceEl.disabled = false
    const message =
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone permission denied'
        : err instanceof Error
          ? err.message
          : 'Could not open microphone'
    setListenLabel(message, 'error')
  }
}

async function finishRecording(): Promise<void> {
  // Stop the pitch capture first so its timeline ends with the audio rather than
  // with the container's stop event.
  const take = trail.stopRecording()
  const harmonicTake = harmonics.stopRecording()
  const recording = await capture.stopRecording()
  if (recording.size === 0 && take.duration < 0.05) return

  let audioSeconds = 0
  if (recording.size > 0) {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl)
    recordingUrl = URL.createObjectURL(recording)
    recordingDownload.href = recordingUrl
    recordingDownload.download =
      `voicetool-${new Date().toISOString().replaceAll(':', '-')}.${recording.type.includes('mp4') ? 'm4a' : 'webm'}`
    recordingDownload.hidden = false

    try {
      audioSeconds = await player.load(recording)
      playBtn.disabled = false
      recordStatusEl.textContent = ''
    } catch (err) {
      console.error(err)
      player.unload()
      playBtn.disabled = true
      recordStatusEl.textContent = 'Take shown without audio — this browser could not decode it'
    }
  } else {
    recordingDownload.hidden = true
    playBtn.disabled = true
    recordStatusEl.textContent = 'Take shown without audio'
  }

  const duration = Math.max(audioSeconds, take.duration)
  openTake(
    { points: take.points, playedNotes: take.playedNotes, duration },
    { points: harmonicTake.points, duration },
  )
}

async function stopListening(): Promise<void> {
  listening = false
  if (reviewKind !== 'karaoke') await finishRecording()
  if (inferTimer != null) {
    window.clearInterval(inferTimer)
    inferTimer = null
  }
  await capture.stop()
  inputSourceEl.disabled = false
  setListenLabel('start listening')
  levelFillEl.style.width = '0%'
  targetHeldSince = null
  setVoicedUi(null)
  // The listening button may still own keyboard focus after Space stopped the
  // take. Move focus to playback so the next Space plays instead of recording.
  if (!playBtn.disabled) playBtn.focus()
}

listenBtn.addEventListener('click', () => {
  if (listening) void stopListening()
  else void startListening()
})

inputSourceEl.addEventListener('change', () => {
  saveInputSource(inputSourceEl.value)
})

/** Transport keys while a take is open. Returns whether the key was handled. */
function handleTakeKey(event: KeyboardEvent): boolean {
  const nudge = event.shiftKey ? 1 : 0.1

  switch (event.key) {
    case 'Escape':
      if (event.repeat) return false
      closeTake()
      return true
    case 'ArrowLeft':
      movePlayhead(trail.playheadSeconds - nudge)
      return true
    case 'ArrowRight':
      movePlayhead(trail.playheadSeconds + nudge)
      return true
    case 'Home':
      movePlayhead(0)
      return true
    case 'End':
      movePlayhead(trail.duration)
      return true
    default:
      return false
  }
}

window.addEventListener('keydown', (event) => {
  // Playback owns Space whenever a take or karaoke track is open, even when a
  // form control or another button has focus. Preventing the native action also
  // avoids a focused button activating on keyup and toggling playback twice.
  if (trail.reviewing && event.code === 'Space') {
    if (!event.repeat) {
      player.toggle()
      updateTransport()
    }
    event.preventDefault()
    return
  }

  if (
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement ||
    event.target instanceof HTMLTextAreaElement
  ) {
    return
  }

  // Before the repeat guard: holding an arrow key should keep the playhead moving.
  if (trail.reviewing && handleTakeKey(event)) {
    event.preventDefault()
    return
  }

  if (event.repeat) return

  // Physical key positions (event.code), so QWERTZ Y/Z match the piano row.
  if (event.code === OCTAVE_DOWN_CODE) {
    setKeyboardOctave(keyboardOctave - 1)
    event.preventDefault()
    return
  }
  if (event.code === OCTAVE_UP_CODE) {
    setKeyboardOctave(keyboardOctave + 1)
    event.preventDefault()
    return
  }

  const step = KEYBOARD_STEPS[event.code]
  if (step == null) return
  const midi = (keyboardOctave + 1) * 12 + step
  heldComputerKeys.set(event.code, midi)
  playNote(midi)
  event.preventDefault()
})

window.addEventListener('keyup', (event) => {
  const midi = heldComputerKeys.get(event.code)
  if (midi == null) return
  heldComputerKeys.delete(event.code)
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
monitorInput.addEventListener('change', () => {
  capture.setMonitoring(monitorInput.checked)
  karaokeMicPlaybackInput.checked = monitorInput.checked
})
karaokeMicPlaybackInput.addEventListener('change', () => {
  monitorInput.checked = karaokeMicPlaybackInput.checked
  capture.setMonitoring(karaokeMicPlaybackInput.checked)
})
karaokeSongPlaybackInput.addEventListener('change', () => {
  player.setMuted(!karaokeSongPlaybackInput.checked)
})

function setMicGainOpen(open: boolean): void {
  micGainPopover.hidden = !open
  micGainButton.setAttribute('aria-expanded', String(open))
  if (open) micGainInput.focus()
}

micGainButton.addEventListener('click', () => {
  setMicGainOpen(micGainPopover.hasAttribute('hidden'))
})
document.addEventListener('pointerdown', (event) => {
  if (!micGainPopover.hasAttribute('hidden') && !micGainControlEl.contains(event.target as Node)) {
    setMicGainOpen(false)
  }
})
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || micGainPopover.hasAttribute('hidden')) return
  setMicGainOpen(false)
  micGainButton.focus()
})
micGainInput.addEventListener('input', () => {
  const decibels = Number(micGainInput.value)
  capture.setInputGain(decibels)
  micGainValueEl.value = `${decibels} dB`
  micGainButtonValueEl.textContent = `+${decibels}`
})
playBtn.addEventListener('click', () => {
  player.toggle()
  updateTransport()
})
backBtn.addEventListener('click', () => goBack())
zoomOutBtn.addEventListener('click', () => zoomReview(0.5))
zoomInBtn.addEventListener('click', () => zoomReview(2))

karaokeFileEl.addEventListener('change', () => {
  const file = karaokeFileEl.files?.[0]
  if (!file) return
  const looksLikeMp3 = file.type === 'audio/mpeg' || file.name.toLowerCase().endsWith('.mp3')
  if (!looksLikeMp3) {
    karaokeStatusEl.textContent = 'Choose an MP3 file with isolated vocals'
    karaokeFileEl.value = ''
    return
  }
  void loadKaraokeFile(file)
})

closeTakeBtn.addEventListener('click', closeTake)

player.onEnded = () => {
  trail.setPlayhead(trail.duration)
  syncReviewViewport()
  const at = trail.playheadSeconds
  harmonics.setPlayhead(at)
  showPlayheadNote(trail.pointAt(at))
  updateTransport()
}

/** Both scopes share one playhead, so either can be dragged to move the take. */
function enableScrubbing(
  canvas: HTMLCanvasElement,
  timeAtClientX: (clientX: number) => number,
): void {
  canvas.addEventListener('pointerdown', (event) => {
    if (!trail.reviewing) return
    scrubPointer = event.pointerId
    canvas.setPointerCapture(event.pointerId)
    // Scrubbing a live source is not possible, so park playback and pick it back up
    // from wherever the cursor is dropped.
    resumeAfterScrub = player.isPlaying
    if (resumeAfterScrub) player.pause()
    movePlayhead(timeAtClientX(event.clientX))
    event.preventDefault()
  })

  canvas.addEventListener('pointermove', (event) => {
    if (scrubPointer !== event.pointerId) return
    movePlayhead(timeAtClientX(event.clientX))
  })

  const endScrub = (event: PointerEvent): void => {
    if (scrubPointer !== event.pointerId) return
    scrubPointer = null
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId)
    }
    if (!resumeAfterScrub) return
    resumeAfterScrub = false
    player.play()
    updateTransport()
  }

  canvas.addEventListener('pointerup', endScrub)
  canvas.addEventListener('pointercancel', endScrub)
}

enableScrubbing(trailCanvas, (clientX) => trail.timeAtClientX(clientX))
enableScrubbing(harmonicCanvas, (clientX) => harmonics.timeAtClientX(clientX))
enableTrackpadZoom(trailCanvas)
enableTrackpadZoom(harmonicCanvas)
holdSecondsInput.addEventListener('change', () => {
  const seconds = targetHoldSeconds()
  holdSecondsInput.value = String(seconds)
  rearmTarget()
  if (targetMidi != null) targetStatusEl.textContent = targetPrompt(targetMidi)
})

window.addEventListener('blur', () => {
  const now = performance.now() / 1000
  for (const midi of playedNoteOrder) trail.endPlayedNote(midi, now)
  heldComputerKeys.clear()
  heldPointerNotes.clear()
  playedNoteOrder.length = 0
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

new ResizeObserver(() => {
  harmonics.resize()
}).observe(harmonicCanvas)

// Backing store scale depends on devicePixelRatio, which the observer does not track.
window.addEventListener('resize', () => {
  trail.resize()
  harmonics.resize()
})

async function boot(): Promise<void> {
  animate()
  void refreshInputSources()
  navigator.mediaDevices?.addEventListener('devicechange', () => {
    if (!listening) void refreshInputSources()
  })
  try {
    setListenLabel('Loading F0 model…')
    await onnx.initialize()
    setListenLabel('start listening')
    listenBtn.disabled = false
    karaokeFileEl.disabled = false
  } catch (err) {
    console.error(err)
    setListenLabel(
      err instanceof Error ? err.message : 'Failed to load pitch model',
      'error',
    )
  }
}

void boot()
