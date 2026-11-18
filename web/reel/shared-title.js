// Shared web titles live apart from source metadata and publisher index writes.
import { deriveKey, downloadURL, File, room as roomFor } from "./core.js?v=20261105-parity2";

export function normalizedSharedTitle(value) {
  const title = typeof value === "string" ? value.trim() : "";
  if (!title || title.length > 500) throw new Error("Enter a shared title between 1 and 500 characters.");
  return title;
}
export function displayedSharedTitle(override, fallback) {
  return typeof override === "string" && override.trim() && override.length <= 500 ? override : fallback;
}

// The protected room is located using the same password derivation as playback.
// Nothing derived here is persisted or put in navigation URLs.
export async function resolveTitleRoom(id, password, config) {
  async function metadata(key) {
    const response = await fetch(downloadURL(id, File.meta, key, config), { cache: "no-store" });
    if (!response.ok) throw new Error(key ? "Wrong password, or this share is no longer available." : "This share is unavailable or expired.");
    return response.json();
  }
  let meta = await metadata(null), expected = id;
  if (meta.locked) {
    if (!password) throw new Error("Enter this recording’s password to rename its shared title.");
    const kdf = meta.kdf;
    if (kdf?.name !== "PBKDF2" || kdf.hash !== "SHA-256" || !/^[a-f0-9]{32}$/.test(kdf.salt) || !Number.isInteger(kdf.iterations) || kdf.iterations < 1 || kdf.iterations > 1000000 || kdf.keyBytes !== 16) throw new Error("This share’s password settings are unsupported.");
    const key = await deriveKey(password, kdf.salt, kdf.iterations, kdf.keyBytes);
    expected = roomFor(id, key); meta = await metadata(key);
  }
  if (meta.id !== id || meta.room !== expected || meta.locked || (meta.expiresAt && Date.parse(meta.expiresAt) <= Date.now())) throw new Error("This recording has no available shared room.");
  return expected;
}

export async function saveSharedTitle({ fs, db, id, room, uid, title, isCurrent }) {
  title = normalizedSharedTitle(title);
  if (!/^[a-z0-9]{16,40}$/.test(id) || !new RegExp(`^${id}(-[a-f0-9]{32})?$`).test(room)) throw new Error("This recording has no available shared room.");
  const roomRef = fs.doc(db, "videos", room), prefRef = fs.doc(db, "users", uid, "libraryPreferences", id);
  const entryRef = fs.doc(db, "users", uid, "recordings", id);
  function checkCurrent() { if (!isCurrent()) throw new Error("Your account changed. Reopen Rename shared title to try again."); }
  checkCurrent();
  await fs.runTransaction(db, async (transaction) => {
    checkCurrent();
    const [roomSnapshot, preference, entry] = await Promise.all([transaction.get(roomRef), transaction.get(prefRef), transaction.get(entryRef)]);
    checkCurrent();
    const data = roomSnapshot.exists() && roomSnapshot.data();
    if (!data || data.ownerUid !== uid || !entry.exists()) throw new Error("Only the owner of an available shared recording can rename it.");
    if (data.expiresAt && data.expiresAt.toMillis() <= Date.now()) throw new Error("This share has expired. Its shared title was not changed.");
    transaction.set(prefRef, { pinned: false, archived: false, folderId: null, ...(preference.exists() ? preference.data() : {}), titleOverride: title, updatedAt: fs.serverTimestamp() });
    transaction.update(roomRef, { titleOverride: title });
  });
  checkCurrent();
  return title;
}

let activeEditor;
export function closeSharedTitleEditor() { activeEditor?.close(); }
export function editSharedTitle({ title, askPassword = false, save }) {
  closeSharedTitleEditor();
  const dialog = document.createElement("dialog"); dialog.className = "shared-title-dialog";
  const form = document.createElement("form");
  const heading = document.createElement("h2"); heading.textContent = "Rename shared title";
  const hint = document.createElement("p"); hint.textContent = "Changes the title in your web library and shared watch page. The original recording’s title stays on its device.";
  const label = document.createElement("label"); label.textContent = "Shared title";
  const input = document.createElement("input"); input.type = "text"; input.value = title; input.maxLength = 500; input.required = true; input.name = "shared-title"; label.append(input);
  const passwordLabel = document.createElement("label"); passwordLabel.textContent = "Recording password (for protected shares)";
  const password = document.createElement("input"); password.type = "password"; password.autocomplete = "off"; password.name = "recording-password"; passwordLabel.append(password); passwordLabel.hidden = !askPassword;
  const message = document.createElement("p"); message.setAttribute("role", "status"); message.setAttribute("aria-live", "polite");
  const submit = document.createElement("button"); submit.type = "submit"; submit.textContent = "Save shared title";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel"; cancel.addEventListener("click", () => dialog.close());
  form.append(heading, hint, label, passwordLabel, message, submit, cancel); dialog.append(form); document.body.append(dialog); activeEditor = dialog;
  let pending = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); if (pending) return;
    try {
      const value = normalizedSharedTitle(input.value);
      pending = true; submit.disabled = true; input.disabled = true; password.disabled = true; message.textContent = "Saving shared title…";
      await save(value, password.value);
      if (dialog.open) dialog.close();
    } catch (error) { if (dialog.open) message.textContent = error.message || "Couldn't save the shared title. Try again."; }
    finally { pending = false; submit.disabled = false; input.disabled = false; password.disabled = false; password.value = ""; }
  });
  dialog.addEventListener("close", () => { password.value = ""; dialog.remove(); if (activeEditor === dialog) activeEditor = null; });
  dialog.showModal(); input.focus(); input.select();
}
