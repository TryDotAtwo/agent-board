# Seccomp profile provenance

`seccomp-userns.json` is a modified Moby default profile. Upstream reference:
https://github.com/moby/profiles/blob/61eaf32614c7c71b60bd8927d3e6a4ffc8ff1f31/seccomp/default.json

License: Apache-2.0, included in `LICENSE.seccomp` from the same upstream revision.

Comparison performed on 2026-09-15: after applying the three transformations below to upstream JSON, every field and ordered syscall group matches the local profile structurally. This establishes an equivalent pinned source, not the unknown date/revision of the original local download. Whitespace differs.

1. Remove `clone`, `clone3`, `mount`, `umount`, `umount2` and `unshare` from the CAP_SYS_ADMIN-conditional allow group.
2. Remove the separate conditional `clone3` ENOSYS rule.
3. Append an unconditional allow group for `clone`, `clone3`, `chroot`, `mount`, `pivot_root`, `umount`, `umount2` and `unshare`.

Local profile SHA-256: `19d2a66f848351e76c83a4a42a80d3a5f59cbe489bca585aaaec8dc8eb09d3a3`.

These modifications permit namespace/sandbox operations that the default seccomp policy restricts. They broaden syscall exposure and are not an isolation improvement. Kernel permissions, namespace boundaries, dropped capabilities and no-new-privileges still apply, but Docker shares the host kernel; this is not a VM-grade security boundary. Do not add host mounts, the Docker socket, host networking or privileged mode to work around runtime errors. Runtime isolation and sandbox compatibility must be tested on the actual supported host.

This provenance check does not certify the profile's security or make it the upstream default. No syscall permissions were changed during this audit.
