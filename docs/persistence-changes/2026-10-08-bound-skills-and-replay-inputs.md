---
description: "Frozen Skill delivery and explicit replay input selection and path mapping."
kind: persistence-change
---

# Bound methods and replay inputs

Compatibility decision: same-version. The existing user/message event gains an
additive task-skills source with form=instructions and the names actually
delivered. Worker bodies come from their Run's frozen Skill binding. Visible
messages survive resume; compaction that removes them permits reinjection.
Review skillFit.loaded includes these real messages without adding tool calls.
Older Sessions and reviews retain their meaning and are read unchanged.

Frozen experiment snapshots gain optional paths and rebaseFrom fields, included
in their identity digest and retained on resume. Omission preserves the existing
whole-directory content digest and contract behavior. paths selects relative
files/subdirectories. rebaseFrom maps declared workspace paths into each side's
contract and measurement commands. Original Tasks, protected content identities,
and frozen evaluation plans stay fixed. Saved measurement commands record the
mapped execution, and both report validation and promotion reconstruct the same
mapping. Input file contents and embedded script/binary paths are unchanged.

Scoped Evolution services now resolve through their original owner/cache. This
changes no ledger fields, statuses, commit rules or event kinds.
