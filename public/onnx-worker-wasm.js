/* global ort */
importScripts('ort.wasm.min.js')

let ortSession = null

self.onmessage = async ({ data }) => {
  const { type, modelPath, feeds } = data

  try {
    if (type === 'loadModel') {
      ort.env.wasm.numThreads = 1
      ort.env.wasm.simd = true
      ort.env.wasm.wasmPaths = self.location.origin + '/'
      ortSession = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['wasm'],
      })
      self.postMessage({ type: 'loadModel', status: 'success' })
    } else if (type === 'run' && ortSession) {
      const audio = Float32Array.from(feeds.input_audio)
      const results = await ortSession.run({
        input_audio: new ort.Tensor('float32', audio, [1, audio.length]),
      })

      self.postMessage(
        {
          type: 'run',
          status: 'success',
          result: {
            pitch_hz: results.pitch_hz.data,
            confidence: results.confidence.data,
          },
        },
        [results.pitch_hz.data.buffer, results.confidence.data.buffer],
      )
    }
  } catch (err) {
    self.postMessage({
      type,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
