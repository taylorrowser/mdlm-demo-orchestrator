# Issue 24 parent red evidence

Captured at `2026-08-27T16:11:27Z` in a detached worktree of the exact parent. The new test file was copied over the parent's `test/preflight.test.mjs` before the command ran. No source file from the candidate was copied.

- Parent commit: `ffd5e70c545449850900ec8ceaae68c18aaf17b0`
- Parent tree: `5d018ceadb2fafefcb464e1ceb5418f2d0d80c3e`
- Test path during the run: `test/preflight.test.mjs`
- Preserved test bytes: `preflight.test.mjs`
- Test bytes: 24,215
- Test SHA-256: `2e98c3e2a2de487eaff9139213b7d62544dcd5bbae3860df7837998e46131088`
- Working directory: detached worktree root for the parent commit
- Command: `node --test test/preflight.test.mjs`
- Exit status: `1`
- Standard output: `stdout.tap`, 30,510 bytes, SHA-256 `55330549043247658ededcb725166e6abf261869769c7f282c7b3fd953fd2895`
- Standard error: `stderr.log`, 0 bytes, SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- Exit-status record: `exit-status.txt`, 2 bytes, SHA-256 `4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865`

This is failing evidence only. It does not establish that the tests are sufficient or that later code passes them.
