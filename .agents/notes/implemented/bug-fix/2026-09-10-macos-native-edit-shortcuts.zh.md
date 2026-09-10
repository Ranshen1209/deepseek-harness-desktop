# Agent Note: 恢复 macOS 原生编辑快捷键

Status: implemented

## Problem

macOS Electron 应用只暴露了应用菜单。没有标准 Edit 菜单时，Command+C、Command+V、Command+X、Command+A、Command+Z 和 Command+Shift+Z 等 Chromium 编辑命令不会注册为原生菜单角色。

## Decision

Desktop shell 为 macOS 增加仅限平台的 Edit 菜单，并使用 Electron 的 `undo`、`redo`、`cut`、`copy`、`paste` 和 `selectAll` 角色。Electron 为这些角色提供平台原生标签和 Command 快捷键。Windows 保留现有应用菜单，因为报告的问题只出现在 macOS 菜单栏。

## Verification

Desktop 菜单测试会断言 macOS Edit 菜单角色以及现有应用菜单行为。修改后的 locale 和菜单定向测试已通过。
