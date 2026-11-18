This directory is intentionally empty of integration code in the public build.

The default delivery provider uses the deployment's Notion and Gmail configuration.
An organization can supply an optional private integration bundle at build time
and select it explicitly with `REEL_DELIVERY_PROVIDER=canonical`. The application
does not import that bundle for the default provider. Private integration code,
configuration and credentials do not belong in this directory in Git.
