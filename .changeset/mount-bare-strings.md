---
"pi-enclave": patch
---

Support bare strings in mounts config for simpler syntax.

Before:
```toml
[[mounts]]
path = "~/dev/myproject/.jj"

[[mounts]]
path = "~/dev/myproject/.git"
```

After:
```toml
mounts = ["~/dev/myproject/.jj", "~/dev/myproject/.git"]
```

Object form still works for read-only mounts. Also fixes ASCII chart alignment in README.
