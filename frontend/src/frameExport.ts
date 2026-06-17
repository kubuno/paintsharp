// Generic frame-by-frame video exporter (WebCodecs H.264 → MP4, video only).
// Deterministic and faster-than-real-time: the caller renders each frame onto a
// canvas and we encode it. Shared so any frame-rendering editor (Keyframe…) can
// export a real video without a server. Requires a secure context (localhost ok).
import { Muxer, ArrayBufferTarget } from 'mp4-muxer'

export const webCodecsAvailable = (): boolean =>
  typeof window !== 'undefined' && typeof (window as unknown as { VideoEncoder?: unknown }).VideoEncoder !== 'undefined'

export async function exportFramesToMp4(opts: {
  width: number
  height: number
  fps: number
  frameCount: number
  // Draw frame `f` and return the canvas holding it (same canvas may be reused).
  getFrame: (f: number) => HTMLCanvasElement
  onProgress?: (p: number) => void
}): Promise<Blob> {
  const fps = opts.fps
  const width = opts.width - (opts.width % 2)   // H.264 needs even dimensions
  const height = opts.height - (opts.height % 2)
  const total = Math.max(1, opts.frameCount)

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: fps },
    fastStart: 'in-memory',
  })
  const VEnc = (window as unknown as { VideoEncoder: typeof VideoEncoder }).VideoEncoder
  const enc = new VEnc({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta as Parameters<typeof muxer.addVideoChunk>[1]),
    error: (e: DOMException) => { throw e },
  })
  enc.configure({ codec: 'avc1.4D401F', width, height, bitrate: 12_000_000, framerate: fps })

  for (let f = 0; f < total; f++) {
    const canvas = opts.getFrame(f)
    const vf = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) })
    enc.encode(vf, { keyFrame: f % (fps * 2) === 0 })
    vf.close()
    if (enc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 0))
    opts.onProgress?.((f + 1) / total)
  }
  await enc.flush(); enc.close()
  muxer.finalize()
  return new Blob([(muxer.target as ArrayBufferTarget).buffer], { type: 'video/mp4' })
}

// Real-time fallback (no WebCodecs): record a canvas stream. The caller drives the
// canvas; we just capture for `durationMs`. Returns a webm blob.
export async function recordCanvasWebm(canvas: HTMLCanvasElement, fps: number, durationMs: number, tick: (t: number) => void): Promise<Blob> {
  const stream = canvas.captureStream(fps)
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m)) ?? 'video/webm'
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 })
  const chunks: BlobPart[] = []
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
  const stopped = new Promise<Blob>(res => { rec.onstop = () => res(new Blob(chunks, { type: mime })) })
  rec.start(100)
  const t0 = performance.now()
  await new Promise<void>(resolve => {
    const loop = (ts: number) => { tick(ts - t0); if (ts - t0 >= durationMs) resolve(); else requestAnimationFrame(loop) }
    requestAnimationFrame(loop)
  })
  await new Promise(r => setTimeout(r, 200))
  rec.stop()
  return stopped
}
