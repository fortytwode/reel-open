import { drawAnnotations, drawSharedFrame } from "./core.js?v=20261126-drawing";

export function createAnnotationPanel(dialog, onChange) {
  const video = dialog.querySelector("video");
  const canvas = dialog.querySelector("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  const tool = dialog.querySelector("#draw-tool");
  const color = dialog.querySelector("#draw-color");
  const undo = dialog.querySelector("#draw-undo");
  const clear = dialog.querySelector("#draw-clear");
  let strokes = [], pending = null, activePointer, frame = 0, iteration = 0, snapshot, region;

  function draw() {
    const { width, height } = canvas;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
    if (snapshot) ctx.drawImage(snapshot, 0, 0);
    else if (video.readyState >= 2) drawSharedFrame(ctx, video, width, height, region);
    drawAnnotations(ctx, strokes, width, height);
    if (pending) drawAnnotations(ctx, [pending], width, height);
  }

  function close() {
    iteration++;
    if (dialog.open) dialog.close();
    cancelAnimationFrame(frame);
    frame = 0;
    snapshot = null;
    pending = activePointer = null;
    video.srcObject = null;
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
  }

  function publish() {
    clear.disabled = undo.disabled = !strokes.length;
    onChange(strokes);
    if (dialog.open) draw();
  }

  function point(event) {
    const bounds = canvas.getBoundingClientRect();
    const normalize = (value) => Math.max(0, Math.min(1, value));
    return { x: normalize((event.clientX - bounds.left) / bounds.width), y: normalize((event.clientY - bounds.top) / bounds.height) };
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (activePointer != null || event.button !== 0 || strokes.length >= 64) return;
    canvas.setPointerCapture(event.pointerId);
    activePointer = event.pointerId;
    pending = { tool: tool.value, color: color.value, points: [point(event)] };
    draw();
  });
  function move(event) {
    if (event.pointerId !== activePointer) return;
    const next = point(event), points = pending.points;
    if (pending.tool === "arrow" || pending.tool === "rectangle") points[1] = next;
    else if (Math.hypot(next.x - points.at(-1).x, next.y - points.at(-1).y) > 0.001) {
      if (points.length === 512) points.splice(1, 1);
      points.push(next);
    }
    draw();
  }
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", (event) => {
    if (event.pointerId !== activePointer) return;
    move(event);
    strokes.push(pending);
    pending = activePointer = null;
    publish();
  });
  canvas.addEventListener("lostpointercapture", () => { pending = activePointer = null; if (dialog.open) draw(); });
  undo.addEventListener("click", () => { strokes.pop(); publish(); });
  clear.addEventListener("click", () => { strokes = []; publish(); });
  dialog.querySelector("#draw-close").addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });

  return {
    supported: !!ctx && typeof PointerEvent !== "undefined" && typeof dialog.showModal === "function",
    get isOpen() { return dialog.open; },
    get strokes() { return strokes; },
    close,
    reset() { close(); strokes = []; publish(); },
    async open(track, crop, size, isPaused) {
      const opening = ++iteration;
      const live = track.getSettings().displaySurface === "browser";
      region = crop;
      const scale = Math.min(1, 720 / Math.max(size.width, size.height));
      canvas.width = Math.max(1, Math.round(size.width * scale));
      canvas.height = Math.max(1, Math.round(size.height * scale));
      canvas.style.setProperty("--draw-aspect", String(canvas.width / canvas.height));
      video.srcObject = new MediaStream([track]);
      let timeout, opened = false;
      try {
        await Promise.race([video.play(), new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Preview timed out")), 2200);
        })]);
        if (opening !== iteration || !isPaused()) return false;
        // A window or monitor may contain the Recorder itself. Freeze its preview before showing the dialog.
        if (!live) {
          snapshot = document.createElement("canvas");
          snapshot.width = canvas.width; snapshot.height = canvas.height;
          drawSharedFrame(snapshot.getContext("2d", { alpha: false }), video, canvas.width, canvas.height, region);
          video.srcObject = null;
        }
        dialog.showModal();
        draw();
        if (live) {
          const render = () => { draw(); frame = requestAnimationFrame(render); };
          frame = requestAnimationFrame(render);
        }
        opened = true;
        return opened;
      } finally {
        clearTimeout(timeout);
        if (opening === iteration && !opened) close();
      }
    },
  };
}
