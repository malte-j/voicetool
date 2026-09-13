import { Mp3Encoder } from '@breezystack/lamejs'

const MP3_BITRATE_KBPS = 128
const MP3_BLOCK_SIZE = 1152
const BLOCKS_BEFORE_YIELD = 64

function toPcm16(samples: Float32Array, offset: number, length: number): Int16Array {
  const pcm = new Int16Array(length)
  for (let i = 0; i < length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[offset + i]))
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return pcm
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return copy.buffer
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

/** Encodes the first one or two channels of a decoded recording as a real MP3. */
export async function encodeMp3(buffer: AudioBuffer): Promise<Blob> {
  const channels = Math.min(buffer.numberOfChannels, 2)
  if (channels === 0) throw new Error('The recording has no audio channels')

  const left = buffer.getChannelData(0)
  const right = channels === 2 ? buffer.getChannelData(1) : undefined
  const encoder = new Mp3Encoder(channels, buffer.sampleRate, MP3_BITRATE_KBPS)
  const chunks: ArrayBuffer[] = []

  for (let offset = 0, block = 0; offset < buffer.length; offset += MP3_BLOCK_SIZE, block++) {
    const length = Math.min(MP3_BLOCK_SIZE, buffer.length - offset)
    const leftPcm = toPcm16(left, offset, length)
    const encoded = right
      ? encoder.encodeBuffer(leftPcm, toPcm16(right, offset, length))
      : encoder.encodeBuffer(leftPcm)
    if (encoded.length > 0) chunks.push(copyBuffer(encoded))

    // Long takes should not make the page completely unresponsive while encoding.
    if (block > 0 && block % BLOCKS_BEFORE_YIELD === 0) await yieldToBrowser()
  }

  const finalChunk = encoder.flush()
  if (finalChunk.length > 0) chunks.push(copyBuffer(finalChunk))
  return new Blob(chunks, { type: 'audio/mpeg' })
}
