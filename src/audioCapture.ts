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
  private inputGain: GainNode | null = null
  private processor: ScriptProcessorNode | null = null
  private silentGain: GainNode | null = null
  private monitorGain: GainNode | null = null
  private recordingDestination: MediaStreamAudioDestinationNode | null = null
  private recorder: MediaRecorder | null = null
  private recordedChunks: Blob[] = []
  private monitoring = false
  private inputGainDb = 0
  private running = false
  private carry = new Float32Array(0)

  async start(onChunk: AudioChunkHandler, deviceId?: string): Promise<void> {
    if (this.running) return

    const audioConstraints: MediaTrackConstraints & {
      latency?: { ideal: number }
    } = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
      latency: { ideal: 0 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false,
    })

    this.context = new AudioContext({ latencyHint: 'interactive' })
    // Some browsers start suspended until a gesture — ensure running.
    if (this.context.state === 'suspended') {
      await this.context.resume()
    }

    this.source = this.context.createMediaStreamSource(this.stream)
    this.inputGain = this.context.createGain()
    this.inputGain.gain.value = 10 ** (this.inputGainDb / 20)
    // ScriptProcessor is deprecated but widely supported and sufficient here.
    this.processor = this.context.createScriptProcessor(1024, 1, 1)
    this.silentGain = this.context.createGain()
    this.silentGain.gain.value = 0
    this.monitorGain = this.context.createGain()
    this.monitorGain.gain.value = this.monitoring ? 1 : 0
    this.recordingDestination = this.context.createMediaStreamDestination()

    this.processor.onaudioprocess = (event) => {
      if (!this.running || !this.context) return
      const input = event.inputBuffer.getChannelData(0)
      const resampled = this.resample(input, this.context.sampleRate, TARGET_SAMPLE_RATE)
      if (resampled.length > 0) onChunk(resampled)
    }

    this.source.connect(this.inputGain)
    this.inputGain.connect(this.processor)
    this.inputGain.connect(this.monitorGain)
    this.inputGain.connect(this.recordingDestination)
    this.processor.connect(this.silentGain)
    this.silentGain.connect(this.context.destination)
    this.monitorGain.connect(this.context.destination)
    this.running = true
  }

  setMonitoring(enabled: boolean): void {
    this.monitoring = enabled
    this.monitorGain?.gain.setValueAtTime(
      enabled ? 1 : 0,
      this.context?.currentTime ?? 0,
    )
  }

  setInputGain(decibels: number): void {
    this.inputGainDb = Math.max(0, Math.min(24, decibels))
    const gain = 10 ** (this.inputGainDb / 20)
    this.inputGain?.gain.setTargetAtTime(
      gain,
      this.context?.currentTime ?? 0,
      0.01,
    )
  }

  startRecording(): void {
    if (!this.recordingDestination) throw new Error('Start listening before recording')
    if (this.recorder?.state === 'recording') return

    const mimeType = [
      'audio/webm;codecs=opus',
      'audio/mp4',
      'audio/webm',
    ].find((type) => MediaRecorder.isTypeSupported(type))
    this.recordedChunks = []
    this.recorder = new MediaRecorder(
      this.recordingDestination.stream,
      mimeType ? { mimeType } : undefined,
    )
    this.recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) this.recordedChunks.push(event.data)
    })
    this.recorder.start()
  }

  stopRecording(): Promise<Blob> {
    const recorder = this.recorder
    if (!recorder || recorder.state === 'inactive') {
      return Promise.resolve(new Blob())
    }

    return new Promise((resolve) => {
      recorder.addEventListener('stop', () => {
        const recording = new Blob(this.recordedChunks, {
          type: recorder.mimeType,
        })
        this.recorder = null
        this.recordedChunks = []
        resolve(recording)
      }, { once: true })
      recorder.stop()
    })
  }

  async stop(): Promise<void> {
    this.running = false
    this.processor?.disconnect()
    this.source?.disconnect()
    this.inputGain?.disconnect()
    this.silentGain?.disconnect()
    this.monitorGain?.disconnect()
    this.recordingDestination?.disconnect()
    this.processor = null
    this.source = null
    this.inputGain = null
    this.silentGain = null
    this.monitorGain = null
    this.recordingDestination = null
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

  get isRecording(): boolean {
    return this.recorder?.state === 'recording'
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
