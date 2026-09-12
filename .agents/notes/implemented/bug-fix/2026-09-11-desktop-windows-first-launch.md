# Agent Note: Show Desktop first-launch progress and skip unused seed I/O

Status: implemented

English | [中文](2026-09-11-desktop-windows-first-launch.zh.md)

The [runtime image decision](../architecture/2026-09-11-desktop-runtime-image.md) supersedes the first-install path below. Its single-start journal preserves failure recovery; the store extraction optimizations remain in use for upgrades that restore plugins.

## Problem

On Windows, the first packaged Desktop launch can sit on a blank desktop for a long time. The Electron main process hashed every seed file, listed then extracted every pnpm store archive, copied that tree into `.dsh/desktop/pnpm/store`, ran offline `pnpm install`, and health-checked the backend before it created a window. Windows Defender then scanned each newly written file. Subsequent launches with a matching profile still hashed the unused seed, including large store archives, before starting the backend.

The health-check start-and-stop of the staged backend remains required so a failed graph never replaces the active profile.

## Decision

Startup compares the packaged release identity with the active profile before any seed hashing. A matching installed release verifies only that profile's local package set and starts the backend. A first install or upgrade opens a locale-owned progress window, then hashes the seed inventory with streaming SHA-256, extracts each store archive in one validating pass, and moves the extracted store into place when the private store is empty. Cross-device rename falls back to copy. A populated store still copies files and transactionally merges SQLite `package_index` records so plugin-downloaded packages remain. Archive path, type, uniqueness, shard, and count checks are unchanged. The progress window stays until the product backend is ready. The [packaging and update note](../architecture/2026-08-25-electron-desktop-packaging-and-updates.md) still owns seed transport, health checking, and activation.

## Alternatives considered

**Skip the staged health check on first install.** The first startHost would become the only proof the graph boots, but a failing graph would already occupy `.dsh/profiles/desktop`, and the matching-release reuse path would not reinstall it.

**Disable or exclude Windows Defender.** The application cannot change the user's antivirus policy. Reducing extra file copies and keeping the UI responsive is the owned mitigation.

**Pre-extract `node_modules` into the installer.** That abandons the offline seed plus pnpm install model, bloating the signed artifact and making differential updates track tens of thousands of cache files.

**Keep hashing the full seed on every launch.** That detects a tampered seed that the process will not consume until an upgrade. Integrity remains required immediately before seed content enters writable desktop state.

## Consequences

First install and upgrade show a localized progress window instead of a blank desktop. Matching subsequent launches skip store-archive I/O. Empty-store first launch writes each store file once. Seed integrity and archive validation still run before any seed content is merged. The staged health check still starts and stops a backend before activation, so first install still pays two backend starts.
