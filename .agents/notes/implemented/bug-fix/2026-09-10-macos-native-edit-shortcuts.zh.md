# Agent Note: 恢复 macOS 原生快捷键

Status: implemented

[English](2026-09-10-macos-native-edit-shortcuts.md) | 中文

## Problem

替换 Electron 的默认应用菜单而不保留编辑和窗口角色，会移除 macOS 原生 Command 快捷键。

## Decision

Desktop shell 在 macOS 上使用 Electron 的 `fileMenu`、`editMenu` 和 `windowMenu` 角色，并在应用菜单中加入隐藏、隐藏其他应用和全部显示角色。Electron 提供编辑操作、焦点路由和原生 Command 快捷键。顶层标签由 Desktop 语言字典管理。Windows 保留现有菜单模板。

## Alternatives considered

**在渲染器中处理每个按键或注册全局快捷键。** 渲染器监听器会重复实现原生编辑行为和焦点路由。全局快捷键会占用应用外的按键。Electron 菜单角色将快捷键限定在活动应用及焦点窗口内。

## Consequences

locale 和菜单测试覆盖两个 macOS 菜单快照及 Windows 菜单。原生按键传递需要运行 macOS Electron 应用；模板快照本身不能验证操作系统按键事件。
