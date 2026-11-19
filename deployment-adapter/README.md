This directory is intentionally empty of integration code in the public build.

The default delivery provider uses the deployment's Notion and Gmail configuration.
An organization can supply an optional private integration bundle at build time
and select it explicitly with `REEL_DELIVERY_PROVIDER=canonical`. The application
does not import that bundle for the default provider. Private integration code,
configuration and credentials do not belong in this directory in Git.

An optional adapter can resolve an authoritative Calendar occurrence to a
delivery route and accept a follow-up handoff after notes and email are
confirmed. The built-in standalone provider works without these hooks. A
deployment adding a handoff must persist it idempotently before acknowledging
the request because delivery can retry after an uncertain response.
