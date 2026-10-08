---
description: "Additive graph metrics, method-library isolation and auxiliary-model usage."
kind: persistence-change
---

# Graph library and metrics

Compatibility decision: same-version. Graph RSI config gains optional `metrics: string[]`; missing metrics remain absent. The launch API normalizes omitted rounds/review to 3/false before persistence. Existing graph records and frozen task objectives keep their meaning.

Graph library paths derive from the immutable root session identity. New Run catalog/provider bindings use the graph library; stored older Run directories continue to identify their original catalog. Direct host APIs with no session retain their explicitly configured catalog. New graphs import generic coordination guidance once, and agents author domain templates and Skills inside their graph. The small version-1 library index is a projection of existing TaskTemplate JSON and SKILL.md assets, with temporary/retained/retired review status. It adds no Session event kind.

First Skill publication records `skillBaseline: null` and compares real absent/present methods under identical contracts. Apply and rollback use the same graph production root as worker discovery. Optional generated-plan and judge token usage fields record actual auxiliary model responses; older experiments without usage remain readable with unknown auxiliary cost.

The four Session event root declarations retain their existing fingerprints. The persistence checker passes; these changes concern transitively referenced additive fields and graph-local assets.
