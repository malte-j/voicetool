export interface InferenceResult {
  pitch_hz: Float32Array
  confidence: Float32Array
  timestamps: Float32Array
}

const HOP_LENGTH = 256
const CENTER_OFFSET = 127.5
const SAMPLE_RATE = 16000

export class ONNXService {
  private worker: Worker | null = null
  private modelLoaded = false
  private busy = false
  private modelFileName: string
  private queue: {
    audio: Float32Array
    resolve: (result: InferenceResult) => void
    reject: (error: Error) => void
  }[] = []

  constructor(modelFileName = 'model.onnx') {
    this.modelFileName = modelFileName
  }

  async initialize(): Promise<void> {
    if (this.worker) return

    this.worker = new Worker('/onnx-worker-wasm.js')
    this.worker.onmessage = this.handleMessage
    const modelPath = `${window.location.origin}/${this.modelFileName}`

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error('Model loading timed out'))
      }, 60_000)

      const onReady = (e: MessageEvent) => {
        if (e.data?.type !== 'loadModel') return
        window.clearTimeout(timeout)
        this.worker?.removeEventListener('message', onReady)
        if (e.data.status === 'success') {
          this.modelLoaded = true
          resolve()
        } else {
          reject(new Error(e.data.error ?? 'Failed to load model'))
        }
      }

      this.worker!.addEventListener('message', onReady)
      this.worker!.postMessage({ type: 'loadModel', modelPath })
    })
  }

  get ready(): boolean {
    return this.modelLoaded
  }

  /** Drop older queued requests; keep at most the latest pending window. */
  async runInference(audio: Float32Array): Promise<InferenceResult> {
    if (!this.worker || !this.modelLoaded) {
      throw new Error('Model is not ready')
    }

    return new Promise((resolve, reject) => {
      // Keep latency low: only the newest window matters while singing.
      if (this.queue.length > 0) {
        const dropped = this.queue.splice(0)
        for (const item of dropped) {
          item.reject(new Error('Superseded'))
        }
      }
      this.queue.push({ audio, resolve, reject })
      this.flush()
    })
  }

  terminate(): void {
    this.worker?.terminate()
    this.worker = null
    this.modelLoaded = false
    this.busy = false
    this.queue = []
  }

  private flush(): void {
    if (this.busy || !this.worker || this.queue.length === 0) return
    this.busy = true
    const { audio } = this.queue[0]
    this.worker.postMessage({
      type: 'run',
      feeds: { input_audio: Array.from(audio) },
    })
  }

  private handleMessage = (e: MessageEvent): void => {
    const { type, status, error, result } = e.data
    if (type !== 'run') return

    const current = this.queue.shift()
    this.busy = false

    if (!current) {
      this.flush()
      return
    }

    if (status === 'success') {
      const nFrames = result.pitch_hz.length
      const timestamps = new Float32Array(nFrames)
      for (let i = 0; i < nFrames; i++) {
        timestamps[i] = (i * HOP_LENGTH + CENTER_OFFSET) / SAMPLE_RATE
      }
      current.resolve({
        pitch_hz: new Float32Array(result.pitch_hz),
        confidence: new Float32Array(result.confidence),
        timestamps,
      })
    } else {
      current.reject(new Error(error ?? 'Inference failed'))
    }

    this.flush()
  }
}
