import { midiToHz } from './pitch'

interface Voice {
  oscillator: OscillatorNode
  gain: GainNode
}

export class Synth {
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private successBufferPromise: Promise<AudioBuffer> | null = null
  private voices = new Map<number, Voice>()

  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext()
      this.master = this.context.createGain()
      this.master.gain.value = 0.22
      this.master.connect(this.context.destination)
      this.successBufferPromise = fetch('/success.mp3')
        .then((response) => {
          if (!response.ok) throw new Error(`Could not load success sound (${response.status})`)
          return response.arrayBuffer()
        })
        .then((data) => this.context!.decodeAudioData(data))
    }
    if (this.context.state === 'suspended') void this.context.resume()
    return this.context
  }

  noteOn(midi: number): void {
    if (this.voices.has(midi)) return

    const context = this.ensureContext()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const now = context.currentTime

    oscillator.type = 'triangle'
    oscillator.frequency.value = midiToHz(midi)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.7, now + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.48, now + 0.09)

    oscillator.connect(gain)
    gain.connect(this.master!)
    oscillator.start()
    this.voices.set(midi, { oscillator, gain })
  }

  noteOff(midi: number): void {
    const voice = this.voices.get(midi)
    if (!voice || !this.context) return

    const now = this.context.currentTime
    voice.gain.gain.cancelScheduledValues(now)
    voice.gain.gain.setValueAtTime(Math.max(voice.gain.gain.value, 0.0001), now)
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12)
    voice.oscillator.stop(now + 0.14)
    this.voices.delete(midi)
  }

  async playSuccessSound(): Promise<number> {
    const context = this.ensureContext()
    try {
      const buffer = await this.successBufferPromise
      if (!buffer) throw new Error('Success sound is unavailable')
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      source.start()
      return buffer.duration
    } catch (error) {
      console.error(error)
      return 0
    }
  }

  allNotesOff(): void {
    for (const midi of [...this.voices.keys()]) this.noteOff(midi)
  }
}
