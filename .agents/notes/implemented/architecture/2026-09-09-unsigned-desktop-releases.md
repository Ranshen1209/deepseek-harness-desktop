# Agent Note: Unsigned Desktop release artifacts

Status: implemented

English | [中文](2026-09-09-unsigned-desktop-releases.zh.md)

## Problem

Desktop packaging needs a repeatable macOS and Windows test path before Developer ID, notarization, and hardware-backed Windows signing are available. The signed release path must keep its existing identity checks and must not publish a test artifact through the update channel.

## Decision

The Electron builder accepts `DSH_DESKTOP_UNSIGNED=1` as an explicit test mode. macOS uses an ad-hoc identity, skips seed Mach-O rewriting, notarization, and signature verification, and creates DMG and ZIP artifacts. Windows disables token signing and creates an NSIS installer. Unsigned builds omit generic-provider update metadata and do not write the target completion record used by the COS uploader.

The application icon is generated from `apps/desktop/build/icon.svg`, which contains the supplied DeepSeek mark on a white rounded background. The icon generator renders one 1024×1024 PNG and uses `png2icons` to produce the macOS ICNS and Windows ICO resources. Electron-builder selects the platform resource explicitly, while Linux uses the PNG source.

The Windows ICO receives a full-bleed rounded white backing during generation. The source artwork keeps its Apple-style inset, while the Windows resource avoids a second shell scaling pass shrinking the visible icon.

GitHub Actions builds unsigned macOS arm64 and Windows x64 artifacts on native runners. A manual run or `desktop-v*` tag creates a GitHub Release and uploads the installers. The workflow never receives signing credentials, and the signed path remains the default when the flag is absent.

The Windows runtime preparation extracts the pinned Node.js ZIP with the runner's `tar` implementation. This avoids a pending archive read stream observed in native Windows CI while preserving the same checksum and executable verification steps.

## Alternatives considered

**Wait for release certificates.** This prevents local GUI testing and delays cross-platform packaging validation. The explicit test mode keeps the credentialed path unchanged while making the missing trust chain visible to users.

**Use one platform-neutral PNG without ICNS or ICO conversion.** Electron-builder can sometimes convert a PNG, but platform-specific resources are more predictable in installers and keep the source artwork separate from generated binaries.

**Publish unsigned artifacts through the existing updater.** An unsigned package cannot satisfy the release verification promises and could replace a signed installation with a package Gatekeeper or SmartScreen rejects. Test artifacts therefore have no updater metadata or upload record.

## Consequences

Unsigned macOS packages can trigger Gatekeeper warnings and unsigned Windows installers can trigger SmartScreen warnings. They are suitable for local testing and GitHub Release distribution to testers, not for a trusted production update channel. Generated binary resources must be regenerated when the SVG changes; the repository keeps the generator, source artwork, and lockfile entry together.
