# Agent Note: 自动上游 Desktop 同步

Status: implemented

[English](2026-09-10-upstream-desktop-sync.md) | 中文

## Problem

本仓库是 `deepseek-ai/deepseek-harness` 的完整副本，外加 `apps/desktop`、`apps/desktop-host` 与桌面 GitHub Actions 中的 Electron 打包。它不是 GitHub fork，因此不会自动收到上游 `dsh-v*` tag，其 Git 历史也不与上游共享 merge-base。未签名桌面 GitHub Release 已经通过 [desktop-release.yml](../../../../.github/workflows/desktop-release.yml) 由 `desktop-v*` tag 启动。否则维护者必须手工导入每个上游 tag，并避免从仍有冲突的树发布 Release。

## Decision

[upstream-desktop-sync.yml](../../../../.github/workflows/upstream-desktop-sync.yml) 每六小时运行一次，也可通过 `workflow_dispatch` 触发。它选择最新的上游 `dsh-v*` tag，或派发输入中给出的 tag。[upstream-desktop-sync.ts](../../../../scripts/upstream-desktop-sync.ts) 在 origin 已有 `desktop-v{same-semver-suffix}`，或默认分支已记录该版本的 `Upstream-Tag: dsh-v…` 时跳过本次运行。

导入使用带显式 merge-base 的 `git merge-tree --write-tree`：优先使用本仓库中仍可解析的最近一次已导入上游 tag，否则使用本仓库的根提交。因为两段历史无关联，所以必须指定该祖先。应用结果 tree 之后，脚本从 HEAD checkout overlay 允许列表，并补回根 `package.json` 中缺失的桌面 script 键。overlay 路径包括未签名发布 workflow、本同步 workflow、生成的桌面图标、本地菜单 fixture、本同步脚本以及 GitHub Release 安装包上传脚本。整个 `apps/desktop/**` 不是 overlay：上游拥有 Electron 壳，这些文件走普通三方合并。

当冲突只出现在 overlay 路径时，脚本快进默认分支并推送附注 `desktop-v*`。该 tag 就是现有 Desktop 发布触发器；本 workflow 不打包 Electron。推送 tag 之后，脚本会列出该 tag 上的 `desktop-release.yml` 运行记录，若没有已启动的运行则在该 tag ref 上派发该 workflow，因此 `GITHUB_TOKEN` 推送仍会打包。只要有非 overlay 路径冲突，脚本可以调用 Anthropic（优先使用 `ANTHROPIC_API_KEY`）或 OpenAI（`OPENAI_API_KEY`）编辑剩余冲突标记，然后打开 draft pull request，并且不打 tag、不派发。AI 成功也不改变这条规则。

`DESKTOP_SYNC_TOKEN` 或 `GH_PAT` 应为具有 contents、pull requests、workflow 与 actions 权限的 PAT。具有 workflow 权限的 PAT 通常会由 tag 推送直接启动 Desktop release；若没有匹配运行，则回退到派发。人工合并冲突 pull request 之后，需要自行推送 `desktop-v*` 才会发布。

## Alternatives considered

**把本仓库改成 GitHub fork 并 rebase 到上游。** GitHub fork 同步会跟随上游历史，但此副本已有不相关的根提交和仅属于桌面的 tag。改造成 fork 会重写现有每个 `desktop-v*` 对象以及当前 GitHub Release URL 空间。

**即使干净合并也为每次导入打开 pull request。** 这会给每个上游发布增加人工等待。干净的三方结果加上 overlay 恢复是确定性的，因此可以快进并打 tag。仍有冲突或经过 AI 处理的树仍然停在 pull request。

**把全部 `apps/desktop/**` 视为 ours。** 上游同样发布该 Electron 打包树。在每个桌面路径保留 ours 会丢掉上游壳与 seed 修复。overlay 允许列表只包含此副本独有、或未签名 Release 必须保留的文件。

**再写一套 Electron 打包 workflow，而不推送 `desktop-v*`。** [desktop-release.yml](../../../../.github/workflows/desktop-release.yml) 已经构建 macOS arm64 与 Windows x64 未签名产物。并行发布路径会与它偏离。

**每次干净 tag 都派发 Desktop release，而不先列出已有运行。** 具有 workflow 权限的 PAT 已经会由 tag 推送启动打包。无条件派发会把该 workflow 跑两遍。先列出、仅在没有针对该 tag 的运行时再派发，既能覆盖 `GITHUB_TOKEN` 推送，又不会让 PAT 运行加倍。

## Consequences

当合并干净时，定时导入可以在无人值守的情况下发布 GitHub Release。有冲突的导入不能。 [upstream-desktop-sync.ts](../../../../scripts/upstream-desktop-sync.ts) 列出的 overlay 文件在上游删除后仍会保留；此副本旧快照中独有的其他文件跟随上游，并可能消失。合并冲突 pull request 的操作者必须再推送 `desktop-v*`，测试者才能看到安装包。
