import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey, getEventHash, matchFilter } from 'nostr-tools';
import { createNdrClient } from '../js/ndr.js';

const memory = () => {
  const rows = new Map();
  return {
    rows,
    async get(key) { return structuredClone(rows.get(key)); },
    async put(key, value) { rows.set(key, structuredClone(value)); },
    async del(key) { rows.delete(key); },
    async list(prefix = '') { return [...rows.keys()].filter((key) => key.startsWith(prefix)); },
  };
};
function relay() {
  const events = new Map();
  const filters = [];
  const subscriptions = new Set();
  return {
    events, filters,
    async fetch(filter) { filters.push(filter); return [...events.values()].filter((event) => matchFilter(filter, event)); },
    subscribe(filter, callback) {
      filters.push(filter);
      const sub = { filter, callback };
      subscriptions.add(sub);
      queueMicrotask(() => {
        for (const event of events.values()) if (subscriptions.has(sub) && matchFilter(filter, event)) callback(event);
      });
      return () => subscriptions.delete(sub);
    },
    async publish(event) {
      events.set(event.id, event);
      for (const { filter, callback } of subscriptions) if (matchFilter(filter, event)) queueMicrotask(() => callback(event));
      return event;
    },
  };
}
async function until(predicate, timeout = 12000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Timed out waiting for messages');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function person(network, extra = {}) {
  const secret = generateSecretKey();
  const owner = getPublicKey(secret);
  const storage = memory();
  const received = [];
  const options = {
    owner, storage,
    sign: (event) => Promise.resolve(finalizeEvent(event, secret)),
    subscribe: network.subscribe, fetch: network.fetch, publish: network.publish,
    receive: async (event, peer) => { received.push({ event, peer }); },
    ...extra,
  };
  return { owner, storage, received, options, client: createNdrClient(options) };
}
function rumor(owner, peer, content, kind = 14, tags = []) {
  const event = { pubkey: owner, kind, content, created_at: Math.floor(Date.now() / 1000), tags: [['p', peer], ...tags] };
  return { ...event, id: getEventHash(event) };
}

test('real runtime DMs, reply/reaction/edit/delete rumors and persisted restart', { timeout: 45000 }, async (t) => {
  const network = relay();
  const alice = person(network);
  const bob = person(network);
  t.after(async () => { await alice.client.close(); await bob.client.close(); });
  await Promise.all([alice.client.start(), bob.client.start()]);
  const first = rumor(alice.owner, bob.owner, 'Hello from lite');
  await alice.client.send(bob.owner, first);
  await until(() => bob.received.some((row) => row.event.id === first.id));
  assert.equal(bob.received[0].event.pubkey, alice.owner);
  assert.equal(bob.received[0].peer, alice.owner);
  const device = [...bob.storage.rows].find(([key]) => key.includes('device'));
  await bob.client.close();
  const offline = rumor(alice.owner, bob.owner, 'Sent while Bob was offline');
  await alice.client.send(bob.owner, offline);
  bob.client = createNdrClient(bob.options);
  await bob.client.start();
  await until(() => bob.received.some((row) => row.event.id === offline.id));
  const response = rumor(bob.owner, alice.owner, 'A reply after restart', 14, [['e', first.id]]);
  await bob.client.send(alice.owner, response);
  await until(() => alice.received.some((row) => row.event.id === response.id));
  const receipt = rumor(alice.owner, bob.owner, 'delivered', 15, [['e', first.id]]);
  await alice.client.send(bob.owner, receipt);
  for (const [kind, content] of [[7, '👍'], [1009, 'Edited'], [5, '']]) {
    const event = rumor(alice.owner, bob.owner, content, kind, [['e', first.id], ['k', '14']]);
    await alice.client.send(bob.owner, event);
    await until(() => bob.received.some((row) => row.event.id === event.id));
  }
  assert.ok(!bob.received.some((row) => row.event.id === receipt.id));
  assert.ok(network.filters.length > 0 && network.filters.every((filter) => filter.limit <= 200));
  const publicIdentityKeys = new Set([
    alice.owner, bob.owner,
    ...[...network.events.values()].filter((event) => event.kind === 30078).flatMap((event) => [
      event.pubkey,
      ...event.tags.filter((tag) => tag[0] === 'ephemeralKey').map((tag) => tag[1]),
    ]),
  ]);
  for (const event of [...network.events.values()].filter((event) => event.kind === 1060)) {
    assert.ok(!publicIdentityKeys.has(event.pubkey), 'Message signer must not identify its sender through a public invite');
  }
  for (const filter of network.filters) {
    if (!filter.kinds?.includes(1060)) continue;
    for (const author of filter.authors ?? []) {
      assert.ok(!publicIdentityKeys.has(author), 'Message filters must not disclose a peer identity or public invite key');
    }
  }

  if (device) assert.deepEqual(bob.storage.rows.get(device[0]), device[1]);
});

