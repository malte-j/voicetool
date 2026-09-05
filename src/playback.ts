/**
 * Plays back a recorded take from a decoded AudioBuffer.
 *
 * MediaRecorder blobs are streamed containers with no duration in their header, so
 * an <audio> element reports `Infinity` and refuses to seek until it has been
 * coaxed through the whole file. Decoding up front gives an exact duration and
 * lets the playhead be moved anywhere without waiting on the media pipeline.
 */
export class RecordingPlayer {
  private context: AudioContext | null = null
  private buffer: AudioBuffer | null = null
  private source: AudioBufferSourceNode | null = null
  private output: GainNode | null = null
  private muted = false
  /** Context clock reading when the current source started. */
  private startedAt = 0
  /** Position in the buffer that the current source started from. */
  private offset = 0
  private playing = false

  onEnded: (() => void) | null = null

  async load(blob: Blob): Promise<number> {
    this.stopSource()
    const context = this.ensureContext()
    return this.loadBuffer(await context.decodeAudioData(await blob.arrayBuffer()))
  }

  loadBuffer(buffer: AudioBuffer): number {
    this.stopSource()
    this.buffer = buffer
    this.offset = 0
    return this.buffer.duration
  }

  play(): void {
    if (!this.buffer || this.playing) return

    const context = this.ensureContext()
    if (context.state === 'suspended') void context.resume()

    // Restarting from the end is a replay, which is what a transport button does.
    if (this.offset >= this.buffer.duration - 0.01) this.offset = 0

    const source = context.createBufferSource()
    source.buffer = this.buffer
    source.connect(this.output!)
    source.addEventListener('ended', () => {
      if (this.source !== source) return
      this.source = null
      this.playing = false
      this.offset = this.buffer?.duration ?? 0
      this.onEnded?.()
    })
    source.start(0, this.offset)

    this.source = source
    this.startedAt = context.currentTime
    this.playing = true
  }

  pause(): void {
    if (!this.playing) return
    this.offset = this.currentTime
    this.stopSource()
  }

  toggle(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  seek(seconds: number): void {
    const clamped = Math.max(0, Math.min(this.duration, seconds))
    if (!this.playing) {
      this.offset = clamped
      return
    }
    // A running source cannot be repositioned, so swap in a new one at the offset.
    this.stopSource()
    this.offset = clamped
    this.play()
  }

  get currentTime(): number {
    if (!this.playing || !this.context) return this.offset
    const elapsed = this.context.currentTime - this.startedAt
    return Math.max(0, Math.min(this.duration, this.offset + elapsed))
  }

  get duration(): number {
    return this.buffer?.duration ?? 0
  }

  get isPlaying(): boolean {
    return this.playing
  }

  get isLoaded(): boolean {
    return this.buffer != null
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.output?.gain.setTargetAtTime(
      muted ? 0 : 1,
      this.context?.currentTime ?? 0,
      0.01,
    )
  }

  unload(): void {
    this.stopSource()
    this.buffer = null
    this.offset = 0
  }

  private stopSource(): void {
    const source = this.source
    this.source = null
    this.playing = false
    if (!source) return
    try {
      source.stop()
    } catch {
      // Already stopped; nothing to unwind.
    }
    source.disconnect()
  }

  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext()
      this.output = this.context.createGain()
      this.output.gain.value = this.muted ? 0 : 1
      this.output.connect(this.context.destination)
    }
    return this.context
  }
}
