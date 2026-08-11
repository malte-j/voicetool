const FFT_SIZE = 4096
const MIN_FREQUENCY = 80
const MAX_FREQUENCY = 5000
const MIN_DB = -72
const MIN_SAMPLES = 1024
const HARMONIC_MARGIN_DB = 12
/** Ceiling for both the analysis and the trail's vertical scale. */
export const MAX_HARMONICS = 40

export interface HarmonicAnalysis {
  /** Harmonics standing clear of the noise floor, including the fundamental. */
  count: number
  /** How many harmonics of this pitch fit under the analysis ceiling. */
  possible: number
}

/**
 * Counts the harmonics of `fundamentalHz` that rise above the surrounding noise.
 * Descriptive only: vowel, loudness, mic distance and room all move this number,
 * so it is meant for comparing takes of the same note, not for scoring a voice.
 */
export function analyzeHarmonics(
  samples: Float32Array,
  fundamentalHz: number | null,
  sampleRate: number,
): HarmonicAnalysis | null {
  if (
    samples.length < MIN_SAMPLES ||
    fundamentalHz == null ||
    !Number.isFinite(fundamentalHz) ||
    fundamentalHz < MIN_FREQUENCY
  ) {
    return null
  }

  const real = new Float32Array(FFT_SIZE)
  const imag = new Float32Array(FFT_SIZE)
  const used = Math.min(samples.length, FFT_SIZE)
  const offset = samples.length - used

  let mean = 0
  for (let i = 0; i < used; i++) mean += samples[offset + i]
  mean /= used

  for (let i = 0; i < used; i++) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (used - 1))
    real[i] = (samples[offset + i] - mean) * window
  }
  fft(real, imag)

  const maxFrequency = Math.min(MAX_FREQUENCY, sampleRate / 2)
  const firstBin = frequencyToBin(MIN_FREQUENCY, sampleRate)
  const lastBin = frequencyToBin(maxFrequency, sampleRate)
  const db = new Float32Array(FFT_SIZE / 2)
  let maxMagnitude = 1e-12

  for (let bin = firstBin; bin <= lastBin; bin++) {
    db[bin] = Math.hypot(real[bin], imag[bin])
    maxMagnitude = Math.max(maxMagnitude, db[bin])
  }

  const levels: number[] = []
  for (let bin = firstBin; bin <= lastBin; bin++) {
    db[bin] = Math.max(MIN_DB, 20 * Math.log10(db[bin] / maxMagnitude))
    levels.push(db[bin])
  }

  // The median bin approximates the noise between the harmonic lines, so the
  // threshold follows the recording instead of a fixed level.
  levels.sort((a, b) => a - b)
  const noiseFloorDb = levels[Math.floor(levels.length / 2)] ?? MIN_DB
  const thresholdDb = Math.max(-48, noiseFloorDb + HARMONIC_MARGIN_DB)

  const possible = Math.min(MAX_HARMONICS, Math.floor(maxFrequency / fundamentalHz))
  const radius = Math.max(2, frequencyToBin(Math.max(8, fundamentalHz * 0.025), sampleRate))
  let count = 0

  for (let harmonic = 1; harmonic <= possible; harmonic++) {
    const center = frequencyToBin(fundamentalHz * harmonic, sampleRate)
    let peakDb = MIN_DB
    for (
      let bin = Math.max(firstBin, center - radius);
      bin <= Math.min(lastBin, center + radius);
      bin++
    ) {
      if (db[bin] > peakDb) peakDb = db[bin]
    }
    if (peakDb >= thresholdDb) count++
  }

  return { count, possible }
}

function frequencyToBin(frequency: number, sampleRate: number): number {
  return Math.round((frequency / sampleRate) * FFT_SIZE)
}

/** In-place radix-2 Cooley–Tukey FFT. */
function fft(real: Float32Array, imag: Float32Array): void {
  const size = real.length
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i >= j) continue
    ;[real[i], real[j]] = [real[j], real[i]]
    ;[imag[i], imag[j]] = [imag[j], imag[i]]
  }

  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length
    const stepReal = Math.cos(angle)
    const stepImag = Math.sin(angle)
    for (let start = 0; start < size; start += length) {
      let twiddleReal = 1
      let twiddleImag = 0
      for (let offset = 0; offset < length / 2; offset++) {
        const even = start + offset
        const odd = even + length / 2
        const oddReal = real[odd] * twiddleReal - imag[odd] * twiddleImag
        const oddImag = real[odd] * twiddleImag + imag[odd] * twiddleReal
        real[odd] = real[even] - oddReal
        imag[odd] = imag[even] - oddImag
        real[even] += oddReal
        imag[even] += oddImag
        const nextReal = twiddleReal * stepReal - twiddleImag * stepImag
        twiddleImag = twiddleReal * stepImag + twiddleImag * stepReal
        twiddleReal = nextReal
      }
    }
  }
}
