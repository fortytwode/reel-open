import { openCamera, openMic, pickDevice } from "./capture.js?v=20261025-audio1";
import { usesMic } from "./core.js";

/**
 * Creates the optional setup preview. Permission prompts happen only after the user presses the
 * supplied button. The preview is intentionally raw: recording applies any selected background.
 */
export function createPreview({ video, meter, button, status, getSettings, onDevices }) {
  let enabled = false;
  let generation = 0;
  let camera = null;
  let mic = null;
  let audioContext = null;
  let animation = 0;

  const setButton = (on) => {
    button.setAttribute("aria-pressed", String(on));
    button.textContent = on ? "Stop preview" : "Preview camera and microphone";
  };

  function release() {
    if (animation) cancelAnimationFrame(animation);
    animation = 0;
    if (audioContext) {
      const context = audioContext;
      audioContext = null;
      context.close().catch(() => {});
    }
    for (const stream of [camera, mic]) {
      if (stream) stream.getTracks().forEach((track) => track.stop());
    }
    camera = null;
    mic = null;
    video.pause();
    video.srcObject = null;
    video.hidden = true;
    meter.value = 0;
  }

  function stop() {
    generation++;
    enabled = false;
    release();
    setButton(false);
    status.textContent = "Preview stopped. Camera backgrounds apply while recording.";
  }

  async function acquire(token) {
    const settings = getSettings();
    const wantsCamera = settings.mode === "camera" || settings.cameraEnabled;
    const wantsMic = usesMic(settings.audio);
    if (!wantsCamera && !wantsMic) {
      stop();
      status.textContent = "Turn on the camera or choose microphone audio to preview.";
      return;
    }

    try {
      if (wantsCamera) {
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
        if (token !== generation) return;
        const picked = pickDevice(devices, settings.cameraID);
        const stream = await openCamera(picked && picked.deviceId && picked.deviceId !== "default" ? picked.deviceId : undefined);
        if (token !== generation) { stream.getTracks().forEach((track) => track.stop()); return; }
        camera = stream;
        video.srcObject = camera;
        video.hidden = false;
        await video.play();
      }

      if (wantsMic) {
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
        if (token !== generation) return;
        const picked = pickDevice(devices, settings.microphoneID);
        const stream = await openMic(picked && picked.deviceId && picked.deviceId !== "default" ? picked.deviceId : undefined);
        if (token !== generation) { stream.getTracks().forEach((track) => track.stop()); return; }
        mic = stream;
        startMeter(mic, token);
      }

      if (token !== generation) return;
      status.textContent = settings.cameraBackground && settings.cameraBackground !== "none" && wantsCamera
        ? "Preview is unprocessed; the selected background is applied while recording."
        : "Preview is ready.";
      if (onDevices) await onDevices();
    } catch (error) {
      if (token !== generation) return;
      const message = error && error.name === "NotAllowedError"
        ? "Camera or microphone permission was denied. Allow access in your browser settings, then try again."
        : error && error.name === "NotFoundError"
          ? "No camera or microphone was found. Connect a device and try again."
          : `Preview couldn't start: ${(error && error.message) || "check your camera and microphone"}.`;
      stop();
      status.textContent = message;
    }
  }

  function startMeter(stream, token) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Microphone level meter is unavailable in this browser");
    audioContext = new AudioContextClass();
    const source = audioContext.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser); // Deliberately no connection to destination: preview audio stays silent.
    const samples = new Uint8Array(analyser.fftSize);
    const draw = () => {
      if (token !== generation || !audioContext) return;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        sum += normalized * normalized;
      }
      meter.value = Math.min(1, Math.sqrt(sum / samples.length) * 4);
      animation = requestAnimationFrame(draw);
    };
    audioContext.resume().catch(() => {});
    draw();
  }

  button.addEventListener("click", () => {
    if (enabled) {
      stop();
      status.textContent = "Preview stopped.";
      return;
    }
    enabled = true;
    const token = ++generation;
    setButton(true);
    status.textContent = "Requesting camera and microphone access…";
    acquire(token);
  });

  setButton(false);
  return { stop };
}
