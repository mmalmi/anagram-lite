import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { AppKeys } from 'nostr-double-ratchet';

// The browser's connection-status poll should not keep this Node test alive.
const setIntervalForTest = globalThis.setInterval;
globalThis.setInterval = (...args) => { const timer = setIntervalForTest(...args); timer.unref?.(); return timer; };
const local = new Map();
globalThis.localStorage = {
  getItem: (key) => local.get(key) ?? null,
  setItem(key, value) { local.set(key, value); this[key] = value; },
  removeItem(key) { local.delete(key); delete this[key]; },
};
globalThis.location = { hash: '' };
globalThis.window = { addEventListener() {} };
globalThis.document = { addEventListener() {} };
globalThis.addEventListener = () => {};
globalThis.fetch = async () => { throw new Error('No directory request in tests'); };
// Web Locks keep the browser's device state single-writer. The test owns one tab.
Object.defineProperty(globalThis, 'navigator', { value: { locks: { request: (_name, _options, callback) => callback({}) } }, configurable: true });
await mkdir('work', { recursive: true });
await build({
  stdin: {
    contents: `export * as store from './js/store.js'; export * as nostr from './js/nostr.js'; export * as db from './js/db.js'; export * as transport from './js/transport.js'; export { clients, failStart } from './js/ndr.js';`,
    resolveDir: process.cwd(),
  },
  outfile: 'work/store-test.mjs', bundle: true, format: 'esm', platform: 'browser',
  alias: { preact: './vendor/preact.mjs', 'preact/hooks': './vendor/hooks.mjs', '@preact/signals': './vendor/signals.mjs' },
  plugins: [{ name: 'runtime-test-port', setup(build) {
    // UI flows keep their deterministic relay fixtures. A separate wire test
    // exercises the production privacy factories with actual AUTH connections.
    build.onResolve({ filter: /\/nostr-relay-privacy\.mjs$/ }, () => ({ path: 'privacy', namespace: 'privacy-test' }));
    build.onLoad({ filter: /.*/, namespace: 'privacy-test' }, () => ({ contents: `
      export { isPrivateRelayEvent, isRelayDiscoveryFilter, splitRelayDiscoveryFilters } from 'nostr-pubsub/private-relays';
      export function createPrivateRelayPublisher() { return {
        async publish(event, options) { await Promise.any(globalThis.ndrTestPublish(options.relays, event)); return { remoteAccepted: true }; },
        async close() {}
      }; }
      export function createAnonymousRelayDiscovery() { return {
        subscribe(filters, handlers, options) { return globalThis.ndrTestSubscribe(options.relays, filters[0], {
          onevent: handlers.onEvent, oneose: () => handlers.onEose?.({ sources: [{ complete: true }] })
        }); },
        async query(filters, options) {
          const events = filters.some(filter => filter.kinds?.includes(37368))
            ? await Promise.all(options.relays.map(url => globalThis.ndrTestQuery(url, filters)))
            : await Promise.all(filters.map(filter => globalThis.ndrTestRead(options.relays, filter)));
          return { events: events.flat(), sources: [{ complete: true }] };
        }, async close() {}
      }; }
    `, resolveDir: process.cwd() }));
    build.onResolve({ filter: /\/ndr\.js$/ }, () => ({ path: 'ndr', namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
      import { AppKeys } from 'nostr-double-ratchet';
      export const hasNdrDevices = (event) => AppKeys.fromEvent(event).getAllDevices().length > 0;
      export const clients = [];
      let startupError;
      export const failStart = (error) => { startupError = error; };
      export function createNdrClient(options) {
        const client = { options, sent: [], closed: false,
          async start() { if (startupError) throw startupError; }, async retry() {}, async close() { this.closed = true; },
          async send(peer, event) { this.sent.push({ peer, event }); }
        }; clients.push(client); return client;
      }
    `, resolveDir: process.cwd() }));
  } }],
});
const { store, nostr, clients, db, failStart, transport } = await import('../work/store-test.mjs');
globalThis.ndrTestPublish = (...args) => transport.pool.publish(...args);
globalThis.ndrTestSubscribe = (...args) => transport.pool.subscribe(...args);
globalThis.ndrTestRead = (...args) => transport.pool.querySync(...args);
globalThis.ndrTestQuery = async (url, filters) => {
  const relay = await transport.pool.ensureRelay(url);
  return new Promise((resolve, reject) => {
    const events = [];
    const sub = relay.subscribe(filters, { onevent: event => events.push(event),
      oneose: () => { sub.close(); resolve(events); }, onclose: reject });
  });
};
transport.pool.get = async () => null;
transport.pool.querySync = async () => [];
transport.pool.subscribe = (_relays, _filter, callbacks) => { queueMicrotask(() => callbacks.oneose?.()); return { close() {} }; };
transport.pool.publish = () => [Promise.resolve()];
const signer = nostr.newKeySigner();
const peer = nostr.newKeySigner().pubkey;
localStorage.setItem(`lite:rooms:${signer.pubkey}`, '[]');

test('NIP-17 default; selected NDR survives replies to old messages; mutations keep source transport', async () => {
  await store.login(signer, false);
  assert.equal(store.directProtocol(peer), 'nip17');
  await store.sendDirectMessage(peer, 'Original NIP-17');
  const old = store.dms.value[peer][0];
  assert.equal(clients.length, 0);
  await store.setDirectProtocol(peer, 'ndr');
  await store.sendDirectMessage(peer, 'NDR reply to old NIP-17', old);
  assert.equal(clients[0].sent.length, 1);
  assert.equal(clients[0].sent[0].event.content, 'NDR reply to old NIP-17');
  assert.ok(clients[0].sent[0].event.tags.some((tag) => tag[0] === 'e' && tag[1] === old.id));
  await store.toggleReaction({ peer }, old, '👍');
  assert.equal(clients[0].sent.length, 1); // old NIP-17 reaction stays gift wrapped
  const ndr = store.dms.value[peer].find((message) => message.protocol === 'ndr');
  await store.setDirectProtocol(peer, 'nip17');
  await store.editMessage({ peer }, ndr, 'An Iris edit');
  assert.equal(clients[0].sent.at(-1).event.kind, 1009);
  assert.equal(store.dms.value[peer].find((message) => message.id === ndr.id).content, 'An Iris edit');
  await store.deleteMessage({ peer }, ndr);
  assert.equal(clients[0].sent.at(-1).event.kind, 5);
  assert.ok(!store.dms.value[peer].some((message) => message.id === ndr.id));
});

test('received edits authenticate authors and persist before an out-of-order base message', async () => {
  const base = nostr.makeRumor(peer, 14, 'Original', [['p', signer.pubkey]]);
  const edit = nostr.makeRumor(peer, 1009, 'Edited before original arrived', [['p', signer.pubkey], ['e', base.id], ['k', '14']]);
  await clients[0].options.receive(edit, peer);
  await clients[0].options.receive(base, peer);
  assert.equal(store.dms.value[peer].find((message) => message.id === base.id).content, edit.content);
  const forged = nostr.makeRumor(signer.pubkey, 1009, 'Wrong author', [['p', peer], ['e', base.id], ['k', '14']], edit.created_at + 1);
  await clients[0].options.receive(forged, peer);
  assert.equal(store.dms.value[peer].find((message) => message.id === base.id).content, edit.content);
  const wrongDeletion = nostr.makeRumor(signer.pubkey, 5, '', [['p', peer], ['e', base.id], ['k', '14']]);
  await clients[0].options.receive(wrongDeletion, peer);
  assert.ok((await db.loadDirectMessages(signer.pubkey)).some((row) => row.id === base.id && row.content === base.content));
  const third = nostr.makeRumor(peer, 1009, 'Still authenticated', [['p', signer.pubkey], ['e', base.id], ['k', '14']], edit.created_at + 2);
  await clients[0].options.receive(third, peer);
  assert.equal(store.dms.value[peer].find((message) => message.id === base.id).content, third.content);
  await store.logout();
  assert.equal(clients[0].closed, true);
  assert.deepEqual(store.dms.value, {});
});


test('upstream NIP-17 optimistic reactions and deletes roll back on relay refusal', async () => {
  await store.login(signer, false);
  await store.setDirectProtocol(peer, 'nip17');
  await store.sendDirectMessage(peer, 'NIP-17 optimistic baseline');
  const message = store.dms.value[peer].find((row) => row.content === 'NIP-17 optimistic baseline');
  const published = transport.pool.publish;
  transport.pool.publish = () => [Promise.reject(new Error('Relay refused'))];
  const until = async (predicate) => {
    for (let i = 0; i < 50 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(predicate());
  };
  try {
    await store.toggleReaction({ peer }, message, '👍');
    assert.ok(store.reactions.value[message.id]?.length);
    await until(() => !(store.reactions.value[message.id]?.length));
    await store.deleteMessage({ peer }, message);
    assert.ok(!store.dms.value[peer].some((row) => row.id === message.id));
    await until(() => store.dms.value[peer].some((row) => row.id === message.id));
    assert.equal(clients.length, 1); // no NDR activation or transport fallback
  } finally {
    transport.pool.publish = published;
    await store.logout();
  }
});

const eventually = async (predicate) => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate());
};

test('Auto discovers delayed support, caches sends, respects overrides and never downgrades chosen NDR', async () => {
  const alice = nostr.newKeySigner(), bob = nostr.newKeySigner(), subscriptions = [];
  localStorage.setItem(`lite:rooms:${alice.pubkey}`, '[]');
  const original = transport.pool.subscribe;
  transport.pool.subscribe = (relays, filter, callbacks) => {
    if (filter.kinds.includes(37368)) {
      const entry = { filter, callbacks, closed: false };
      subscriptions.push(entry);
      queueMicrotask(() => callbacks.oneose());
      return { close() { entry.closed = true; } };
    }
    return original(relays, filter, callbacks);
  };
  try {
    await store.login(alice, false);
    const count = clients.length;
    assert.equal(store.directPreference(bob.pubkey), 'auto');
    store.openDirectChat(bob.pubkey);
    await store.prepareDirectProtocol(bob.pubkey);
    await store.sendDirectMessage(bob.pubkey, 'Auto initially NIP-17');
    await store.sendDirectMessage(bob.pubkey, 'No per-message network query');
    assert.equal(subscriptions.length, 1);
    assert.equal(clients.length, count);
    assert.equal(store.directPreference(bob.pubkey), 'auto');
    const t = nostr.now();
    const supported = await bob.sign(new AppKeys([{ identityPubkey: nostr.newKeySigner().pubkey, createdAt: t }]).getEvent({ ownerPubkey: bob.pubkey, createdAt: t }));
    subscriptions[0].callbacks.onevent(supported);
    await eventually(() => store.directProtocol(bob.pubkey) === 'ndr');
    await store.sendDirectMessage(bob.pubkey, 'Auto upgraded to NDR');
    assert.equal(clients.at(-1).sent.at(-1).event.content, 'Auto upgraded to NDR');
    const send = clients.at(-1).send;
    clients.at(-1).send = async () => { throw new Error('Temporary NDR failure'); };
    await assert.rejects(store.sendDirectMessage(bob.pubkey, 'Keep failed NDR queued'), /Temporary NDR failure/);
    const failed = store.dms.value[bob.pubkey].find((message) => message.content === 'Keep failed NDR queued');
    assert.equal(failed.protocol, 'ndr');
    assert.equal(store.sendStatus.value[failed.id], 'failed');
    assert.equal(store.directProtocol(bob.pubkey), 'ndr');
    clients.at(-1).send = send;
    subscriptions[0].callbacks.onevent(await bob.sign(new AppKeys().getEvent({ ownerPubkey: bob.pubkey, createdAt: t + 1 })));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(store.directProtocol(bob.pubkey), 'ndr');
    store.setPreferDoubleRatchet(false);
    assert.equal(store.directProtocol(bob.pubkey), 'ndr');
    assert.equal(subscriptions[0].closed, true);
    await store.setDirectProtocol(bob.pubkey, 'nip17');
    subscriptions[0].callbacks.onevent(supported);
    await store.sendDirectMessage(bob.pubkey, 'Explicit NIP-17 override');
    assert.equal(store.directProtocol(bob.pubkey), 'nip17');
    assert.equal(clients.at(-1).sent.at(-1).event.content, 'Auto upgraded to NDR');
    const unknown = nostr.newKeySigner().pubkey;
    store.openDirectChat(unknown);
    await store.prepareDirectProtocol(unknown);
    assert.equal(subscriptions.length, 1); // account setting disables Auto discovery
    store.setPreferDoubleRatchet(true);
    await store.prepareDirectProtocol(unknown);
    assert.equal(subscriptions.length, 2);
    store.closeDirectChat();
    store.openDirectChat(unknown);
    await store.prepareDirectProtocol(unknown);
    assert.equal(subscriptions.length, 3); // a negative cache is rechecked on open
    await store.logout();
    assert.equal(subscriptions.at(-1).closed, true);
  } finally { transport.pool.subscribe = original; }
});

test('existing NIP-17 history stays selected, settings and Auto selection persist per account', async () => {
  const alice = nostr.newKeySigner(), bob = nostr.newKeySigner();
  localStorage.setItem(`lite:rooms:${alice.pubkey}`, '[]');
  const old = nostr.makeRumor(bob.pubkey, 14, 'Cached old NIP-17', [['p', alice.pubkey]]);
  await db.saveDirectMessages([{ ...old, account: alice.pubkey, peer: bob.pubkey }]);
  const login = store.login(alice, false);
  // Opening while the cache is still loading must not turn existing history Auto.
  store.openDirectChat(bob.pubkey);
  await login;
  await store.prepareDirectProtocol(bob.pubkey);
  assert.equal(store.directPreference(bob.pubkey), 'nip17');
  store.setPreferDoubleRatchet(false);
  await store.setDirectProtocol(bob.pubkey, 'auto');
  await store.login(alice, false);
  assert.equal(store.preferDoubleRatchet.value, false);
  assert.equal(store.directPreference(bob.pubkey), 'auto');
  await store.setDirectProtocol(bob.pubkey, 'ndr');
  await store.setDirectProtocol(bob.pubkey, 'auto');
  await store.login(alice, false);
  assert.equal(store.directProtocol(bob.pubkey), 'ndr');
  const other = nostr.newKeySigner();
  localStorage.setItem(`lite:rooms:${other.pubkey}`, '[]');
  await store.login(other, false);
  assert.equal(store.preferDoubleRatchet.value, true);
  assert.equal(store.directPreference(bob.pubkey), 'auto');
  assert.equal(store.directProtocol(bob.pubkey), 'nip17');
  await store.logout();
});

test('Auto discovery and NDR fetch, subscription and publishing share Iris relay coverage', async () => {
  const alice = nostr.newKeySigner(), bob = nostr.newKeySigner();
  localStorage.setItem(`lite:rooms:${alice.pubkey}`, '[]');
  await store.login(alice, false);
  const original = { subscribe: transport.pool.subscribe, ensureRelay: transport.pool.ensureRelay, publish: transport.pool.publish };
  const subscriptions = [], fetched = [], published = [];
  transport.pool.subscribe = (relays, filter, callbacks) => {
    subscriptions.push({ relays, filter });
    queueMicrotask(() => callbacks.oneose?.());
    return { close() {} };
  };
  transport.pool.ensureRelay = async (url) => {
    fetched.push(url);
    return { subscribe(_filters, callbacks) { queueMicrotask(() => callbacks.oneose()); return { close() {} }; } };
  };
  transport.pool.publish = (relays) => { published.push(relays); return [Promise.resolve()]; };
  try {
    assert.ok(!nostr.APP_RELAYS.includes('wss://relay.snort.social'));
    store.openDirectChat(bob.pubkey);
    await store.prepareDirectProtocol(bob.pubkey);
    await store.setDirectProtocol(bob.pubkey, 'ndr');
    const options = clients.at(-1).options;
    const close = options.subscribe({ kinds: [1060], limit: 200 }, () => {});
    await options.fetch({ kinds: [37368], authors: [alice.pubkey], limit: 10 });
    await options.publish(await alice.sign({ kind: 1060, content: 'ciphertext', tags: [], created_at: nostr.now() }));
    for (const kind of [37368, 1060]) {
      const actual = subscriptions.find((entry) => entry.filter.kinds.includes(kind));
      assert.deepEqual(actual.relays, transport.NDR_RELAYS);
    }
    assert.deepEqual(fetched, transport.NDR_RELAYS);
    assert.deepEqual(new Set(published.flat()), new Set(transport.NDR_RELAYS));
    close();
  } finally {
    Object.assign(transport.pool, original);
    await store.logout();
  }
});

test('explicit NDR remains selected after registration failure and retries without NIP-17', async () => {
  const alice = nostr.newKeySigner(), bob = nostr.newKeySigner();
  localStorage.setItem(`lite:rooms:${alice.pubkey}`, '[]');
  await store.login(alice, false);
  const originalPublish = transport.pool.publish;
  let publications = 0;
  transport.pool.publish = () => { publications++; return [Promise.resolve()]; };
  failStart(new Error('Device registration conflicted. Try again.'));
  try {
    await assert.rejects(store.setDirectProtocol(bob.pubkey, 'ndr'), /registration conflicted/);
    assert.equal(store.directPreference(bob.pubkey), 'ndr');
    assert.equal(store.directProtocol(bob.pubkey), 'ndr');
    await assert.rejects(store.sendDirectMessage(bob.pubkey, 'Keep my selected encryption'), /registration conflicted/);
    assert.equal(publications, 0);
    failStart(undefined);
    await store.sendDirectMessage(bob.pubkey, 'Retry after confirmation');
    assert.equal(clients.at(-1).sent.at(-1).event.content, 'Retry after confirmation');
    assert.equal(store.directPreference(bob.pubkey), 'ndr');
    assert.equal(publications, 0);
  } finally {
    failStart(undefined);
    transport.pool.publish = originalPublish;
    await store.logout();
  }
});

test('unblocking an NDR contact restores messages without displaying persisted edits', async () => {
  const alice = nostr.newKeySigner(), bob = nostr.newKeySigner();
  localStorage.setItem(`lite:rooms:${alice.pubkey}`, '[]');
  await store.login(alice, false);
  await store.setDirectProtocol(bob.pubkey, 'ndr');
  const receiver = clients.at(-1).options.receive;
  const original = nostr.makeRumor(bob.pubkey, 14, 'Before editing', [['p', alice.pubkey]]);
  const edit = nostr.makeRumor(bob.pubkey, 1009, 'After editing', [['p', alice.pubkey], ['e', original.id], ['k', '14']]);
  try {
    await receiver(original, bob.pubkey);
    await receiver(edit, bob.pubkey);
    await store.toggleBlock(bob.pubkey);
    assert.deepEqual(store.dms.value[bob.pubkey] ?? [], []);
    await store.toggleBlock(bob.pubkey);
    for (let i = 0; i < 50 && !store.dms.value[bob.pubkey]?.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(store.dms.value[bob.pubkey].map((message) => [message.id, message.kind, message.content]), [[original.id, 14, 'After editing']]);
  } finally { await store.logout(); }
});

test('a new incoming NIP-17 conversation remains Auto and can upgrade later', async () => {
  const alice = nostr.newKeySigner(), bob = nostr.newKeySigner();
  localStorage.setItem(`lite:rooms:${alice.pubkey}`, '[]');
  const original = { subscribe: transport.pool.subscribe, publish: transport.pool.publish };
  let inbox;
  const rosters = [], wraps = [];
  transport.pool.subscribe = (relays, filter, callbacks) => {
    if (filter.kinds.includes(1059)) inbox = callbacks;
    if (filter.kinds.includes(37368)) rosters.push(callbacks);
    queueMicrotask(() => callbacks.oneose?.());
    return { close() {} };
  };
  transport.pool.publish = (_relays, event) => { if (event.kind === 1059) wraps.push(event); return [Promise.resolve()]; };
  const incoming = async (text) => {
    await nostr.sendDirectMessage(bob, alice.pubkey, text, []);
    const wrap = wraps.findLast((event) => event.tags.some((tag) => tag[0] === 'p' && tag[1] === alice.pubkey));
    assert.ok(wrap);
    inbox.onevent(wrap);
    await eventually(() => store.dms.value[bob.pubkey]?.some((message) => message.content === text));
  };
  try {
    await store.login(alice, false);
    await incoming('First incoming NIP-17');
    assert.equal(store.directPreference(bob.pubkey), 'auto');
    assert.equal(store.directProtocol(bob.pubkey), 'nip17');
    await store.login(alice, false);
    assert.equal(store.directPreference(bob.pubkey), 'auto'); // not mistaken for legacy cache on reload
    store.openDirectChat(bob.pubkey);
    await store.prepareDirectProtocol(bob.pubkey);
    assert.equal(rosters.length, 1);
    await store.sendDirectMessage(bob.pubkey, 'Reply before compatible device');
    assert.equal(store.directPreference(bob.pubkey), 'auto');
    const time = nostr.now();
    rosters[0].onevent(await bob.sign(new AppKeys([{ identityPubkey: nostr.newKeySigner().pubkey, createdAt: time }]).getEvent({ ownerPubkey: bob.pubkey, createdAt: time })));
    await eventually(() => store.directProtocol(bob.pubkey) === 'ndr');
    await store.sendDirectMessage(bob.pubkey, 'Reply after compatible device');
    assert.equal(clients.at(-1).sent.at(-1).event.content, 'Reply after compatible device');
    await store.setDirectProtocol(bob.pubkey, 'nip17');
    await incoming('Explicit NIP-17 stays selected');
    assert.equal(store.directPreference(bob.pubkey), 'nip17');
    assert.equal(store.directProtocol(bob.pubkey), 'nip17');
  } finally {
    Object.assign(transport.pool, original);
    await store.logout();
  }
});

test('unknown NDR senders use message requests until accepted, isolated across accounts', async () => {
  const alice = nostr.newKeySigner(), bob = nostr.newKeySigner(), other = nostr.newKeySigner();
  for (const account of [alice, other]) localStorage.setItem(`lite:rooms:${account.pubkey}`, '[]');
  await store.login(alice, false);
  await store.setDirectProtocol(alice.pubkey, 'ndr');
  const notifications = [];
  const stop = store.onIncoming((chat, message) => notifications.push({ chat, message }));
  try {
    const message = nostr.makeRumor(bob.pubkey, 14, 'A new encrypted request', [['p', alice.pubkey]]);
    await clients.at(-1).options.receive(message, bob.pubkey);
    assert.equal(store.dms.value[bob.pubkey][0].pubkey, bob.pubkey);
    assert.equal(store.isKnown(bob.pubkey), false);
    assert.deepEqual(store.requests.value.map(({ peer }) => peer), [bob.pubkey]);
    assert.deepEqual(store.chatList.value, []);
    assert.equal(notifications.length, 0);
    assert.equal(store.totalUnread.value, 0);
    assert.equal(store.directPreference(bob.pubkey), 'auto');
    assert.equal(store.directProtocol(bob.pubkey), 'ndr');
    await store.acceptRequest(bob.pubkey);
    assert.equal(store.requests.value.length, 0);
    assert.deepEqual(store.chatList.value.map(({ peer }) => peer), [bob.pubkey]);
    await clients.at(-1).options.receive(nostr.makeRumor(bob.pubkey, 14, 'Accepted contact', [['p', alice.pubkey]]), bob.pubkey);
    assert.equal(notifications.length, 1);
    await store.login(alice, false);
    assert.equal(store.isKnown(bob.pubkey), true);
    store.myFollows.value = [bob.pubkey];
    await store.login(other, false);
    assert.equal(store.isKnown(bob.pubkey), false);
    assert.deepEqual(store.accepted.value, []);
    assert.deepEqual(store.myFollows.value, []);
  } finally { stop(); await store.logout(); }
});

test('synced read marks, pins and hidden NDR messages survive replay and reload', async () => {
  const alice = nostr.newKeySigner(), bob = nostr.newKeySigner();
  localStorage.setItem(`lite:rooms:${alice.pubkey}`, '[]');
  const original = transport.pool.subscribe;
  let settings;
  transport.pool.subscribe = (relays, filter, callbacks) => {
    if (filter.kinds.includes(30078)) settings = callbacks;
    return original(relays, filter, callbacks);
  };
  const notifications = [];
  const stop = store.onIncoming((_chat, message) => notifications.push(message));
  try {
    await store.login(alice, false);
    await eventually(() => !!settings);
    await store.setDirectProtocol(bob.pubkey, 'ndr');
    await store.acceptRequest(bob.pubkey);
    const message = nostr.makeRumor(bob.pubkey, 14, 'Hide this on every device', [['p', alice.pubkey]]);
    await clients.at(-1).options.receive(message, bob.pubkey);
    assert.equal(notifications.length, 1);
    const at = nostr.now();
    const event = await nostr.publishSettings(alice, { v: 1, hidden: [message.id], read: { [bob.pubkey]: at }, pinned: { [bob.pubkey]: { on: true, at } }, muted: {} });
    await settings.onevent(event);
    assert.equal(store.isHidden(message.id), true);
    assert.equal(store.readMarks.value[bob.pubkey], at);
    assert.ok(store.chatPrefs.value.pinned.includes(bob.pubkey));
    assert.deepEqual(store.dms.value[bob.pubkey], []);
    await clients.at(-1).options.receive(message, bob.pubkey);
    assert.equal(notifications.length, 1);
    await store.login(alice, false);
    assert.equal(store.isHidden(message.id), true);
    assert.deepEqual(store.dms.value[bob.pubkey] ?? [], []);
    assert.equal(store.directProtocol(bob.pubkey), 'ndr');
  } finally { transport.pool.subscribe = original; stop(); await store.logout(); }
});
