# Architecture decision records

Each significant design decision in this repository is recorded here, before the code that depends on it merges.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-product-base.md) | This repository is the UJIRA product base | accepted |

## Adding one

1. Open an issue for the decision.
2. Copy the section headings of the latest ADR into `NNNN-short-title.md`, with the next number.
3. Give the problem, at least two options with their trade offs, the decision and why, the exact interfaces, failure modes, data rules, the test strategy, rollout and rollback, evidence marked measured, referenced or assumed, why the other options lost, consequences, and the signal that would make us revisit it.
4. Add it to the table above and open a pull request that closes the issue.

An accepted ADR is not edited to change its decision. A later ADR supersedes it, and both are marked.
