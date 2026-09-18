# Agent Note: Desktop native permissions and per-call Auto

Status: implemented

English | [中文](2026-09-18-desktop-native-auto-approval.zh.md)

## Problem

Global Auto interception renamed native choices without restoring their behavior, and a missing independent executor blocked entire command classes after apparently useful approvals. The resulting Agent could write a file yet fail every verification path. Human approval and execution need one owner for the exact call.

## Decision

Desktop keeps the native three presets and uses preservation for Auto. The [experimental Web Auto](../feature/2026-08-28-auto-review.md) remains a separate opt-in integration with its own semantics; this decision does not replace it. Desktop uses the native workspace-write sandbox plus model review, with explicit Windows partial-protection limits. Normal Shell, installation, builds, tests and bounded file/search tools remain available. A model denial stops without prompting; a recommended wider call requires one human decision, never a standing Full access grant.

Preparation captures the actual provider, resolved process spec, environment, cwd and applicable file versions. Tool and escalation checks share one call record; the native executor validates after confinement and consumes once before spawn. Host lifetime checks preserve Auto ownership across waits, mode switches and plugin reloads. Native calls bypass Auto. Inconsistent saved permission choices wait for explicit reselection instead of expanding authority.

Creation facts come from verified file commits and remain tied to the Agent and current version across approved edits. Search feeds verified content snapshots to the local search process, keeping reviewed file paths out of its open operations. Ordinary script effects depend on the native sandbox and are not recoverable merely because structured trash exists.

Search capability belongs to the Agent-scoped tool definition. Auto captures the definition and execution function, and rejects replacement before dispatch. A process-global marker from an Agent preset prevents that preset from mounting; it also cannot attest another Agent's search implementation. Preset isolation checks remain in force. Workspace connection failures retain the preceding workspace and draft, expose the actual error, and cannot clear a newer selection attempt.

Only the Host approval service sends typed waiting/ended messages to Electron main. Native notifications disclose a generic operation category, deduplicate by request identity and navigate to a still-pending card. They cannot grant execution. Stopped Host generations and ended requests invalidate old clicks; delivery failure leaves application state intact.

## Alternatives considered

**Require a new independent broker before all commands.** No such broker exists in this release. Blocking normal build and verification work does not meet the selected usability requirement.

**Use model review or command regular expressions as isolation.** Neither constrains runtime filesystem, process or network effects. The UI and documentation retain the actual native backend limits.

**Reuse Full access or global Auto interception.** That merges distinct user choices and makes a mode switch or old saved setting silently change execution authority. Separate modes and exact per-call widening retain explicit intent.

## Consequences

Auto can review normal Agent tasks without human-enumerated filenames. Windows arbitrary-code execution still carries native sandbox limitations; model judgment is fallible. Exact structured-file protection and recoverable single-file removal do not imply general script recovery or freedom from all OS publication races. Runtime file recognition does not become a persistent grant after restart.

Focused file/search, permission migration, approval lifecycle, notification and native launch-protocol tests exercise code without a live provider. Workspace selection is also checked in the local packaged Electron UI with an isolated profile; that check does not qualify model tasks or approval buttons. The user owns real-model planning, actual approval buttons, Windows 10/11 notifications, VM execution and real-user profile upgrade acceptance. A local unsigned package with deferred task acceptance is a candidate, not end-to-end qualification. The [desktop README](../../../../apps/desktop/README.md#user-run-acceptance) owns the repeatable acceptance instructions.
