import { organizationConfig } from "./reel/organization.js?v=20261118-orgstate1";

async function loadOrganization() {
  try {
    const response = await fetch(new URL("./organization.json", import.meta.url), { cache: "no-store", redirect: "error" });
    return response.ok ? organizationConfig(await response.json()) : null;
  } catch { return null; }
}

export const organization = await loadOrganization();
const capturePath = globalThis.document?.querySelector?.('meta[name="reel-capture-url"]')?.content;
export const captureURL = /^\/[a-z0-9/-]+$/.test(capturePath || "") && !capturePath.startsWith("//")
  ? location.origin + capturePath : (organization?.webBase || globalThis.location?.origin || "") + "/record";
export const notetakerName = globalThis.document?.querySelector?.('meta[name="reel-notetaker-name"]')?.content || "Reel Notetaker";
const stateScope = organization ? `${organization.projectID}:${organization.allowedEmailDomain}` : "local";
// Use a new prefix so unscoped recordings and credentials stay untouched and unassigned.
export const organizationStorageKey = key => `reel-state:${stateScope}:${key}`;

if (organization) {
  const library = organization.notesBaseURL;
  for (const link of document.querySelectorAll("a[data-library]")) link.href = library + link.dataset.library;
  for (const link of document.querySelectorAll("a[data-recorder]")) {
    const suffix = link.dataset.recorder;
    const screenMode = capturePath && !suffix.startsWith("?") ? "?mode=recording" : "";
    link.href = captureURL + screenMode + suffix;
  }
}
