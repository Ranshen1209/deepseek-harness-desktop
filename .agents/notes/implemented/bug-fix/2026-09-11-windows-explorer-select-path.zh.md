# Agent Note: Windows 资源管理器显示使用单参数 `/select,<path>`

Status: implemented

[English](2026-09-11-windows-explorer-select-path.md) | 中文

## Problem

交付文件卡片上的「在文件资源管理器中显示」/ “Show in File Explorer” 在 Windows 上点击无效果。同一菜单的「用默认应用打开」仍然有效。macOS 的在 Finder 中显示不受影响。

## Decision

[`revealNativePath`](../../../../packages/util/native-command/src/path-opener.ts) 以单个 argv 元素 `/select,<windows-path>` 启动 `explorer.exe`。WSL 仍先经 `wslpath -w` 转换。资源管理器的 `/select` 开关要求逗号后紧跟 Windows 文件系统路径；`CreateProcess` 把 `/select,` 与路径分成两个参数会插入空格，而 `file://` URI 也不是合法的 `/select` 对象。这两种形式都可能以退出码 1 结束，本函数已把该退出码当作已转交请求，于是 Host 报告成功而资源管理器没有任何窗口。默认应用打开仍走 PowerShell `Invoke-Item`。缺失文件仍在 present-open 的 Host 路径校验处失败，与 Finder 拒绝缺失目标一致。

## Alternatives considered

**继续把 `file://` URI 作为第二个参数。** 这种编码本想保住路径中的逗号。资源管理器并不把 file URI 当作 `/select` 对象，因此所有显示操作都会失败，包括不含逗号的路径。

**写成 `/select,"<path>"` 或设置 `windowsVerbatimArguments`。** `execFile` 单个参数里的额外引号会被 libuv 再次转义；逐字命令行又要给共享运行器开特例。无额外引号的 `/select,<path>` 是 Node spawn 对普通 Windows 路径的结果，也是资源管理器在逗号之后解析的形式，其中可以包含空格。

**让 Desktop 的显示操作改走 Electron `shell.showItemInFolder`。** 该 API 使用 `SHOpenFolderAndSelectItems`，但 CLI 与非 Electron Host 仍会停在损坏的 argv 上。Host 打开器才是共用路径。

**通过 PowerShell `Start-Process` 显示。** 默认应用打开已经使用 PowerShell，但 `Start-Process -ArgumentList` 会按空格拆分，除非包成单元素数组；PowerShell 调用本机命令时还会把逗号当作参数分隔符。直接调用 `explorer.exe` 可避开该解析器。

## Consequences

注入运行器的测试固定 Darwin 的 `open -R`、Linux 对上层目录的 `xdg-open`、WSL 转换加上 `/select,<windows-path>`，以及含空格、非 ASCII 名称、`#`、`%` 和 UNC 路径时的单参数 Explorer 形式。原生窗口是否选中文件仍由 Windows 桌面负责；这一确认不能证明资源管理器已选中该文件。资源管理器自身的逗号分隔仍然存在：路径中的逗号仍可能截断 `/select` 对象。该情况不再改编码为 URI。
