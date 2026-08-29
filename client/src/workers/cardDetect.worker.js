/**
 * Card detection, off the main thread.
 *
 * Detection is the one expensive thing the preview loop does: a colour convert,
 * a blur, two threshold passes and a contour trace, ten times a second. Run on
 * the main thread it competes with the very thing it exists to serve — the
 * video, the overlay, and the metrics that decide when to fire the shutter —
 * and a long tick reads downstream as the card moving, because stillness is
 * measured as the difference between one frame and the last.
 *
 * So the frame comes here instead. The main thread posts a downscaled copy and
 * carries on drawing; the answer arrives a tick later and updates the overlay.
 *
 * One request at a time, deliberately. A queue here would make latency grow
 * without bound the moment detection ran slower than the frame rate, and the
 * newest frame is always the one worth answering — see cardDetector.js, which
 * drops rather than queues.
 */
import { detectCardContour, isReady, load } from '../utils/cardContour.js';

self.onmessage = async (event) => {
  const message = event.data || {};

  if (message.type === 'load') {
    // Progress is forwarded as it arrives rather than resolved at the end: the
    // point of it is the 13MB wait, which is precisely when nothing has
    // resolved yet.
    const cv = await load({
      onProgress: (progress) => self.postMessage({ type: 'progress', progress }),
    });
    self.postMessage({ type: cv ? 'ready' : 'failed' });
    return;
  }

  if (message.type === 'detect') {
    // The frame arrives as a plain object rather than an ImageData: structured
    // clone carries ImageData fine, but the buffer is transferred from a canvas
    // read on the other side and this keeps both ends indifferent to which.
    const result = isReady()
      ? detectCardContour(message.frame, { hint: message.hint || null })
      : null;

    self.postMessage({ type: 'detected', id: message.id, result });
  }
};
