---
"pi-bash-bg": patch
"pi-bash-trim": patch
"pi-desktop-notify": patch
"pi-enclave": patch
"pi-jujutsu": patch
"pi-no-soft-cursor": patch
---

Align `@mariozechner/pi-coding-agent` (and `@mariozechner/pi-tui` for `pi-no-soft-cursor`) `devDependency` to `^0.63.0`.

`devDependency`-only update; no runtime change. Published `dist/*.d.ts` may reference newer upstream types from pi 0.63 (e.g. the `signal` property on `ExtensionContext`), so consumers writing extensions against these packages should be on pi ≥ 0.63 to match. Required to keep `tsup --dts` working alongside `pi-budget-model`, which now depends on the 0.63 registry API.
