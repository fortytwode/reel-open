# Release Recorder AI and Notetaker AI

Open product PRs in [reel-open](https://github.com/rocketshiphq/reel-open) and land the public implementation on `main` before releasing it. Build the version from that clean revision. Keep credentials, organization configuration, signing material, and customer data in the deployment’s private stores. Park installation or environment differences in configuration so a customer-facing fix can ship from the same open source.

The public Mac builds work without RocketShip’s organization configuration. Use the signed and notarized universal installer for Apple silicon and Intel. Confirm that the app’s embedded `ReelSourceRevision` is the full SHA of the commit being tagged. Compare the signed bundle contents with the intended public build before you upload it.

Publish the installer and its `SHA256SUMS.txt` on **reel-open** as a stable release from a commit on `main`. Put the single Mac installer and its SHA-256 digest in the checksum file.

| Product | Source tag | Installer asset | Product repository |
| --- | --- | --- | --- |
| Recorder AI | `vX.Y.Z` | `Reel-Recorder-X.Y.Z-macOS-universal.dmg` | [recorder-ai](https://github.com/rocketshiphq/recorder-ai) |
| Notetaker AI | `notetaker-vX.Y.Z` | `Reel-Notetaker-X.Y.Z-macOS-universal.dmg` | [notetaker-ai](https://github.com/rocketshiphq/notetaker-ai) |

The product repositories check daily and copy the latest stable release for their product. Each publishes under `vX.Y.Z`, with the same installer and checksum and a link to the exact public source. For same-day or immediate distribution, run **Sync public Reel release** in that product’s GitHub Actions tab. The sync verifies the public tag and the published asset digests. It stops if an existing product release differs. That release needs a new version or operator reconciliation.

For a read-only check from a source checkout:

```sh
python3 scripts/sync-product-release.py recorder --check
python3 scripts/sync-product-release.py notetaker --check
```

For web, Windows, and service updates, record the public source SHA in the deployment or release receipt. Follow the existing platform verification and signing path. The product repository sync handles the stable Mac DMGs.
