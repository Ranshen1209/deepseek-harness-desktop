# Agent Note: Restore macOS native editing shortcuts

Status: implemented

## Problem

The macOS Electron application exposed only its application menu. Without a standard Edit menu, Chromium editing commands such as Command+C, Command+V, Command+X, Command+A, Command+Z, and Command+Shift+Z were not registered as native menu roles.

## Decision

The Desktop shell adds a macOS-only Edit menu with Electron's `undo`, `redo`, `cut`, `copy`, `paste`, and `selectAll` roles. Electron supplies the platform-native labels and Command accelerators for these roles. Windows keeps its existing application menu because the reported defect is specific to the macOS menu bar.

## Verification

The Desktop menu tests assert the macOS Edit menu roles and the existing application menu behavior. The focused locale and menu tests pass after the change.
