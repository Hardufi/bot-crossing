// Turns a video (or a few photos) into a handful of evenly spaced, downscaled JPEG frames.
// Everything happens in the browser: the video itself never leaves the device.

const MAX_SIDE = 1024
const QUALITY = 0.8
const HAVE_CURRENT_DATA = 2

function once(target, ok, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(reject, new Error('timeout')), timeoutMs)
    const onOk = () => done(resolve)
    const onError = () => done(reject, target.error ?? new Error('media error'))
    function done(fn, value) {
      clearTimeout(timer)
      target.removeEventListener(ok, onOk)
      target.removeEventListener('error', onError)
      fn(value)
    }
    target.addEventListener(ok, onOk)
    target.addEventListener('error', onError)
  })
}

function toJpeg(source, width, height) {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', QUALITY))
}

// Moves to a time and waits until that frame can be drawn. Seeking is also what makes Safari
// on iPhone load the video at all: it loads nothing more than the metadata on its own.
async function frameAt(video, time) {
  const seeked = once(video, 'seeked')
  video.currentTime = time
  await seeked
  if (video.readyState >= HAVE_CURRENT_DATA) return
  const loaded = once(video, 'loadeddata')
  // A muted play is the other thing that makes a phone start decoding.
  try {
    await video.play()
    video.pause()
  } catch {}
  if (video.readyState < HAVE_CURRENT_DATA) await loaded
}

// Recordings made in some browsers report an infinite duration until the end has been seen.
async function knownDuration(video) {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration
  const seeked = once(video, 'seeked')
  video.currentTime = 1e7
  await seeked.catch(() => {})
  const d = video.duration
  return Number.isFinite(d) && d > 0 ? d : 0
}

export async function framesFromVideo(file, { count, onFrame, signal } = {}) {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = url
  try {
    await once(video, 'loadedmetadata')
    const duration = await knownDuration(video)
    const n = duration ? count : 1
    const frames = []
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) throw { code: 'cancelled' }
      await frameAt(video, duration ? Math.min(duration - 0.05, (duration * (i + 0.5)) / n) : 0)
      if (signal?.aborted) throw { code: 'cancelled' }
      const frame = await toJpeg(video, video.videoWidth, video.videoHeight)
      frames.push(frame)
      onFrame?.(frame, i)
    }
    return frames
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

// Photos that cannot be decoded here (some HEIF files, for one) are skipped, not fatal.
export async function framesFromImages(files, { count, onFrame, signal } = {}) {
  const frames = []
  let skipped = 0
  for (const file of files) {
    if (frames.length >= count) break
    if (signal?.aborted) throw { code: 'cancelled' }
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      const frame = await toJpeg(bitmap, bitmap.width, bitmap.height)
      bitmap.close?.()
      frames.push(frame)
      onFrame?.(frame, frames.length - 1)
    } catch {
      skipped++
    }
  }
  if (!frames.length) throw new Error('no photo could be read')
  return Object.assign(frames, { skipped })
}
