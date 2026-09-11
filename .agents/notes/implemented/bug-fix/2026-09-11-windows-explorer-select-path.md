# Agent Note: Windows Explorer reveal uses `/select,<path>` as one argument

Status: implemented

English | [中文](2026-09-11-windows-explorer-select-path.zh.md)

## Problem

The delivery-card action “Show in File Explorer” / “在文件资源管理器中显示” does nothing on Windows. “Open in default app” on the same menu still works. macOS Reveal in Finder is unaffected.

## Decision

[`revealNativePath`](../../../../packages/util/native-command/src/path-opener.ts) launches `explorer.exe` with one argv element `/select,<windows-path>`. WSL still translates through `wslpath -w` first. Explorer's `/select` switch takes a Windows filesystem path immediately after the comma; `CreateProcess` joining `/select,` and the path as two arguments inserts a space, and a `file://` URI is not a valid `/select` object. Either form can exit 1, which this function already treats as a delegated handoff, so the Host reports success while Explorer shows nothing. Default-app open stays on PowerShell `Invoke-Item`. Missing files still fail at the present-open Host path check before this launch, matching Finder's refusal of a missing target.

## Alternatives considered

**Keep a `file://` URI as a second argument.** That encoding was meant to survive commas in the path. Explorer does not treat a file URI as a `/select` object, so every reveal fails, including paths without commas.

**Quote `/select,"<path>"` or set `windowsVerbatimArguments`.** Extra quotes inside one `execFile` argument are re-escaped by libuv; verbatim command lines would special-case the shared runner. The unquoted `/select,<path>` form is what Node spawn produces for ordinary Windows paths and is what Explorer parses after the comma, including spaces.

**Route Desktop reveals through Electron `shell.showItemInFolder`.** That API uses `SHOpenFolderAndSelectItems` and would leave CLI and non-Electron Hosts on the broken argv. The Host opener is the shared path.

**Reveal through PowerShell `Start-Process`.** Default-app open already uses PowerShell, but `Start-Process -ArgumentList` splits on spaces unless wrapped as a one-element array, and PowerShell's native call syntax treats commas as argument separators. Direct `explorer.exe` avoids that parser.

## Consequences

Injected-runner tests pin Darwin `open -R`, Linux `xdg-open` of the parent, WSL translation plus `/select,<windows-path>`, and the one-argument Explorer form for spaces, non-ASCII names, `#`, `%`, and UNC paths. Native window selection still belongs to a Windows desktop; this acknowledgement is not proof that Explorer selected the file. Explorer's own comma delimiter remains: a comma in the path can still truncate the `/select` object. That case is not re-encoded as a URI.
