# Issue 24 invalid parent red attempt

This first attempt ran against parent commit `ffd5e70c545449850900ec8ceaae68c18aaf17b0`, tree `5d018ceadb2fafefcb464e1ceb5418f2d0d80c3e`, with `node --test test/preflight.test.mjs`.

It is not behavioral red evidence. The test module failed to instantiate because the parent did not export `inspectProvenance`; no adversarial assertion ran.

- Preserved test: `preflight.test.mjs`, 24,183 bytes, SHA-256 `08784062b897b86ca5c913a09f03d8643747169a57018e700621a54f4bda52a8`
- Exit status: `1`
- Standard output: `stdout.tap`, 826 bytes, SHA-256 `78332dfd555dba754d6fdcb228a033913c4c981321c8451415701fac9fc5af05`
- Standard error: `stderr.log`, 0 bytes, SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- Exit record: `exit-status.txt`, 2 bytes, SHA-256 `4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865`
