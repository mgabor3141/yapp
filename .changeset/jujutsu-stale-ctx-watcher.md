---
"pi-jujutsu": patch
---

Stop op-heads watcher when captured ctx is stale, fixing crash on `newSession`/`fork`/`switchSession`/`reload`.
