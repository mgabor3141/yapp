# Development

## Setup

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

## Releasing

Releases are managed with [changesets](https://github.com/changesets/changesets) and published to npm via OIDC trusted publishing (no npm token required in CI).

### 1. Include a changeset in your PR

When your PR changes package behavior, add a changeset:

```bash
pnpm changeset
```

This prompts you to select which packages changed, the semver bump type (major/minor/patch), and a summary. It creates a markdown file in `.changeset/` that you commit alongside your code. Reviewers can see the proposed bump and changelog entry in the diff.

You can also create the file manually:

```md
---
"pi-budget-model": patch
---

Fixed model selection for Anthropic provider
```

### 2. Merge your PR

Once merged to `main`, the release workflow sees changeset files and opens (or updates) a "Version Packages" PR. That PR bumps versions in `package.json`, writes `CHANGELOG.md` entries, and removes the consumed changeset files.

Multiple PRs with changesets accumulate — the Version Packages PR collects them all.

### 3. Merge the Version Packages PR

Review the version bumps and changelog entries, then merge. The workflow runs again and publishes new versions to npm via OIDC.

### Trusted publishing

The release workflow uses GitHub Actions OIDC (`id-token: write` permission) to authenticate with npm. No `NPM_TOKEN` secret is needed. Each package must have a trusted publisher configured on npmjs.com:

- **Owner:** `mgabor3141`
- **Repository:** `yapp`
- **Workflow:** `release.yml`
- **Environment:** (blank)

### Notes

- `changeset publish` only publishes packages whose version is newer than what's on npm.
- The `workspace:*` dependency protocol is rewritten to real version ranges at publish time.
- Provenance attestations are generated automatically when publishing via OIDC.
