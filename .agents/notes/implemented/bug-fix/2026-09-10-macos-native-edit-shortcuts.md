# Agent Note: Restore macOS native shortcuts

Status: implemented

English | [中文](2026-09-10-macos-native-edit-shortcuts.zh.md)

## Problem

Replacing Electron's default application menu without its editing and window roles removes native macOS Command shortcuts.

## Decision

The Desktop shell uses Electron's `fileMenu`, `editMenu`, and `windowMenu` roles on macOS, plus application-menu hide, hide-others, and unhide roles. Electron supplies editing actions, focus routing, and native Command accelerators. Top-level labels belong to the Desktop locale dictionaries. Windows keeps its existing menu template.

## Alternatives considered

**Handle each key in the renderer or register global shortcuts.** Renderer listeners duplicate native editing behavior and focus routing. Global shortcuts consume keys outside the app. Electron menu roles keep shortcuts scoped to the active application and focused window.

## Consequences

The locale and menu tests cover both macOS menu snapshots and the Windows menu. Native keyboard delivery needs a running macOS Electron application; a template snapshot alone does not exercise OS key events.
