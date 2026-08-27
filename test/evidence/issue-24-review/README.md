# Issue 24 manual review inputs

Captured at `2026-08-27T16:20:55Z`. `AUTOMATION-GAP.md` records why these files are manual inputs rather than an automated review bundle.

## Prior review

- Review agent: `5a042ca1-0981-40f`
- Reviewed commit: `3741ed6a7faa1364bccef1dab8fd61d41793df9c`
- Final output: `prior-review.txt`, 3,024 bytes, SHA-256 `c91997b09bd1614f43c432393a3973042bdafb6b97ccbda5519a8e36133182a1`

## Focused tests

- Command: `node --test test/canonical-file.test.mjs test/decision-catalog.test.mjs test/preflight.test.mjs`
- `test/preflight.test.mjs` SHA-256: `f906a4d8d947b1bf9b48dbf70777fa999bba6c0d22ad9c3ccb0f2d339e0dc754`
- Result: 41 passed, 0 failed
- Exit status: `0`
- Standard output: `focused-tests.stdout`, 3,127 bytes, SHA-256 `a962d8929c5c0253eab6f01e47f6d1e2354396ee53b244f6d1d287a9310f2192`
- Standard error: `focused-tests.stderr`, 0 bytes, SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- Exit record: `focused-tests.exit`, 2 bytes, SHA-256 `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa`

## Syntax check

- Command: `npm run check`
- Exit status: `0`
- Standard output: `check.stdout`, 105 bytes, SHA-256 `a64714b111aee19b5f1c21fa9411ce46d05bb88967f8493a5d33b0f8c5736583`
- Standard error: `check.stderr`, 0 bytes, SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- Exit record: `check.exit`, 2 bytes, SHA-256 `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa`
