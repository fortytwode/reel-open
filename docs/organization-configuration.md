# Configure a Reel organization

Each deployment trusts one Google Workspace email domain and one Firebase project. Use a local copy of the example to configure the clients, backend policy, and Firebase rules together.

```sh
cp organization.example.json organization.local.json
# Edit organization.local.json with the deployment’s values.
python3 scripts/configure-organization.py
```

The helper runs entirely on the local machine. It also accepts a configuration file outside the checkout and an optional `--output-dir` for staging. The example contains synthetic identifiers and reserved example hosts.

| Fields | Values |
| --- | --- |
| `allowedEmailDomain` | The exact lowercase domain after the @ in a verified account. |
| `projectID`, `bucket`, `authDomain`, `apiKey` | The Firebase project ID, Storage bucket name, Firebase Auth hostname and public web API key for the same project. Enable Google sign-in and authorize the hosting domains in Firebase Auth. |
| `firestoreDatabase` | The Firestore database to use, normally `reel`. The Firebase deployment target must select this same database. |
| `googleClientID`, `googleDesktopClientId` | Google OAuth client IDs for the macOS and Windows applications, respectively. For Windows, use an installed/Desktop client. Omit or leave either field empty when that platform is unused. |
| `webBase` | Origin serving the browser recorder at `/record` and the viewer at `/v/<id>`. |
| `viewerBase`, `viewerPath` | Origin and single path segment used in shared recording links. For standalone Firebase Hosting, use the web origin and `v`. A custom link prefix needs a host that routes those links to the viewer. |
| `notesBaseURL` | URL of the library page. Reel appends `#meetings/<id>` for participant notes. Standalone Hosting serves the library at `/library`. |
| `meetingServiceURL`, `deliveryServiceURL`, `speechServiceURL` | HTTPS origins of the optional meeting, delivery and speech APIs. Omit or leave an unused service empty; it receives an inactive `.invalid` endpoint. Browser recording and Firebase sharing do not require these services. |
| `allowedOrigins` | Exact browser origins authorized for the APIs and Storage downloads. Add localhost with its explicit port for local development. |

Run the helper before packaging or hosting a configured build. The web host needs `web/organization.json` alongside its HTML and JavaScript. A host that proxies Reel assets must also serve this JSON from the corresponding asset directory. The Mac build script copies `.reel/organization.json` into the signed bundle. The portable Windows builder packages `desktop-windows/organization.json` and checks that its Desktop client ID matches the external installed-app credentials supplied to the builder. Keep the credentials file outside the checkout.

Use the settings in `.reel/backend.env` for the services. The generated `REEL_MEETING_ALLOWED_DOMAIN` matches `allowedEmailDomain`, enabling meeting features for all verified accounts in that domain. Optional account and cloud-provider pilot lists and service credentials are separate; omit the domain setting if you intentionally restrict meeting access to `REEL_ALLOWED_EMAILS`. The renderer writes the Firestore and Storage policies and bucket CORS document under `.reel/firebase/`. A dedicated Reel bucket grants access only to Reel paths. For an existing shared bucket, pass `--storage-fragment /private/path/to/other-app.rules` on every render to preserve the other application's rules inside the bucket match. Review the combined policy before deploying to that bucket.

The renderer also creates `firebase.local.json`, selecting that configuration's Firestore database and generated rule paths. Use `firebase deploy --config firebase.local.json --project YOUR_PROJECT` after applying the Hosting target `reel` to your site and Storage target `main` to the configured bucket. Load the unpacked extension from `.reel/browser-extension`; its recorder host permission is generated from `webBase`, with the exact origin checked again at runtime.

For a distributed Mac build, set `REEL_BUNDLE_ID`, `REEL_APPCAST_URL`, and `REEL_SPARKLE_PUBLIC_KEY` explicitly. An unconfigured build uses `org.reel.app` and disables automatic updates. An existing deployment should preserve its bundle identifier, signing identity, update URL and signing key to keep permissions and update trust intact.

The generated client configuration is readable by app users. Put API secrets, service-account keys and private provider credentials in the deployment’s secret store. A checkout without a generated configuration supports local recording on macOS and in the browser. Cloud sign-in and the Windows companion’s account-dependent automatic meetings require a configured deployment.
