// Camera background effects (blur / virtual background), the browser counterpart of the Mac
// app's CameraEffects (Vision person segmentation). MediaPipe's selfie segmenter (vendored,
// runs locally in WebAssembly/WebGL) gives a per-pixel person mask; the person is drawn sharp
// over a blurred camera frame or over the background image. Frames are read with
// MediaStreamTrackProcessor and written with MediaStreamTrackGenerator, so processing keeps
// running when the tab is in the background.

const VENDOR = new URL("../vendor/mediapipe/", import.meta.url).href;
let segmenterPromise = null;

async function segmenter() {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const { FilesetResolver, ImageSegmenter } = await import(VENDOR + "vision_bundle.mjs");
      const fileset = await FilesetResolver.forVisionTasks(VENDOR + "wasm");
      const make = (delegate) => ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: VENDOR + "selfie_segmenter.tflite", delegate },
        runningMode: "VIDEO", outputCategoryMask: false, outputConfidenceMasks: true,
      });
      try { return await make("GPU"); } catch { return await make("CPU"); }
    })();
    segmenterPromise.catch(() => { segmenterPromise = null; });
  }
  return segmenterPromise;
}

export function effectsSupported() {
  return typeof MediaStreamTrackProcessor === "function" && typeof MediaStreamTrackGenerator === "function" && typeof OffscreenCanvas === "function";
}

/** Reel's built-in virtual background (used when no image is chosen). */
function gradient(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "#1d2b64"); g.addColorStop(0.55, "#4b3f8f"); g.addColorStop(1, "#f8836a");
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}

/**
 * Wraps a camera track. Returns {track, setMode(mode, image), stop()}; mode "none" passes frames
 * through unchanged. `image` is an ImageBitmap for the virtual background (optional); `size` is the
 * processing/output size.
 */
export async function createCameraEffect(cameraTrack, mode, image = null, size = { width: 640, height: 360 }) {
  const seg = await segmenter();
  const processor = new MediaStreamTrackProcessor({ track: cameraTrack });
  const generator = new MediaStreamTrackGenerator({ kind: "video" });
  const reader = processor.readable.getReader();
  const writer = generator.writable.getWriter();
  const W = size.width, H = size.height;      // 640x360 is plenty for the bubble; camera-only uses the camera size
  const frameC = new OffscreenCanvas(W, H), fctx = frameC.getContext("2d", { willReadFrequently: false });
  const maskC = new OffscreenCanvas(W, H), mctx = maskC.getContext("2d");
  const outC = new OffscreenCanvas(W, H), octx = outC.getContext("2d");
  const maskImage = new ImageData(W, H);
  let current = mode, bg = image, stopped = false, lastTs = -1;

  (async () => {
    while (!stopped) {
      let r;
      try { r = await reader.read(); } catch { break; }
      if (r.done) break;
      const frame = r.value;
      try {
        if (current === "none") { await writer.write(frame.clone()); continue; }
        // Cover-crop to the processing size.
        const sw = frame.displayWidth, sh = frame.displayHeight, s = Math.max(W / sw, H / sh);
        const cw = W / s, ch = H / s;
        fctx.drawImage(frame, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, W, H);
        let ts = Math.round(frame.timestamp / 1000);
        if (ts <= lastTs) ts = lastTs + 1;
        lastTs = ts;
        const result = seg.segmentForVideo(frameC, ts);
        const conf = result.confidenceMasks && result.confidenceMasks[0];
        if (conf) {
          const a = conf.getAsFloat32Array(), px = maskImage.data;
          for (let i = 0, j = 3; i < a.length; i++, j += 4) px[j] = a[i] * 255;
          mctx.putImageData(maskImage, 0, 0);
        }
        result.close && result.close();
        // Background.
        octx.save();
        octx.globalCompositeOperation = "source-over";
        if (current === "blur") { octx.filter = "blur(14px)"; octx.drawImage(frameC, -20, -20, W + 40, H + 40); octx.filter = "none"; }
        else if (bg) { const k = Math.max(W / bg.width, H / bg.height); octx.drawImage(bg, (W - bg.width * k) / 2, (H - bg.height * k) / 2, bg.width * k, bg.height * k); }
        else gradient(octx, W, H);
        octx.restore();
        // Person: frame masked by the confidence mask, on top.
        mctx.save();
        mctx.globalCompositeOperation = "source-in";
        mctx.drawImage(frameC, 0, 0);
        mctx.restore();
        octx.drawImage(maskC, 0, 0);
        const out = new VideoFrame(outC, { timestamp: frame.timestamp });
        await writer.write(out);
      } catch (e) {
        // Keep the camera alive even if one frame fails.
        try { await writer.write(frame.clone()); } catch {}
      } finally { frame.close(); }
    }
  })();

  return {
    track: generator,
    setMode(m, img) { current = m; if (img !== undefined) bg = img; },
    stop() { stopped = true; reader.cancel().catch(() => {}); try { generator.stop(); } catch {} },
  };
}

/** Warm up the model (download + compile) before recording starts. */
export function preloadEffects() { return segmenter().then(() => true, () => false); }
