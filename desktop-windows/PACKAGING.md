# Windows packaging

## Windows installer and updates

`build-msix.ps1` packages Reel Recorder, Reel Notetaker and Reel Companion as separate Start entries in one per-user MSIX. It uses the same organization configuration, Electron distribution and Desktop OAuth inputs as the portable build below. Install the Windows SDK on the build machine for MakeAppx and SignTool.

Run the following on Windows for each target architecture. Set `$releasePublisher` to your code-signing certificate’s exact subject and `$downloadBase` to your HTTPS download directory without a trailing slash. Supply the matching architecture’s Electron distribution.

```powershell
$arch = 'arm64' # or 'x64'
$version = '0.1.3'
$package = "Reel-$version-win32-$arch.msix"
$feed = "latest-$arch.appinstaller"
./desktop-windows/build-msix.ps1 `
  -ElectronDist "C:\Electron\45.2.3-win32-$arch" `
  -GoogleDesktopClientId $clientId -GoogleDesktopCredentialsFile $installedCredentialsPath `
  -Architecture $arch -Publisher $releasePublisher -Version "$version.0" `
  -PackageUri "$downloadBase/$package" -AppInstallerUri "$downloadBase/$feed" `
  -OutputMsix "C:\ReelBuilds\$package" -OutputAppInstaller "C:\ReelBuilds\$feed"
```

Sign and timestamp the generated MSIX with your release signing service. Verify the signed file with `signtool verify /pa /v` and compute its SHA-256 after signing. Publish the signed, versioned MSIX first and its architecture’s stable `.appinstaller` file last. The host must serve the feed as `application/appinstaller` and the package as `application/msix`, support HEAD with the full content length, and honor byte-range requests for the package.

Install through the architecture’s `.appinstaller` file to register the update feed. Subsequent releases keep its URL, package name and publisher and increase the three-part version. The default on-launch update check interval is 12 hours. The `Windows MSIX install and update` CI workflow exercises successive test versions using a temporary certificate confined to its disposable Windows runner.

Reel Companion's startup task is off after installation. In Companion's Meeting setup, choose **Open Windows Startup Apps** and turn on **Reel Companion** to launch it the next time you sign in to Windows. Use the same Windows setting to turn it off. App Installer upgrades keep the startup task identity. In a portable build, use **Turn on start at sign-in** in Companion's Meeting setup. Turn it off before deleting or moving the extracted app folder.

## Portable test ZIP

`build-portable.ps1` creates an **unsigned portable test ZIP**, using the existing
production native build and no packaging dependencies. It does not sign,
publish, create OAuth credentials or certify a release.

Run on Windows with PowerShell 5.1 or later, the .NET Framework compiler/UI
Automation assemblies used by `native/build.cmd`, and an extracted **official
Electron 45.2.3 Windows distribution**. Use a clean, dedicated extraction from
Electron's release archive; verify its published checksum before building.
The builder checks the executable's runtime version and PE architecture; those
checks do not establish the supplied distribution's provenance. The machine
must be able to execute that distribution's architecture. No npm install is
required for packaging.

From the repository root, render your deployment settings and build the ZIP.

```powershell
python scripts/configure-organization.py 'C:\ReelCredentials\organization.json'
powershell -NoProfile -File desktop-windows/build-portable.ps1 `
  -ElectronDist 'C:\Electron\45.2.3-win32-arm64' `
  -GoogleDesktopClientId '123456789-example.apps.googleusercontent.com' `
  -GoogleDesktopCredentialsFile 'C:\ReelCredentials\reel-windows-desktop.json' `
  -Version '0.1.1-test.1' `
  -OutputZip 'C:\ReelBuilds\Reel-0.1.1-test.1-win32-arm64.zip'
```

Supply the Desktop OAuth client ID from the rendered
`desktop-windows/organization.json` and the matching downloaded Desktop
credentials JSON. The credentials JSON must
stay outside the repository, be a regular file of at most 32 KiB, and contain
only an `installed` root object. Its `client_id` must exactly match the explicit
ID; its `client_secret` must contain 1–256 URL-safe ASCII characters. Web and
service-account credential files, malformed inputs and reparse-point paths are
rejected before compilation or packaging. The builder never prints the file
contents or client value.

This Desktop `client_secret` is non-confidential installed-app identification,
not a server credential or a user token. Google requires it for this client's
token exchange; PKCE, state, nonce, loopback binding and explicit user consent
remain the security controls. The generated runtime `desktop-windows/config.json`
contains only `googleDesktopClientId` and `googleDesktopClientSecret`; the original
JSON is never copied. The tracked source `config.json` remains ID-only. Keep
actual downloaded credentials out of source control and diagnostic output.
Authentication/provider consent must still be verified with the packaged client
before release.

The builder deletes any existing production helper, recompiles it from the
current `Core.cs`, `WinJoin.cs` and `Program.cs`, and requires `native/build.cmd`
to finish its policy tests. It leaves that build's local native executables in
the source checkout. Only `ReelNativeJoin.exe` enters the package; fixture and
policy test binaries do not. Compilation uses the existing compiler defaults;
the manifest describes the helper as managed .NET Framework rather than
claiming a particular native machine architecture.

The ZIP contains `Reel.exe` and the Electron runtime, preserving upstream
`LICENSE` and `LICENSES.chromium.html`. `resources/app/package.json` points at
`desktop-windows/main.mjs`. Under `resources/app/`, an explicit allowlist copies
only production desktop main/preload/modules/UI/capture assets, the compiled
helper and generated public configuration. Shared `web/reel/` content is limited
to `capture.js`, `core.js`, `audio.js`, `encoder-worker.js` and `fmp4.js`;
`web/vendor/` includes only `mp4-muxer.mjs` and its license. These sibling paths
match `src/asset-server.mjs`. Probe code, source tests, fixtures, account data,
tokens and source-tree configuration files are excluded.

The script checks source stability during native compilation and checks the
application file allowlist both before compression and inside the ZIP. It
prints the archive SHA-256 and writes `build-info.json` with the supplied app
version, actual Electron version/architecture and source/helper hashes. The
renamed `Reel.exe` retains Electron's upstream executable version resources;
the supplied app version is recorded in package metadata. Existing archives
are never overwritten. A failed archive check leaves the output for inspection;
use a fresh output name after diagnosing a failure.

Extract the entire ZIP into a writable local folder and launch `Reel.exe`.
Portable describes distribution: sessions/settings/recordings still use Reel's
normal per-user application data location. This does not move account data into
the extracted folder. Unsigned Windows builds may prompt or be blocked by local
policy; do not bypass organizational security controls.

Packaging checks are bounded to build inputs and archive structure. Before a
public release, retain separate evidence for the packaged setup UI, Google
sign-in and Calendar consent/discovery, real meeting entry/capture and durable
save, supported target architectures, signing/trust checks and the published
download's checksum and clean-machine launch. No Windows signing certificate
has been supplied. The builder produces no installer and makes no claim that
these release checks have passed.
