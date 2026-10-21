# Vendored libraries

Pinned ES module builds from esm.sh, checked in so the app runs no third-party
code at runtime (CSP `script-src 'self'`). No build step: these are plain files.

| File | Source |
|---|---|
| preact.mjs | https://esm.sh/preact@10.24.3/es2022/preact.mjs |
| hooks.mjs | https://esm.sh/preact@10.24.3/es2022/hooks.mjs |
| signals.mjs | https://esm.sh/@preact/signals@1.3.0/X-ZXByZWFjdA/es2022/signals.mjs (signals-core import rewritten to `./signals-core.mjs`) |
| signals-core.mjs | https://esm.sh/@preact/signals-core@1.14.4/es2022/signals-core.mjs |
| htm.mjs | https://esm.sh/htm@3.1.1/es2022/htm.mjs |
| nostr-tools.mjs | https://esm.sh/nostr-tools@2.25.2/es2022/nostr-tools.bundle.mjs |
| nip46.mjs | https://esm.sh/nostr-tools@2.25.2/es2022/nip46.bundle.mjs |

`SHA256SUMS` records the checked-in contents (`sha256sum -c SHA256SUMS`). To upgrade,
download the new URLs over these files, re-apply the signals-core rewrite, update the
table and regenerate the sums.

## Optional double-ratchet transport

`nostr-double-ratchet.mjs` is a local browser bundle of
[`nostr-double-ratchet@0.0.182`](https://www.npmjs.com/package/nostr-double-ratchet/v/0.0.182),
exporting `NdrRuntime`, `AppKeys` and its persistent outbox/discovery helpers. It
loads dynamically after activation or a verified compatible roster candidate.
Ordinary NIP-17/room startup and negative discovery do not request it. The pinned
npm lockfile and `scripts/vendor-ndr.mjs` reproduce the minified ES2022 build:

```sh
npm ci
npm run vendor:ndr
(cd vendor && shasum -a 256 -c SHA256SUMS)
```

At this version the optional bundle is 277,395 bytes (79,650 bytes gzip). No
runtime CDN, additional service, worker or CSP relaxation is needed. License
notices are in `ndr-LICENSES.txt` and `nostr-double-ratchet.mjs.LEGAL.txt`.

This version derives a separate first-reply key for each handshake, so a public
invite cannot identify the message signer. Older sessions must establish a new
handshake. Old queued envelopes remain stored but are not sent again.

`nostr-relay-privacy.mjs` bundles the narrow `nostr-pubsub/private-relays`
entry point from `nostr-pubsub@0.5.19`. It is 84,947 bytes (29,183 bytes gzip).
Double-ratchet sends and retries use fresh connections and anonymous relay
authentication, including copies to the sender's linked devices. Public device
and invite lookups, targeted profiles, and relay lists use separate anonymous
connections scoped to one public key.
The account's receiving pool and public publications stay separate. This
transport module does not load the optional double-ratchet runtime during
ordinary NIP-17 startup or negative discovery.
