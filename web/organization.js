import { organizationConfig } from "./reel/organization.js?v=20261118-orgstate1";

async function loadOrganization() {
  try {
    const response = await fetch(new URL("./organization.json", import.meta.url), { cache: "no-store", redirect: "error" });
    return response.ok ? organizationConfig(await response.json()) : null;
  } catch { return null; }
}

export const organization = await loadOrganization();
const stateScope = organization ? `${organization.projectID}:${organization.allowedEmailDomain}` : "local";
// Use a new prefix so unscoped recordings and credentials stay untouched and unassigned.
export const organizationStorageKey = key => `reel-state:${stateScope}:${key}`;

if (organization) {
  const library = organization.notesBaseURL;
  for (const link of document.querySelectorAll("a[data-library]")) link.href = library + link.dataset.library;
  for (const link of document.querySelectorAll("a[data-recorder]")) link.href = organization.webBase + "/record" + link.dataset.recorder;
}
