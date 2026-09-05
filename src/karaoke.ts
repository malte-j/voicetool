import { MODEL_FMAX, MODEL_FMIN, TARGET_SAMPLE_RATE, hzToMidi } from './pitch'
import type { InferenceResult } from './onnxService'
import type { RecordedTrail, TrailPoint } from './trail'

const ANALYSIS_CHUNK_SECONDS = 20
const CONFIDENCE_THRESHOLD = 0.85
const TARGET_COLOR = '#1976b9'

export interface DecodedSong {
  buffer: AudioBuffer
  samples16k: Float32Array
}

/** Decode an uploaded song once, retaining full-quality audio for playback. */
export async function decodeSong(file: Blob): Promise<DecodedSong> {
  const context = new AudioContext()
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer())
    const mono = mixToMono(buffer)
    return {
      buffer,
      samples16k: resample(mono, buffer.sampleRate, TARGET_SAMPLE_RATE),
    }
  } finally {
    await context.close()
  }
}

/**
 * Analyze a song in bounded chunks. Keeping inference requests small avoids the
 * very large JS arrays and WASM allocations caused by sending a whole MP3 at once.
 */
export async function analyzeSong(
  samples: Float32Array,
  duration: number,
  infer: (audio: Float32Array) => Promise<InferenceResult>,
  onProgress: (ratio: number) => void,
): Promise<RecordedTrail> {
  const chunkSamples = TARGET_SAMPLE_RATE * ANALYSIS_CHUNK_SECONDS
  const points: TrailPoint[] = []

  for (let start = 0; start < samples.length; start += chunkSamples) {
    const end = Math.min(samples.length, start + chunkSamples)
    const chunk = normalize(samples.subarray(start, end))
    const result = await infer(chunk)
    const timeOffset = start / TARGET_SAMPLE_RATE

    for (let i = 0; i < result.pitch_hz.length; i++) {
      const hz = result.pitch_hz[i]
      const voiced =
        result.confidence[i] >= CONFIDENCE_THRESHOLD &&
        hz >= MODEL_FMIN &&
        hz <= MODEL_FMAX
      points.push({
        t: Math.min(duration, timeOffset + result.timestamps[i]),
        midi: voiced ? hzToMidi(hz) : Number.NaN,
        voiced,
        color: voiced ? TARGET_COLOR : '',
      })
    }

    onProgress(end / samples.length)
    // Yield between chunks so progress and controls repaint during long songs.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  }

  return { points, playedNotes: [], duration }
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const mono = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const source = buffer.getChannelData(channel)
    for (let i = 0; i < source.length; i++) mono[i] += source[i]
  }
  const scale = 1 / Math.max(1, buffer.numberOfChannels)
  if (scale !== 1) {
    for (let i = 0; i < mono.length; i++) mono[i] *= scale
  }
  return mono
}

function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input
  const length = Math.max(1, Math.floor(input.length * toRate / fromRate))
  const output = new Float32Array(length)
  const ratio = fromRate / toRate
  for (let i = 0; i < length; i++) {
    const position = i * ratio
    const before = Math.floor(position)
    const after = Math.min(before + 1, input.length - 1)
    const mix = position - before
    output[i] = input[before] * (1 - mix) + input[after] * mix
  }
  return output
}

function normalize(input: Float32Array): Float32Array {
  let peak = 0
  for (let i = 0; i < input.length; i++) peak = Math.max(peak, Math.abs(input[i]))
  if (peak < 1e-6 || peak >= 0.98) return input.slice()
  const output = new Float32Array(input.length)
  const gain = 1 / peak
  for (let i = 0; i < input.length; i++) output[i] = input[i] * gain
  return output
}
