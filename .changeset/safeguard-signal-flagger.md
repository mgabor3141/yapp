---
"pi-safeguard": major
---

Replace specific pattern matching with signal-based flagging architecture. The flagger is now a wide-net boolean gate (high recall, no reasoning) and the judge sees raw actions only — no flagger bias in evaluations.

Broadened sensitive file detection beyond `.env*`:
- Files outside the working directory
- Dotfiles/dotdirs in `$HOME` (`.ssh`, `.aws`, `.gnupg`, etc.)
- System paths (`/etc`, `/usr`, `/var`, `/dev`, `/proc`, etc.)
- Paths containing secret keywords (`secret`, `credential`, `password`, `token`, `.pem`, `.key`, `id_rsa`, `authorized_keys`)

New signals:
- `rm -r` and `rm -f` flagged independently (previously required both)
- Interpreter with inline code (`eval`, `bash -c`, `python -c`, `node -e`)
- `chmod u+s`/`g+s` (setuid/setgid)
- `su`, `doas`, `pkexec` (previously only `sudo`)
- Content scanning: private key material, known API key formats (GitHub PAT, OpenAI, AWS, Slack)
