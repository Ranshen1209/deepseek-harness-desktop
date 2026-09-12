# Agent Note: Windows Explorer reveal preserves visibility and quoted paths

Status: implemented

English | [中文](2026-09-11-windows-explorer-select-path.zh.md)

## Problem

The delivery-card action “Show in File Explorer” does nothing on Windows while “Open in default app” works. Native observation shows that direct `execFile` with `windowsHide: true` hides even a correctly selected window. Automatic quoting around the entire `/select,<path>` argument also prevents paths with spaces or commas from being selected; forward-slash paths fail too. Explorer exit 1 cannot distinguish these failures from a successful handoff.

## Decision

[`revealNativePath`](../../../../packages/util/native-command/src/path-opener.ts) uses PowerShell `Start-Process` to hand Explorer one `/select,"<windows-path>"` argument string. The shared runner hides the PowerShell console while Explorer remains visible. Windows separators and quotes around the path preserve spaces and commas. A PowerShell single-quoted literal with doubled apostrophes prevents evaluation of filename contents. WSL translates through `wslpath -w` before the same Windows handoff. PowerShell launcher failures reject, including exit 1; successful launch acknowledges an asynchronous desktop request.

Default-app opening remains on `Invoke-Item`. The present-open Host path check rejects missing targets before launch. macOS and desktop Linux retain their existing file-manager commands.

## Alternatives considered

**Direct `execFile` with `windowsHide: false` and `windowsVerbatimArguments`.** Native Windows selection works when the path alone is quoted, but this extends the shared runner and requires a separate WSL interop policy. PowerShell is already required by Windows default-app opening and accepts the same literal argument string from both Hosts.

**A `file://` URI or a separate path argument.** URI encoding was intended to preserve commas, but Explorer does not accept a file URI as its `/select` object. Splitting the switch and path inserts whitespace outside the path quotes. One `Start-Process -ArgumentList` string preserves the switch, comma, and path quotes.

**Electron `shell.showItemInFolder`.** Its native `SHOpenFolderAndSelectItems` integration fixes only the Electron path. Keeping the fix in the Host opener also covers CLI and non-Electron Hosts.

## Consequences

Injected-runner tests cover platform dispatch, WSL translation, Windows and UNC literals, launcher errors, and cancellation. The [interactive Windows smoke](../../../../packages/util/native-command/tests/reveal.windows.e2e.ts) observes visible windows and selected files for ordinary paths, Chinese names, spaces, commas, apostrophes, metacharacters, and forward slashes. It resolves temporary 8.3 paths before comparing Explorer's expanded paths and closes only its own windows. Live WSL and network-share selection remain environment-owned verification gaps. The operation waits for launcher acknowledgement, not the lifetime of Explorer.
