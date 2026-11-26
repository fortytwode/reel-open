// The floating camera bubble + recording controls, in a Document Picture-in-Picture window
// (always on top of other apps, like the Mac app's BubbleWindow + ControlBarWindow). When the
// whole screen is recorded, this window is captured where the user put it, so the bubble shows
// up in the video at its on-screen position (as on the Mac). For window/tab recordings the
// encoder composites the camera in the corner instead.

export function pipSupported() { return "documentPictureInPicture" in window; }

const CSS = `
  html, body { margin: 0; height: 100%; background: #111; overflow: hidden; font: 13px system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; }
  .wrap { position: relative; width: 100%; height: 100%; display: grid; place-items: center; }
  video, canvas.cam { width: min(100vw, 100vh); height: min(100vw, 100vh); border-radius: 50%; object-fit: cover; transform: scaleX(-1); background: #222; }
  .nocam { width: min(100vw, 100vh); height: min(100vw, 100vh); border-radius: 50%; background: #1b1b1f; display: grid; place-items: center; color: #aaa; }
  .bar { position: absolute; left: 0; right: 0; bottom: 0; display: flex; gap: 6px; justify-content: center; align-items: center;
         padding: 8px; flex-wrap: wrap; background: linear-gradient(transparent, rgba(0,0,0,.75)); opacity: 0; transition: opacity .15s; }
  body:hover .bar, body.always .bar, body.countdown .bar, body.paused .bar, .bar:focus-within { opacity: 1; }
  .bar button { border: 0; border-radius: 999px; padding: 6px 10px; font: inherit; font-weight: 600; cursor: pointer; background: #fff; color: #111; }
  .bar button.stop { background: #e5484d; color: #fff; }
  .bar .time { font-variant-numeric: tabular-nums; padding: 0 4px; text-shadow: 0 1px 2px #000; }
  .count { position: absolute; inset: 0; display: none; place-items: center; font-size: 30vmin; font-weight: 800; text-shadow: 0 2px 12px #000; }
  body.countdown .count { display: grid; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #e5484d; display: inline-block; }
  body.paused .dot { background: #f5a524; }
`;

/**
 * Opens the bubble. `stream` is the (processed) camera stream or null (controls only).
 * Returns a controller, or null if PiP is unavailable.
 */
export async function openBubble({ stream, size = 220, handlers }) {
  if (!pipSupported()) return null;
  const win = await window.documentPictureInPicture.requestWindow({ width: size, height: size, disallowReturnToOpener: true });
  const doc = win.document;
  const style = doc.createElement("style"); style.textContent = CSS; doc.head.appendChild(style);
  doc.title = "Reel";
  const wrap = doc.createElement("div"); wrap.className = "wrap";
  let media;
  if (stream) {
    media = doc.createElement("video");
    media.muted = true; media.autoplay = true; media.playsInline = true; media.srcObject = stream;
  } else {
    media = doc.createElement("div"); media.className = "nocam"; media.textContent = "Reel";
  }
  wrap.appendChild(media);
  const count = doc.createElement("div"); count.className = "count"; wrap.appendChild(count);
  const bar = doc.createElement("div"); bar.className = "bar";
  const dot = doc.createElement("span"); dot.className = "dot";
  const time = doc.createElement("span"); time.className = "time"; time.textContent = "0:00";
  const pause = doc.createElement("button"); pause.textContent = "Pause"; pause.title = "Pause / resume";
  const draw = doc.createElement("button"); draw.textContent = "Draw"; draw.title = "Open drawing preview"; draw.hidden = true;
  const stop = doc.createElement("button"); stop.textContent = "Stop"; stop.className = "stop"; stop.title = "Stop and copy the link";
  const cancel = doc.createElement("button"); cancel.textContent = "✕"; cancel.title = "Cancel (discard)";
  bar.append(dot, time, pause, draw, stop, cancel);
  wrap.appendChild(bar);
  doc.body.appendChild(wrap);
  pause.addEventListener("click", () => handlers.onPause && handlers.onPause());
  draw.addEventListener("click", () => handlers.onDraw?.());
  // The click happens in this window, so the clipboard write must use this window's navigator.
  stop.addEventListener("click", () => handlers.onStop && handlers.onStop(win.navigator));
  cancel.addEventListener("click", () => handlers.onCancel && handlers.onCancel());
  doc.addEventListener("keydown", (e) => handlers.onKey && handlers.onKey(e, win.navigator));
  win.addEventListener("pagehide", () => handlers.onClose && handlers.onClose());
  if (stream) media.play().catch(() => {});

  return {
    win,
    setStream(s) { if (media.tagName === "VIDEO") { media.srcObject = s; media.play().catch(() => {}); } },
    countdown(n) { doc.body.classList.toggle("countdown", n > 0); count.textContent = n > 0 ? String(n) : ""; },
    setState({ phase, elapsed, canDraw }) {
      doc.body.classList.toggle("paused", phase === "paused");
      pause.textContent = phase === "paused" ? "Resume" : "Pause";
      draw.hidden = !canDraw;
      const s = Math.floor(elapsed || 0);
      time.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    },
    close() { try { win.close(); } catch {} },
  };
}
