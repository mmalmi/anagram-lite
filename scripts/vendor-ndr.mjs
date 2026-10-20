// The website stays build-free. Run only when updating the optional NDR vendor file.
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await build({
  stdin: { contents: "export { NdrRuntime, createPersistentNostrOutbox, buildAppKeysFilter, AppKeys } from 'nostr-double-ratchet';", resolveDir: process.cwd() },
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: 'vendor/nostr-double-ratchet.mjs',
  legalComments: 'external',
});
await build({
  stdin: { contents: "export { createPrivateRelayPublisher, createAnonymousRelayDiscovery, isPrivateRelayEvent, isRelayDiscoveryFilter, splitRelayDiscoveryFilters } from 'nostr-pubsub/private-relays';", resolveDir: process.cwd() },
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: 'vendor/nostr-relay-privacy.mjs',
  legalComments: 'external',
});
const filenames = ['nostr-double-ratchet.mjs', 'nostr-relay-privacy.mjs'];
const sums = (await readFile('vendor/SHA256SUMS', 'utf8')).split('\n').filter((line) => line &&
  !filenames.some(filename => line.endsWith(`  ${filename}`)));
for (const filename of filenames) {
  const hash = createHash('sha256').update(await readFile(`vendor/${filename}`)).digest('hex');
  sums.push(`${hash}  ${filename}`);
}
await writeFile('vendor/SHA256SUMS', `${sums.join('\n')}\n`);
