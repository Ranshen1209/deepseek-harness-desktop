---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-18-auto-native-authorization

[English](2026-09-18-auto-native-authorization.md) | 中文

## 概述

记录 Auto 审核输入、绑定具体调用的授权摘要和已提交的文件身份；审批卡片可携带结构化的模型执行说明。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-18-auto-native-authorization
baseline: false
changes:
  - root: "event:approval/asked"
    previous: "2026-09-11-initial"
    after: "52fbb9f07133a77fb34335956bfa727a205466865eef8dbe8b1541b35021936b"
    decision: same-version
  - root: "event:approval/call-authorized"
    previous: null
    after: "488bb08e1eaf13902d28f2608bba77175da5393001004c0d4db545f715d8a56a"
    decision: same-version
  - root: "event:approval/file-committed"
    previous: null
    after: "0b0643e84067bbf99e6a6846d7bed954a876fa7b4b9e70d49c68750603dea945"
    decision: same-version
  - root: "event:approval/review-input"
    previous: null
    after: "c956bf0eae0d4e2745a9a09cc2dce9af81b0c23a61cb235b9f20551d877c6825"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

审核说明是可选字段，因此已有审批记录仍然有效。三个新增事件由宿主审批包声明，读取方必须认识这些事件。它们是审计事实，不是可执行授权：重新加载会话不会恢复单次批准票据或内存文件登记。无法识别这些事件的旧版本会拒绝读取会话日志。

<a id="verification"></a>
## 验证

独立复核运行了审批、权限迁移、通知和界面定位的七个定向套件，118 项测试通过。插件单元测试通过 317 项，三个平台专属项目跳过。真实模型、打包应用、GUI、用户安装升级和虚拟机验收由用户执行；这些单元测试不能代表端到端验收通过。

<a id="dev-note"></a>
## 开发备注

无。
