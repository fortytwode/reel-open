// Keep install consent in the browser. No service worker/private-content cache.
const button = document.getElementById("install-reel");
const help = document.getElementById("install-help");
const message = document.getElementById("install-status");
let deferredPrompt = null, installed = false;
const standalone = window.matchMedia("(display-mode: standalone)");
function update() {
  button.hidden = installed || standalone.matches;
  help.hidden = installed || standalone.matches;
  button.textContent = deferredPrompt ? "Install Reel" : "Install on Windows";
}
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault(); deferredPrompt = event; update();
});
window.addEventListener("appinstalled", () => {
  installed = true; deferredPrompt = null; update();
  message.textContent = "Reel installed. Open it from your Start menu or taskbar.";
});
standalone.addEventListener("change", update);
button.addEventListener("click", async () => {
  if (!deferredPrompt) {
    help.open = true;
    help.querySelector("summary").focus();
    return;
  }
  const prompt = deferredPrompt; deferredPrompt = null; button.disabled = true;
  try {
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    message.textContent = outcome === "accepted" ? "Installation accepted. You can open Reel from your Start menu." : "Installation cancelled. You can keep recording here or install later.";
  } catch {
    message.textContent = "Use your browser’s Install app option below, or keep recording here.";
    help.open = true;
  } finally { button.disabled = false; update(); }
});
update();
