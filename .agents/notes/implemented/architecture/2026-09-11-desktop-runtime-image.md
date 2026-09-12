# Agent Note: Deploy preinstalled Desktop runtime images

Status: implemented

English | [中文](2026-09-11-desktop-runtime-image.zh.md)

## Problem

First launch installs a complete dependency graph even though packaging already proved an offline installation. Store extraction, pnpm installation, and two backend starts delay the usable application. A rotating indicator does not distinguish file deployment from backend readiness. The [seed I/O decision](../bug-fix/2026-09-11-desktop-windows-first-launch.md) removes redundant store copies but retains that installation work.

## Decision

Packaging retains the final verified hoisted dependency graph in an uncompressed runtime image. Its descriptor binds the release version, platform, architecture, entry count, byte length, and SHA-256. Traversal and archive paths share the canonical build profile directory so filesystem aliases do not appear as escaping entries. The image contains relative file links and omits machine-specific pnpm installation metadata; directory links and external links fail packaging. The existing maintenance seed remains available for restoring installed plugins. Signed macOS images are created after the store's Mach-O signing and the final offline installation.

Plugin-free deployments authenticate seed metadata and unpack the image into isolated staging while hashing its bytes. They do not read maintenance store shards or run pnpm. Extraction rejects escaping paths, duplicate entries, unsupported types, links through parent links, wrong identity, invalid counts, and changed bytes. A failed extraction cannot activate a profile. Installed plugins select the existing store and offline pnpm restoration path described by [Desktop packaging](2026-08-25-electron-desktop-packaging-and-updates.md).

First installation has no prior dependency graph to protect. It journals the initial activation, starts the backend once at its final path, and commits only after readiness succeeds. A startup failure removes that installation; recovery discards an initial activation whose readiness was not committed. Replacements keep their staged health check and rollback. This supersedes the two-start first-install decision, while retaining its failure protection.

Each process launch reveals the existing DeepSeek outline in place, reveals its highlighted particle fill as a whole without a directional sweep, and expands an asymmetric nebula outward. Unequal streams, varying density, and motion at several scales form drifting clouds around the mark. The resulting particles remain animated. Pointer movement repels particles and adds parallax and a particle trail; clicks release an impulse and a dispersing particle burst. Fixed particle counts, cached glow sprites, a bounded pixel ratio, and a 60 Hz drawing ceiling limit renderer work. Focusing an already running application does not replay this scene. Its determinate progress describes actual archive bytes only. Backend startup remains indeterminate, reduced-motion preferences disable motion, and hidden pages stop rendering. Readiness and page teardown dispose animation listeners. The application never delays readiness to finish the animation. Native packaging deploys and boots the image in an isolated home and requires the client document to return HTTP 200 before producing installers.

## Alternatives considered

Moving pnpm installation into the Windows installer moves the wait and requires choosing the correct non-elevated user; macOS drag-and-drop installation has no equivalent hook. A portable image removes pnpm from the first-launch path on both platforms. Reading directly from the application's resource directory would require changing the Host's writable profile and package-resolution ownership. Skipping readiness without a journal can leave a broken initial profile that subsequent launches consider installed. A fixed splash duration penalizes fast machines and conceals readiness.

## Consequences

First deployment writes one dependency tree and starts one backend. The image increases the release payload because the maintenance store is retained for offline plugin restoration; installer compression reduces download size but does not eliminate this disk cost. Real deployment still costs filesystem I/O, and performance measurements must distinguish setup from backend startup. Runtime-image, transaction, and browser tests cover relocation, corruption, failed activation, interrupted initialization, localized progress, layout, reduced motion, pointer displacement against deterministic scene controls, and frame quiescence after teardown. Native packaging records measured deployment and readiness durations in its runtime smoke evidence; this is not a universal startup-time guarantee.
