// Public deployment settings. Only load these from the packaged app or its own static assets.
const hostname = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export function validDomain(domain) {
  return typeof domain === "string" && domain.length <= 253 && hostname.test(domain);
}
function validStorageBucket(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(value)) return false;
  const parts = value.split(".");
  return parts.every(part => part.length > 0 && part.length <= 63)
    && !(parts.length === 4 && parts.every(part => /^[0-9]+$/.test(part) && Number(part) <= 255));
}
export function internalEmail(email, domain) {
  if (!validDomain(domain) || typeof email !== "string") return false;
  const parts = email.toLowerCase().split("@");
  return parts.length === 2 && /^[^\s<>@]+$/.test(parts[0]) && parts[1] === domain;
}

export function organizationConfig(value) {
  const accountAccess = value?.accountAccess;
  if (accountAccess !== undefined && accountAccess !== "organization" && accountAccess !== "public") return null;
  const domain = value?.allowedEmailDomain;
  const validAccountDomain = accountAccess === "public" && (domain === undefined || domain === "") || validDomain(domain);
  if (!validAccountDomain || !validStorageBucket(value.bucket) || !validDomain(value.authDomain)
      || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value.projectID ?? "")
      || !/^[A-Za-z0-9_-]+$/.test(value.apiKey ?? "") || !/^[A-Za-z0-9_-]+$/.test(value.viewerPath ?? "")
      || !/^(?:[a-z][a-z0-9-]*|\(default\))$/.test(value.firestoreDatabase ?? "")) return null;
  for (const field of ["viewerBase", "webBase", "speechServiceURL", "deliveryServiceURL", "meetingServiceURL"]) {
    try {
      const url = new URL(value[field]);
      const local = ["webBase", "viewerBase"].includes(field) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (value[field] !== url.origin || !(url.protocol === "https:" || (local && url.protocol === "http:"))) return null;
    } catch { return null; }
  }
  try {
    const notes = new URL(value.notesBaseURL);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(notes.hostname);
    if (notes.username || notes.password || notes.search || notes.hash
        || !(notes.protocol === "https:" || (local && notes.protocol === "http:"))) return null;
  } catch { return null; }
  return Object.freeze(value);
}
