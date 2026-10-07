# Security policy

FuFumidi is an **offline-first desktop application**: it does not run a server, and it does not
send your songs, audio or projects anywhere unless you explicitly turn on cloud sync
(`cloud-sync/`, an optional Cloudflare Worker you deploy yourself).

## Supported versions

| Version | Supported |
| --- | --- |
| 5.0.x (current) | yes |
| 4.x and older | no — please upgrade |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

1. Open a private report through GitHub:
   <https://github.com/qdTXTbp/FuFumidi/security/advisories/new>
2. If you cannot use GitHub, email the maintainer at the address in `package.json`.

Include: the version, what you did, what happened, and the smallest file or project that shows it.
A crash dump or a log is welcome; audio and project files are not needed and may contain your data.

We aim to acknowledge within 7 days and to ship a fix in the next patch release.

## What is in scope

- The Electron main process and its IPC surface (`preload.js`, `main/`) — a renderer that can
  reach `fs`, the network or a child process through `window.fuBridge` is a finding.
- The plugin sandbox (`plugin-host.js`, `plugin-worker.js`) — a plugin escaping it is a finding.
- The engine's handling of untrusted files (MIDI, audio, MusicXML, PDF, `.fufumidi` projects).
- The updater and the integrity check (`integrity.js`).

## What is not in scope

- Third-party model files or soundfonts you download yourself; report those upstream
  (see `docs/HYGIENE.md` for the list of bundled third-party components).
- Anything that requires an attacker to already have code execution on your machine.
- Denial of service through a deliberately huge file.
