# Desktop package input

The repository does not distribute the Desktop binary or an authenticated container image. The build expects an owner-downloaded Linux amd64 Debian package at `desktop-container/.cache/chatgpt_amd64.deb`.

Download source used for the current development build:

https://persistent.oaistatic.com/codex-app-prod/linux/deb/latest/chatgpt_amd64.deb

The locally verified artifact is version `26.908.70816`. Its SHA-256, rechecked against the downloaded file on 2026-09-15, is:

```text
10ed0c1a880b9975d1f185bf7911a7f514e06b9863cd4ed9561d40063617c854
```

The Dockerfile checks that digest before installing the package. The URL contains `latest` and can change; it is not an immutable archive URL. This digest identifies the development artifact, not a promise that the latest download will still match it. A reproducible replacement package acquisition path remains a release gate.

If the digest differs, do not disable validation or automatically trust the new download. Verify its official origin and package metadata, review compatibility, record the new version and digest, and explicitly pass the reviewed checksum through the Docker build argument `CHATGPT_SHA256`. Keep the downloaded package, logs with account data and any initialized profile out of Git.

The fresh image still needs owner sign-in inside Desktop. A package installation or successful image build does not verify model availability, unattended startup, Telegram connectivity or agent collaboration.
