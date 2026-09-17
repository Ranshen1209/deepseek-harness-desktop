---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-18-auto-native-authorization

English | [中文](2026-09-18-auto-native-authorization.zh.md)

## Summary

Records Auto review inputs, exact-call authorization summaries and committed file identities; approval cards can carry a structured model execution explanation.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing approval records remain valid because the review explanation is optional. The three new event types are required-on-read and are declared by the host approval package. They are audit facts, not executable grants: reloading a session does not restore one-time approval tickets or the in-memory file registry. Older builds that do not know these events refuse the session log.

<a id="verification"></a>
## Verification

Focused approval, permission migration, notification and UI navigation tests passed (118 tests in seven suites in independent review). The plugin unit suite passed 317 tests with three platform skips. Real-model, packaged-application, GUI, installed-profile and VM acceptance are deferred to the user; these unit results do not establish end-to-end acceptance.

<a id="dev-note"></a>
## Dev Note

None.
