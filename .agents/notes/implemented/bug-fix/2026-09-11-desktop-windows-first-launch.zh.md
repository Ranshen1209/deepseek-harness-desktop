# Agent Note: Show Desktop first-launch progress and skip unused seed I/O

Status: implemented

[English](2026-09-11-desktop-windows-first-launch.md) | 中文

## Problem

在 Windows 上，打包后的 Desktop 应用第一次启动可能长时间停在空白桌面。Electron 主进程会在创建窗口之前哈希每个 seed 文件、先列出再解包每个 pnpm store 归档、把该目录复制进 `.dsh/desktop/pnpm/store`、执行离线 `pnpm install`，并对后端做健康检查。Windows Defender 随后扫描每个新写入的文件。即使后续启动已有匹配的 profile，进程仍会在启动后端前哈希不会被使用的 seed，包括大型 store 归档。

staging 后端的启动-停止健康检查仍然必要，这样失败的依赖图就不会替换活跃 profile。

## Decision

启动过程在任何 seed 哈希之前，先比较安装包发布身份与活跃 profile。已安装且匹配的发布只验证该 profile 的本地包集并启动后端。首次安装或升级会打开由 locale 提供文案的进度窗口，然后用流式 SHA-256 哈希 seed 清单，在一次带校验的读取中解包每个 store 归档，并在私有 store 为空时把解包目录移入目标位置。跨设备 rename 回退为复制。已有内容的 store 仍复制文件并以事务方式合并 SQLite `package_index` 记录，从而保留为插件下载的包。归档路径、类型、唯一性、分片和数量检查保持不变。进度窗口会一直显示到产品后端就绪。[打包与更新 Agent Note](../architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md) 仍然拥有 seed 传输、健康检查和激活。

## Alternatives considered

**首次安装跳过 staging 健康检查。** 第一次 startHost 会成为依赖图可启动的唯一证明，但失败的依赖图会已经占据 `.dsh/profiles/desktop`，匹配发布的复用路径也不会重新安装它。

**禁用或排除 Windows Defender。** 应用不能改变用户的杀毒策略。减少多余文件复制并保持界面可响应，是本仓库能拥有的缓解。

**把 `node_modules` 预解包进安装包。** 这会放弃离线 seed 加 pnpm install 模型，使签名产物膨胀，并让差分更新跟踪数万个缓存文件。

**每次启动都哈希完整 seed。** 那只能发现进程在升级前并不会消费的被篡改 seed。完整性仍必须在 seed 内容进入可写桌面状态之前立即执行。

## Consequences

首次安装和升级会显示本地化进度窗口，而不是空白桌面。匹配的后续启动跳过 store 归档 I/O。空 store 的首次启动每个 store 文件只写一次。seed 完整性与归档校验仍在任何 seed 内容合并之前运行。staging 健康检查仍会在激活前启动并停止后端，因此首次安装仍会支付两次后端启动。
