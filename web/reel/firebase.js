// Firebase settings shared by the viewer (/v/<id>) and the browser recorder (/record).
// The API key is a public client identifier; access is enforced by the Storage and Firestore
// rules. Keep in sync with Sources/ReelCore/ShareLinks.swift (CloudConfig.default).
import { CLOUD } from "./core.js?v=20261110-delivery1";

import { organization } from "../organization.js?v=20261118-orgstate1";
import { internalEmail } from "./organization.js?v=20261118-orgstate1";

const deployment = { ...CLOUD, ...organization };
export const BUCKET = deployment.bucket;
export const isOrganizationEmail = email => internalEmail(email, deployment.allowedEmailDomain);
export const FB_VERSION = "12.19.0";
export const FB_CDN = "https://www.gstatic.com/firebasejs/" + FB_VERSION + "/";
export const FIREBASE_CONFIG = {
  apiKey: deployment.apiKey,
  authDomain: deployment.authDomain,
  projectId: deployment.projectID,
  storageBucket: BUCKET,
};
export const DOMAIN = "@" + deployment.allowedEmailDomain;

// Local emulators, only when served from localhost with ?emulator=1 (tests).
export const EMU = typeof location !== "undefined" &&
  (location.hostname === "localhost" || location.hostname === "127.0.0.1") &&
  new URLSearchParams(location.search).get("emulator") === "1";
export const STORAGE_ORIGIN = EMU ? "http://127.0.0.1:9199" : CLOUD.storageOrigin;

/** CloudConfig for core.js request builders (emulators run as project demo-reel). */
export const CLOUD_CONFIG = EMU
  ? { ...deployment, projectID: "demo-reel", storageOrigin: "http://127.0.0.1:9199", firestoreOrigin: "http://127.0.0.1:8080",
      viewerBase: location.origin, viewerPath: "v" }
  : deployment;

/** firebase-app + firebase-auth from gstatic, with the emulator wired up when testing. */
export async function loadAuth() {
  if (!organization) throw new Error("Cloud sign-in is not configured.");
  const appM = await import(FB_CDN + "firebase-app.js");
  const am = await import(FB_CDN + "firebase-auth.js");
  const app = appM.initializeApp(EMU ? { ...FIREBASE_CONFIG, projectId: "demo-reel" } : FIREBASE_CONFIG);
  const auth = am.getAuth(app);
  if (EMU && !auth.emulatorConfig) am.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  return { app, auth, am };
}

/** Bind identity and token retrieval to the same Firebase user across auth changes. */
export function sessionSnapshot(selectedUser) {
  if (!selectedUser) return null;
  return { uid: selectedUser.uid, email: selectedUser.email, displayName: selectedUser.displayName,
    getIdToken: () => selectedUser.getIdToken() };
}
