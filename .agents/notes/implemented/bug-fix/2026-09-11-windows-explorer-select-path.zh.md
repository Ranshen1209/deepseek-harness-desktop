# Agent Note: Windows 资源管理器显示保留窗口可见性和路径引号

Status: implemented

[English](2026-09-11-windows-explorer-select-path.md) | 中文

## Problem

Windows 上交付卡片的“在文件资源管理器中显示”没有反应，而“在默认应用中打开”正常。原生观察表明，直接使用 `execFile` 且设置 `windowsHide: true` 会隐藏已正确选中文件的窗口。整个 `/select,<path>` 参数外层的自动引号还会导致含空格或逗号的路径无法选中；正斜杠路径也会失败。Explorer 退出码 1 无法区分这些失败与成功转交。

## Decision

[`revealNativePath`](../../../../packages/util/native-command/src/path-opener.ts) 通过 PowerShell `Start-Process` 向 Explorer 传递单个 `/select,"<windows-path>"` 参数字符串。共享运行器隐藏 PowerShell 控制台，资源管理器保持可见。Windows 分隔符和路径两侧的引号保留空格与逗号。PowerShell 单引号字面量将内部单引号加倍，防止文件名内容被求值。WSL 先通过 `wslpath -w` 转换，再使用同一 Windows 转交方式。PowerShell 启动器失败会报错，包括退出码 1；成功启动只确认异步桌面请求已转交。

默认应用打开仍使用 `Invoke-Item`。present-open Host 路径检查在启动前拒绝不存在的目标。macOS 与桌面 Linux 保持原有文件管理器命令。

## Alternatives considered

**直接使用 `execFile`，设置 `windowsHide: false` 与 `windowsVerbatimArguments`。** 仅为路径加引号时，原生 Windows 选中操作可以成功，但需要扩展共享运行器，并为 WSL 互操作另定策略。Windows 默认应用打开已依赖 PowerShell，两种 Host 可以传递同一字面参数字符串。

**使用 `file://` URI 或独立路径参数。** URI 编码原本用于保留逗号，但 Explorer 不接受文件 URI 作为 `/select` 对象。拆开开关与路径会在路径引号外插入空白。单个 `Start-Process -ArgumentList` 字符串可完整保留开关、逗号和路径引号。

**使用 Electron `shell.showItemInFolder`。** 其原生 `SHOpenFolderAndSelectItems` 集成只能修复 Electron 路径。修复保留在 Host 打开器中，也能覆盖 CLI 和非 Electron Host。

## Consequences

注入运行器测试覆盖平台分派、WSL 转换、Windows 与 UNC 字面参数、启动器错误和取消。[交互式 Windows 验证](../../../../packages/util/native-command/tests/reveal.windows.e2e.ts) 检查普通路径、中文名称、空格、逗号、单引号、元字符和正斜杠路径对应的窗口可见性及文件选中状态。它先解析临时目录的 8.3 短路径，再与资源管理器展开后的路径比较，并只关闭自身窗口。真实 WSL 与网络共享选中行为仍需相应环境验证。操作等待启动器确认，不等待 Explorer 窗口关闭。
