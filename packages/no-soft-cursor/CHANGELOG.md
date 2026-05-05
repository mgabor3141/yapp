# pi-no-soft-cursor

## 1.0.2

### Patch Changes

- 18f2c99: Align `@mariozechner/pi-coding-agent` (and `@mariozechner/pi-tui` for `pi-no-soft-cursor`) `devDependency` to `^0.63.0`.

  `devDependency`-only update; no runtime change. Published `dist/*.d.ts` may reference newer upstream types from pi 0.63 (e.g. the `signal` property on `ExtensionContext`), so consumers writing extensions against these packages should be on pi ≥ 0.63 to match. Required to keep `tsup --dts` working alongside `pi-budget-model`, which now depends on the 0.63 registry API.

- 11bb9d3: Keep the soft cursor visible while the editor's autocomplete (e.g. the `@`-file picker) is open, so the cursor doesn't disappear when no hardware-cursor marker is emitted (#45).

## 1.0.1

### Patch Changes

- 09aa3bb: Make soft-cursor removal work even when other extensions replace pi's editor component.
