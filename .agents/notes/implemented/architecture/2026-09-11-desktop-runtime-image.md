# Agent Note: Deploy preinstalled Desktop runtime images

Status: implemented

English | [中文](2026-09-11-desktop-runtime-image.zh.md)

## Problem

First launch installs a complete dependency graph even though packaging already proved an offline installation. Store extraction, pnpm installation, and two backend starts delay the usable application. A rotating indicator does not distinguish file deployment from backend readiness. The [seed I/O decision](../bug-fix/2026-09-11-desktop-windows-first-launch.md) removes redundant store copies but retains that installation work.

## Decision

The upstream 0.1.6 runtime now stays in the application resources/ASAR. This supersedes the local runtime-image deployment and maintenance seed. Startup creates only an external-plugin profile and runtime resolution metadata; core pnpm installation, image extraction and activation journals are removed. The current owner is the [bundled-runtime decision](2026-09-08-desktop-bundled-runtime-and-external-plugins.md).

The private desktop also requires preservation protection for every session. A fresh model review narrows admissible operations; exact file modifications still require manual approval, and unisolated execution/deletion stays blocked. The host records the active protection epoch at preparation and rechecks it immediately before the registered tool body after all wrappers. This separate registry dispatch guard cannot spend preparation approvals again or be bypassed by replacing wrapper cancellation signals. Persistent file-intent checks reject writes after unload; the policy's last registered disposer revokes its lifetime first.

Each process launch reveals the existing DeepSeek outline in place, reveals its highlighted particle fill as a whole without a directional sweep, and expands an asymmetric nebula outward. Unequal streams, varying density, and motion at several scales form drifting clouds around the mark. The resulting particles remain animated; the solid mark supplies sampling pixels but stays invisible during animation. The scene has no diffuse logo halo or colored background wash. Startup copy is limited to the application name and preparation status. Pointer movement repels particles and adds parallax and a particle trail; clicks release an impulse and a dispersing particle burst. Fixed particle counts, cached glow sprites, a bounded pixel ratio, and a 60 Hz drawing ceiling limit renderer work. Focusing an already running application does not replay this scene. Backend startup remains indeterminate, reduced-motion preferences disable motion, and hidden pages stop rendering. Readiness and page teardown dispose animation listeners. The application never delays readiness to finish the animation. Native packaging boots the bundled runtime in an isolated home and requires the client document to return HTTP 200. The final Electron/ASAR executable must repeat a real Session acceptance with synthetic model and approval answers. Runtime module resolution uses the Desktop Host dependency closure, including its private policy plugin; the CLI-only closure would omit Host overlay dependencies. Both allowed exact edits and rejected operations are checked against actual file effects before release.

## Alternatives considered

Keeping the old image deployment would duplicate upstream runtime ownership and repeat disk work. A fixed splash duration penalizes fast machines. Relying only on a preparation guard leaves a prepare-to-dispatch unload window; placing revocation solely in a replaceable wrapper signal leaves another bypass. Re-running all preparation guards would consume single-use approvals twice.

## Consequences

The core runtime no longer installs into user storage at first launch. Particle motion continues only while startup needs the window. Model review adds request latency and cost, but cannot loosen deterministic file protections. Host-owned prepare, final-dispatch and commit checks persist after plugin unload. The policy still trusts loaded code and the filesystem provider and does not create an OS-level atomic file capability. Tests cover policy replacement, wrapper signal replacement, exact approvals, real packaged CLI review, and deterministic browser particle input/teardown.
