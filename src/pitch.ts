export const NOTE_NAMES = [
  'C',
  'C♯',
  'D',
  'D♯',
  'E',
  'F',
  'F♯',
  'G',
  'G♯',
  'A',
  'A♯',
  'B',
] as const

export const MODEL_FMIN = 46.875
export const MODEL_FMAX = 2093.75
export const TARGET_SAMPLE_RATE = 16000

export interface DetectedNote {
  hz: number
  midi: number
  name: string
  octave: number
  cents: number
  confidence: number
}

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(Math.max(hz, 1e-6) / 440)
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12)
}

export function midiToNoteName(midi: number): { name: string; octave: number } {
  const rounded = Math.round(midi)
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12]
  const octave = Math.floor(rounded / 12) - 1
  return { name, octave }
}

/** Signed distance from the nearest semitone, in cents. */
export function midiToCents(midi: number): number {
  return (midi - Math.round(midi)) * 100
}

export function analyzePitch(hz: number, confidence: number): DetectedNote {
  const midi = hzToMidi(hz)
  const { name, octave } = midiToNoteName(midi)
  const cents = midiToCents(midi)
  return { hz, midi, name, octave, cents, confidence }
}

export function formatNote(note: DetectedNote): string {
  return `${note.name}${note.octave}`
}
