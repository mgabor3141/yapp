---
"pi-jujutsu": patch
---

Fix extension not loading when installed from npm: pi.extensions entry pointed to src/index.ts which is not included in the published package. Changed to dist/index.js.
