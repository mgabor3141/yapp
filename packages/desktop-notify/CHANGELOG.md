# pi-desktop-notify

## 1.0.2

### Patch Changes

- 18f2c99: Align `@mariozechner/pi-coding-agent` (and `@mariozechner/pi-tui` for `pi-no-soft-cursor`) `devDependency` to `^0.63.0`.

  `devDependency`-only update; no runtime change. Published `dist/*.d.ts` may reference newer upstream types from pi 0.63 (e.g. the `signal` property on `ExtensionContext`), so consumers writing extensions against these packages should be on pi ≥ 0.63 to match. Required to keep `tsup --dts` working alongside `pi-budget-model`, which now depends on the 0.63 registry API.

## 1.0.1

### Patch Changes

- 70122cd: Clean up package metadata, migrate to Yarn Berry
