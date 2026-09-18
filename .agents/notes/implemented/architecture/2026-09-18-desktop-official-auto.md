# Agent Note: Desktop adopts official Auto review

Status: implemented

English | [中文](2026-09-18-desktop-official-auto.zh.md)

## Problem

The custom preservation reviewer and execution adapters introduced service-injection failures and rejected native deliverable and child-task tools. Extra approval and file-policy ownership prevented ordinary Agent tasks from completing. The user selected the official Auto behavior instead of further custom policy development.

## Decision

Desktop activates the official experimental auto-review package through its existing composition row. Its review source, response protocol, reasoning defaults, Full access execution and cancellation behavior remain unchanged. The custom package is removed from the desktop production dependency closure and build steps. Dormant optional filesystem and shell events have no custom listener; existing native execution remains their fallback. The official package's [decision](../feature/2026-08-28-auto-review.md) owns the review semantics.

This decision supersedes the custom Auto choice in [the earlier desktop note](2026-09-18-desktop-native-auto-approval.md). Persisted preservation selections resolve to Custom and require an explicit choice. Desktop's remaining admission check only stops unresolved saved permission states; it does not review or restrict official Auto tools. The official enablement confirmation remains visible. New-session defaults remain native.

Workspace selection/error handling, startup visuals, Explorer reveal and native approval notification transport remain unchanged. Existing session event readers retain compatibility with prior custom records without reactivating their writer or policy.

## Alternatives considered

**Continue custom Auto repair.** The user stopped this route after runtime failures across normal tools.

**Rename the custom implementation to official Auto.** This would preserve the incompatible execution behavior and misrepresent the implementation being tested.

## Consequences

Official model approval leads to Full access without a human fallback. Custom recovery, deterministic file protection and forced max reasoning are absent; the model can misclassify and operating-system permissions still apply. The native three modes retain their original execution rules.

Focused tests cover official review and retired permission admission. Packaged deterministic smokes exercise native reads, searches, writes, shell, deliverables and child review. Real model planning, GUI confirmation, notification delivery and installation upgrades remain separate acceptance scopes; the release evidence records which checks actually ran.
