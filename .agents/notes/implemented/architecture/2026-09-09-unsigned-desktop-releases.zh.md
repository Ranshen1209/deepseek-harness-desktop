# Agent Note: 未签名 Desktop 发布产物

Status: implemented

[English](2026-09-09-unsigned-desktop-releases.md) | 中文

## 问题

在 Developer ID、公证和硬件保护的 Windows 签名尚未配置时，Desktop 仍需要一条可重复的 macOS 与 Windows 测试路径。签名发布流程必须保留现有身份校验，也不能把测试产物发布到更新通道。

## 决策

Electron builder 接受 `DSH_DESKTOP_UNSIGNED=1` 作为显式测试模式。macOS 使用 ad-hoc 身份，跳过 seed Mach-O 重写、公证和签名验证，并生成 DMG 与 ZIP 产物。Windows 关闭 Token 签名并生成 NSIS 安装器。未签名构建不写入 generic-provider 更新元数据，也不写入 COS 上传器使用的目标完成记录。

应用图标从 `apps/desktop/build/icon.svg` 生成，该文件把用户提供的 DeepSeek 标志放在白色圆角背景上。图标生成器渲染一张 1024×1024 PNG，并使用 `png2icons` 生成 macOS ICNS 与 Windows ICO 资源。Electron-builder 显式选择各平台资源，Linux 使用 PNG 源文件。

生成 Windows ICO 时会额外使用铺满画布的白色圆角底板，并让用户提供的标志占据约 70% 的画布宽度。源图稿仍保留 Apple 风格的内缩，而 Windows 资源会移除透明边距，让图标在系统图标尺寸下保持清晰可读。

GitHub Actions 在原生 runner 上构建未签名的 macOS arm64 与 Windows x64 产物。手动运行会保留产物；推送 `desktop-v<version>` tag 会在两个目标都通过后发布普通 GitHub Release。tag、根目录、CLI、Desktop、Desktop Host、seed、安装包文件名和原生应用版本元数据必须使用相同的完整上游版本。重命名安装包或去除预发布后缀不能升级其中的 dsh。workflow 先向草稿上传全部安装包和 SHA-256 校验文件，再将其发布为 latest。GitHub Release 状态与上游稳定性及签名无关；workflow 不接收签名凭据，没有该标志时仍使用签名流程。

Windows 运行时准备使用 runner 自带的 `tar` 解压固定版本的 Node.js ZIP。这样可以避免原生 Windows CI 中观察到的归档读取流悬挂，同时保留相同的校验和与可执行文件验证步骤。

## 考虑过的替代方案

**等待发布证书。** 这会阻止本机 GUI 测试并延迟跨平台打包验证。显式测试模式保持凭据流程不变，同时让用户看到缺少信任链的事实。

**只使用一张平台无关的 PNG，不转换 ICNS 或 ICO。** Electron-builder 有时可以从 PNG 转换，但在安装器中使用平台专用资源更可预测，也能把源图稿与生成的二进制分开。

**通过现有更新器发布未签名产物。** 未签名包无法满足发布验证承诺，也可能让已签名安装被 Gatekeeper 或 SmartScreen 拒绝的包替换。因此测试产物不包含更新元数据和上传记录。

## 后果

未签名 macOS 包可能触发 Gatekeeper 警告，未签名 Windows 安装器可能触发 SmartScreen 警告。它们适合本机测试和向测试人员分发，不适合作为受信任的生产更新通道。SVG 变更后必须重新生成二进制资源；仓库会把生成器、源图稿和锁文件条目一起保留。
