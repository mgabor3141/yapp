---
"pi-bash-bg": patch
---

Fix broken rewrites for multiple `&` jobs and subshell groups; leave scripts that `wait` on their jobs, or that can't be verified, unchanged. Uses @aliou/sh ^0.3.3 source positions.
