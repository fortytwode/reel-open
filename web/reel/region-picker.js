import { frameRegion } from "./core.js?v=20261126-capture-region";

/** Select a crop from the browser-approved video track without starting an encoder. */
export function chooseRecordingRegion(dialog, track) {
  if (!track || track.readyState !== "live") return Promise.resolve(null);
  const el = id => dialog.querySelector("#region-" + id);
  const video = el("video"), preview = el("preview"), outline = el("outline");
  const status = el("status"), edges = el("edges"), confirm = el("confirm");
  const names = ["left", "top", "right", "bottom"];
  const inputs = names.map(el);
  let sourceWidth = 0, sourceHeight = 0, selection, drag;
  const listeners = new AbortController(), options = { signal: listeners.signal };

  function updateSelection() {
    const [left, top, right, bottom] = inputs.map(input => input.valueAsNumber);
    const requested = { left, top, right, bottom, sourceWidth, sourceHeight };
    selection = frameRegion(requested, sourceWidth, sourceHeight) ? requested : null;
    confirm.disabled = !selection;
    outline.hidden = !selection;
    if (!selection) {
      status.textContent = sourceWidth ? "Choose an area inside the preview." : "Waiting for the shared picture…";
      return;
    }
    status.textContent = `Selected ${right - left} × ${bottom - top} pixels`;
    Object.assign(outline.style, {
      left: `${left * 100 / sourceWidth}%`, top: `${top * 100 / sourceHeight}%`,
      width: `${(right - left) * 100 / sourceWidth}%`, height: `${(bottom - top) * 100 / sourceHeight}%`,
    });
  }
  function updatePreview() {
    const { videoWidth, videoHeight } = video;
    if (videoWidth < 2 || videoHeight < 2 || (sourceWidth === videoWidth && sourceHeight === videoHeight)) return;
    sourceWidth = videoWidth; sourceHeight = videoHeight; drag = null;
    preview.style.setProperty("--region-aspect", String(sourceWidth / sourceHeight));
    preview.hidden = false; edges.disabled = false;
    for (const [index, input] of inputs.entries()) {
      input.max = index % 2 === 0 ? sourceWidth : sourceHeight;
      input.value = "";
    }
    updateSelection();
  }
  function point(event) {
    const rect = preview.getBoundingClientRect();
    const coordinate = (offset, extent, size) => Math.round(Math.min(1, Math.max(0, offset / extent)) * size);
    return [coordinate(event.clientX - rect.left, rect.width, sourceWidth), coordinate(event.clientY - rect.top, rect.height, sourceHeight)];
  }
  function updateDrag(event) {
    if (drag?.pointer !== event.pointerId) return;
    const [x, y] = point(event);
    const positions = [Math.min(drag.x, x), Math.min(drag.y, y), Math.max(drag.x, x), Math.max(drag.y, y)];
    for (const [index, input] of inputs.entries()) input.value = positions[index];
    updateSelection();
  }
  function cancelDrag() {
    if (!drag) return;
    for (const [index, input] of inputs.entries()) input.value = drag.previous[index];
    drag = null; updateSelection();
  }

  dialog.returnValue = "";
  preview.hidden = true; edges.disabled = true;
  for (const input of inputs) input.value = "";
  updateSelection();
  return new Promise(resolve => {
    dialog.addEventListener("close", () => {
      clearTimeout(timeout);
      listeners.abort();
      video.pause(); video.srcObject = null;
      resolve(dialog.returnValue === "record" && track.readyState === "live" ? selection : null);
    }, { once: true });
    preview.addEventListener("pointerdown", event => {
      if (event.button !== 0 || drag || !sourceWidth) return;
      const [x, y] = point(event);
      drag = { pointer: event.pointerId, x, y, previous: inputs.map(input => input.value) };
      preview.setPointerCapture(event.pointerId);
      updateDrag(event);
    }, options);
    preview.addEventListener("pointermove", updateDrag, options);
    preview.addEventListener("pointerup", event => {
      if (drag?.pointer !== event.pointerId) return;
      updateDrag(event); drag = null;
    }, options);
    preview.addEventListener("pointercancel", cancelDrag, options);
    edges.addEventListener("input", updateSelection, options);
    video.addEventListener("loadeddata", updatePreview, options);
    video.addEventListener("resize", updatePreview, options);
    track.addEventListener("ended", () => dialog.close("source-ended"), options);
    dialog.showModal();
    const timeout = setTimeout(() => {
      if (!sourceWidth) status.textContent = "The shared picture is unavailable. Cancel and choose a different source.";
    }, 5000);
    video.srcObject = new MediaStream([track]);
    video.play().catch(() => {
      if (!listeners.signal.aborted && !sourceWidth) status.textContent = "The preview could not start. Cancel and choose a different source.";
    });
  });
}
