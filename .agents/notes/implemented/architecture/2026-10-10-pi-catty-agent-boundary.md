# Agent Note: Pi and Catty are the supported product agents
Status: implemented

## Problem

Netcatty inherited a broad agent registry and settings surface, while this fork is intended to provide a stable Catty experience and a first-class Pi agent. Leaving provider-specific entries in discovery, selection, and settings makes the product contract unclear and increases the number of lifecycle paths that must be packaged and tested.

## Decision

The supported in-app agent set is exactly Catty and Pi. Catty remains the built-in streaming path. Pi is integrated through the AI bridge as a first-class driver with discovery, settings, event translation, cancellation, and focused tests. Agent selection, settings, localization, and send eligibility expose only these two product choices.

Provider adapters that are not part of this product surface may remain in the source only when they are required by an upstream compatibility path; they must not be discoverable or selectable by default. New agent work must add the driver, registry, discovery, lifecycle, and user-visible behavior together.

## Alternatives considered

**Keep every upstream agent.** This preserves upstream breadth but makes the fork's support promise ambiguous and retains untested packaging paths.

**Support Pi only.** This would simplify the UI further but would remove Catty, which remains the fork's built-in agent and existing user path.

**Hide agents only in the UI.** This leaves discovery and bridge behavior inconsistent, so configuration or stale state could still select an unsupported runtime.

## Consequences

The Pi driver and Catty path share the existing normalized event protocol. Settings and localization must keep the two-agent list coherent. Adding another supported agent requires an explicit architecture decision and matching discovery, lifecycle, tests, and packaging evidence.

## Verification

The Pi driver, registry, discovery, state, settings lifecycle, eligibility, and packaging tests pass together. The Windows directory package also completes with the patched `node-pty` runtime present.
