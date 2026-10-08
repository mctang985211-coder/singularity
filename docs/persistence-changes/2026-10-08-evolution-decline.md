---
description: "Allow reasoned non-promotion decisions to settle open Evolution proposals."
kind: persistence-change
---

# Evolution proposal settlement

Compatibility decision: same-version. The existing formatVersion-4 decided record
may follow proposed, candidate or prepared when its decision is REJECT or
KEEP_FOR_FURTHER_RESEARCH and its note gives a non-empty reason. The existing
approvalRef remains required. Live writes and restart replay enforce the same
rule. Existing gated decisions keep their meaning; PROMOTE still requires gate,
and only PROMOTE can be applied. No record fields or event kinds change.
