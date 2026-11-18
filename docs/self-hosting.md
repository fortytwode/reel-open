# Self-host Reel

This guide applies to any individual or organization deploying Reel with their own resources. Use an email domain you control, your own Firebase project and Google OAuth clients, and your own Notion and Gmail credentials if you enable meeting delivery. Rocketship is one configured deployment of this public code; its accounts and private integrations are not required.

Keep your deployment configuration outside the public repository. Browser client settings are readable by app users; service-account keys, API secrets and bot authentication sessions must stay in your private secret store. Never put those secrets in the generated client JSON.

A domain name gives Reel a URL. For cloud sign-in and sharing, also provision Firebase Auth, Firestore, Cloud Storage and HTTPS hosting. The meeting APIs, delivery service and cloud recorder are optional workloads.

## Host the recording library

1. Create a Firebase project with Google sign-in, the Storage bucket and the Firestore database you will use. Add each chosen hosting domain to Firebase Auth's authorized domains. Create Google OAuth clients for the desktop platforms you plan to distribute.
2. Copy `organization.example.json` to `organization.local.json`, fill in your values and run `python3 scripts/configure-organization.py`. See the [organization configuration reference](organization-configuration.md) for the fields and generated files.
3. Use the Firebase CLI to map the `reel` hosting target to your Hosting site, then deploy the generated configuration from the repository root. Replace each uppercase placeholder with your own resource name.

   ```sh
   firebase target:apply hosting reel YOUR_HOSTING_SITE --project YOUR_PROJECT
   firebase target:apply storage main YOUR_BUCKET --project YOUR_PROJECT
   firebase deploy --config firebase.local.json --project YOUR_PROJECT --only hosting:reel,firestore,storage
   gcloud storage buckets update gs://YOUR_BUCKET --cors-file=.reel/firebase/cors.json
   ```

   Run `python3 scripts/fetch-web-model.py` before deploying if you want browser camera blur and virtual backgrounds. Firebase Hosting serves the recorder at `/record`, the library at `/library` and the viewer at `/v/<id>`.

4. Sign in with a verified Workspace account in your configured domain. Record and upload a short test, open its share URL from the intended viewer account, and check that participant meeting notes are inaccessible to an unauthorized account. Recording share links remain available to their intended link recipients.

The configuration bundled with the clients contains public settings. Store deployment-owned files, service credentials and tokens outside the source repository. For existing Firebase resources, review the generated rules against the policies for any other apps that share them.

## Build desktop clients and the extension

Build the macOS app after rendering the organization configuration. Use the [Windows packaging instructions](../desktop-windows/PACKAGING.md) with your own installed-app OAuth credentials. The [browser extension](../browser-extension/README.md) is available as unpacked source for Chrome and Edge.

## Add meeting services

Build and deploy the [meeting API](../meeting-service/README.md) and [optional delivery service](../delivery-service/README.md) as container services. Both build-context scripts accept a committed source ref and an empty directory. Set the organization settings from `.reel/backend.env` on each service. The standalone delivery provider sends through delegated Gmail and stores verified notes in a private Notion data source and participant library.

The generated backend settings enable meeting access for every verified account in your configured email domain. With `MEETING_CLOUD_PROVIDERS=google_meet,teams` and the cloud worker configured, both providers are available throughout that domain. Remove optional cloud-owner pilot lists when opening the service to the whole organization. Each person then signs in to the browser recorder, opens Calendar, connects Google Calendar and chooses per-meeting approval or confirms standing participant consent. Merely downloading an app does not enroll their calendar. Domain-wide availability preserves private meeting-note access for the invited participants.

For unattended recording, provision a Cloud Run Job, private GCS storage and Cloud Tasks for the [cloud worker](../meeting-bot/README.md). Start with an explicit owner and provider scope. Google Meet can use a dedicated Workspace bot account signed into official Google Chrome. The operator saves Playwright browser state to a private GCS object and the worker verifies the expected signed-in account before requesting admission. Meeting policy, consent and host admission still apply.

## Export a clean source snapshot

Run `python3 scripts/export-open-source.py COMMIT /path/to/new-directory` from a Reel checkout. Review the contents before publishing the snapshot as a new repository. The export reads the allowlist from the committed revision's file tree and omits deployment settings, private history and the downloadable camera model.
