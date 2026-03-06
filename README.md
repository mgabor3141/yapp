# yap

**y**et **a**nother **p**i extension package

```bash
pi install \
  pi-safeguard \
  pi-bash-trim \
  pi-desktop-notify
```

## Extensions

| Package | Description |
|---------|-------------|
| [pi-safeguard](packages/safeguard/) | LLM-as-judge guardrail — auto-reviews dangerous commands and sensitive file access |
| [pi-bash-trim](packages/bash-trim/) | Smart bash output trimming — wide lines and long output trimmed to fit LLM context |
| [pi-desktop-notify](packages/desktop-notify/) | Desktop notifications with focus tracking and click-to-focus |

## Libraries

| Package | Description |
|---------|-------------|
| [pi-budget-model](packages/budget-model/) | Auto-select the cheapest available model for background tasks. Used internally by pi-safeguard; useful for extension authors who need a lightweight model for behind-the-scenes work. |

Install via `npm install pi-budget-model` — this is a library, not a pi extension.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

## Releasing

```bash
pnpm changeset        # describe your changes
pnpm version          # bump versions and generate changelogs
pnpm release          # build and publish to npm
```

## License

MIT
