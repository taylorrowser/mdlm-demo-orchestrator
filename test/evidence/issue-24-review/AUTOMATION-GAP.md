# Issue 24 review automation gap

The runner repository has no automation that creates an immutable pre-review bundle. Issue #24 owns this gap for this remediation.

The review will use preserved manual inputs: the exact candidate commit and tree, its parent and tree, the Git diff, the focused test command and complete output, `npm run check` output, and the prior failed review identity and output. These are manual review inputs. They are not an automated review bundle.
