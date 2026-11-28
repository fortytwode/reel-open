# Reel development

Use this public repository as the source of truth for Recorder AI and Notetaker AI. Open product-code pull requests here, including fixes first found in a team deployment. Merge the public implementation before distributing a product update. This applies to the Mac and Windows apps, web UI, browser extension, and reusable meeting and delivery services.

Keep deployment credentials, signing keys, customer data, and organization-specific configuration out of the public tree. Use synthetic fixtures in tests. When a deployment needs a private adapter, put reusable behavior here and use the adapter for the organization-specific integration.

Build from the public revision you are releasing and link that revision in the release notes. Publish Mac installers once on `rocketshiphq/reel-open` and let the product repositories sync the release. See [the release guide](docs/product-releases.md).