test('signed outbox retries exact envelopes without blocking independent failures', { timeout: 20000 }, async (t) => {
  const network = relay();
  const sent = [];
  const owner = person(network, {
    publish: async (event) => {
      sent.push(event);
      if (event.content === 'offline') throw new Error('offline');
      return network.publish(event);
    },
  });
  t.after(() => owner.client.close());
  const secret = generateSecretKey();
  const blocked = finalizeEvent({ kind: 1060, tags: [['v', '2'], ['header', 'test']], content: 'offline', created_at: 1 }, secret);
  const independent = finalizeEvent({ kind: 1060, tags: [['v', '2'], ['header', 'test']], content: 'accepted', created_at: 2 }, secret);
  await owner.storage.put(`outbox/${blocked.id}`, { event: blocked });
  await owner.storage.put(`outbox/${independent.id}`, { event: independent });
  await owner.client.start();
  await until(() => sent.some((event) => event.id === independent.id));
  await owner.client.retry();
  assert.ok(await owner.storage.get(`outbox/${blocked.id}`));
  assert.equal(await owner.storage.get(`outbox/${independent.id}`), undefined);
  assert.ok(sent.filter((event) => event.id === blocked.id).length >= 2);
  for (const event of sent.filter((event) => event.id === blocked.id)) assert.equal(JSON.stringify(event), JSON.stringify(blocked));
});

test('offline activation never signs a replacement device roster', async () => {
  let signed = 0;
  const owner = person(relay(), {
    fetch: async () => { throw new Error('No relay EOSE'); },
    sign: async () => { signed++; throw new Error('Must not sign'); },
  });
  await assert.rejects(owner.client.start(), /No relay EOSE/);
  await owner.client.close();
  assert.equal(signed, 0);
  assert.equal((await owner.storage.list('outbox/')).length, 0);
});

test('closing during signer approval cannot persist or publish late authorization', { timeout: 20000 }, async () => {
  const network = relay();
  let approve;
  let asked = false;
  const owner = person(network);
  owner.options.sign = (event) => {
    asked = true;
    return new Promise((resolve) => { approve = () => resolve({ ...event, id: 'late', sig: 'late' }); });
  };
  owner.client = createNdrClient(owner.options);
  const starting = owner.client.start();
  // Registration performs bounded empty-roster discovery before requesting the
  // signer. Leave room beyond that deadline so this tests cancellation, not timing.
  await until(() => asked, 16000);
  await owner.client.close();
  const count = owner.storage.rows.size;
  approve();
  await assert.rejects(starting, /Account closed/);
  assert.equal(owner.storage.rows.size, count);
  assert.equal(network.events.size, 0);
});


test('upgrade quarantines old queued envelopes without deleting their stored records', { timeout: 20000 }, async (t) => {
  const network = relay();
  const owner = person(network);
  t.after(() => owner.client.close());
  const signer = generateSecretKey();
  const legacy = [1059, 1060].map((kind) => finalizeEvent({
    kind, tags: [['p', owner.owner]], content: 'old ciphertext', created_at: 1,
  }, signer));
  for (const event of legacy) await owner.storage.put(`outbox/${event.id}`, { event });
  await owner.client.start();
  await owner.client.retry();
  await owner.client.retry();
  for (const event of legacy) {
    assert.equal(network.events.has(event.id), false, 'An old identity-linked event must never reach a relay');
    assert.deepEqual(
      await owner.storage.get(`outbox/${event.id}`),
      JSON.parse(JSON.stringify({ event })),
    );
  }
});
