import { TARGET_SAMPLE_RATE } from './pitch'

export type AudioChunkHandler = (samples16k: Float32Array) => void

/**
 * Captures microphone audio and resamples to 16 kHz mono PCM
 * suitable for SwiftF0.
 */
export class AudioCapture {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private silentGain: GainNode | null = null
  private running = false
  private carry = new Float32Array(0)

  async start(onChunk: AudioChunkHandler): Promise<void> {
    if (this.running) return

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    })

    this.context = new AudioContext()
    // Some browsers start suspended until a gesture — ensure running.
    if (this.context.state === 'suspended') {
      await this.context.resume()
    }

    this.source = this.context.createMediaStreamSource(this.stream)
    // ScriptProcessor is deprecated but widely supported and sufficient here.
    this.processor = this.context.createScriptProcessor(4096, 1, 1)
    this.silentGain = this.context.createGain()
    this.silentGain.gain.value = 0

    this.processor.onaudioprocess = (event) => {
      if (!this.running || !this.context) return
      const input = event.inputBuffer.getChannelData(0)
      const resampled = this.resample(input, this.context.sampleRate, TARGET_SAMPLE_RATE)
      if (resampled.length > 0) onChunk(resampled)
    }

    this.source.connect(this.processor)
    this.processor.connect(this.silentGain)
    this.silentGain.connect(this.context.destination)
    this.running = true
  }

  async stop(): Promise<void> {
    this.running = false
    this.processor?.disconnect()
    this.source?.disconnect()
    this.silentGain?.disconnect()
    this.processor = null
    this.source = null
    this.silentGain = null
    this.carry = new Float32Array(0)

    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null

    if (this.context) {
      await this.context.close()
      this.context = null
    }
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Linear resample with fractional-index carry across chunks. */
  private resample(
    input: Float32Array,
    fromRate: number,
    toRate: number,
  ): Float32Array {
    if (fromRate === toRate) return input.slice()

    const combined = new Float32Array(this.carry.length + input.length)
    combined.set(this.carry)
    combined.set(input, this.carry.length)

    const ratio = fromRate / toRate
    const outLength = Math.floor((combined.length - 1) / ratio)
    if (outLength <= 0) {
      this.carry = combined
      return new Float32Array(0)
    }

    const output = new Float32Array(outLength)
    for (let i = 0; i < outLength; i++) {
      const srcIndex = i * ratio
      const i0 = Math.floor(srcIndex)
      const i1 = Math.min(i0 + 1, combined.length - 1)
      const t = srcIndex - i0
      output[i] = combined[i0] * (1 - t) + combined[i1] * t
    }

    const consumed = outLength * ratio
    const remainStart = Math.floor(consumed)
    this.carry = combined.slice(remainStart)
    return output
  }
}

/** Ring buffer of 16 kHz samples for sliding-window inference. */
export class SampleRingBuffer {
  private buffer: Float32Array
  private writePos = 0
  private filled = 0
  private capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
    this.buffer = new Float32Array(capacity)
  }

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.writePos] = samples[i]
      this.writePos = (this.writePos + 1) % this.capacity
      if (this.filled < this.capacity) this.filled++
    }
  }

  get length(): number {
    return this.filled
  }

  /** Newest `count` samples in chronological order. */
  latest(count: number): Float32Array {
    const n = Math.min(count, this.filled)
    const out = new Float32Array(n)
    let start = (this.writePos - n + this.capacity) % this.capacity
    for (let i = 0; i < n; i++) {
      out[i] = this.buffer[start]
      start = (start + 1) % this.capacity
    }
    return out
  }

  clear(): void {
    this.buffer.fill(0)
    this.writePos = 0
    this.filled = 0
  }

  /** Peak absolute amplitude of the latest window (for level meter). */
  peak(count: number): number {
    const samples = this.latest(count)
    let max = 0
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i])
      if (a > max) max = a
    }
    return max
  }
}
