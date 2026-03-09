---
"pi-safeguard": major
---

Replace pattern matching with signal-based flagging. The flagger is now a wide-net boolean gate (high recall, no reasoning); the judge sees raw actions only — no flagger bias.

Broadened sensitive file detection beyond `.env*`: files outside cwd, dotfiles in `$HOME`, system paths, paths with secret keywords.

New signals: `rm -r`/`rm -f` flagged independently, inline code interpreters (`eval`, `bash -c`, `python -c`, `node -e`), `chmod u+s`/`g+s`, `su`/`doas`/`pkexec`, private key material, known API key formats.
