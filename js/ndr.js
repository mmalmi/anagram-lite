// Optional transport. Loaded only after activation or a verified compatible roster candidate.
// The host owns relays and storage; the library owns device authorization and sessions.
import { NdrRuntime, createPersistentNostrOutbox, buildAppKeysFilter, AppKeys } from '../vendor/nostr-double-ratchet.mjs';
import { finalizeEvent, getEventHash, verifyEvent } from '../vendor/nostr-tools.mjs';

export const hasNdrDevices = (event) => AppKeys.fromEvent(event).getAllDevices().some((device) => /^[a-f0-9]{64}$/.test(device.identityPubkey));

export function createNdrClient({ owner, sign, storage, subscribe, fetch, publish, receive, delivery = () => {} }) {
  let closed = false;
  const writes = new Set();
  const bounded = (filter) => ({ ...filter, limit: Math.min(filter.limit ?? 200, 200) });
  const assertOpen = () => { if (closed) throw new Error('Account closed'); };
  // Stop late runtime writes from recreating a signed-out account's keys.
  const saved = {
    get: (...args) => { assertOpen(); return storage.get(...args); },
    list: (...args) => { assertOpen(); return storage.list(...args); },
    put: (...args) => write(() => storage.put(...args)),
    del: (...args) => write(() => storage.del(...args)),
  };
  function write(action) {
    assertOpen();
    const pending = Promise.resolve().then(action);
    writes.add(pending);
    pending.then(() => writes.delete(pending), () => writes.delete(pending));
    return pending;
  }
  const outbox = createPersistentNostrOutbox({
    storage: saved,
    keyPrefix: 'outbox/',
    publish: async (event, _innerEventId, context) => {
      assertOpen();
      await publish(event, context);
      assertOpen();
      return event;
    },
    onPublished: ({ innerEventId, context }) => write(() => Promise.resolve(delivery(innerEventId, 'sent', context))),
    onError: ({ innerEventId }) => { if (!closed) delivery(innerEventId, 'failed'); },
  });
  const runtime = new NdrRuntime({
    storage: saved,
    nostrSign: async (event) => {
      assertOpen();
      const signed = await sign(event);
      assertOpen();
      if (signed.pubkey !== owner) throw new Error('Signer account changed');
      return signed;
    },
    nostrFetch: (filter) => { assertOpen(); return fetch(bounded(filter)); },
    nostrSubscribe: (filter, callback) => {
      assertOpen();
      const invite = runtime.getDelegateManager()?.getInvite();
      const ownInvite = filter.kinds?.length === 1 && filter.kinds[0] === 1059 &&
        filter['#p']?.length === 1 && filter['#p'][0] === invite?.inviterEphemeralPublicKey;
      // Gift-wrap relays only return events addressed to the AUTH key. Use our
      // invite's key on an isolated receive connection, never the account signer.
      const onauth = ownInvite && invite.inviterEphemeralPrivateKey ? async (event) => {
        assertOpen();
        if (event.kind !== 22242) throw new Error('Expected relay authentication');
        return finalizeEvent(event, invite.inviterEphemeralPrivateKey);
      } : undefined;
      return subscribe(bounded(filter), (event) => { if (!closed) callback(event); }, onauth);
    },
    nostrEnqueue: outbox.enqueue,
    nostrPublish: outbox.publish,
  });
  // This journal is saved atomically with the receiving ratchet. Only acknowledge
  // once the application's cache is durable; replay after a crash is idempotent.
  runtime.onDurableSessionEvent([5, 7, 14, 1009], async (event, from, meta) => {
    assertOpen();
    if (!meta?.senderOwnerPubkey || meta.senderOwnerPubkey !== from || getEventHash(event) !== event.id) return;
    if (event.tags.some((tag) => tag[0] === 'l')) return; // private groups are separate
    const author = meta.senderOwnerPubkey;
    const peer = author === owner
      ? event.tags.find((tag) => tag[0] === 'p' && tag[1] !== owner)?.[1] ?? owner
      : author;
    if (!/^[a-f0-9]{64}$/.test(peer) || !/^[a-f0-9]{64}$/.test(author)) return;
    await write(() => receive({ ...event, pubkey: author }, peer));
  });
  return {
    async start() {
      try {
        await runtime.initForOwner(owner);
        assertOpen();
        if (!runtime.getState().isCurrentDeviceRegistered) {
          // An empty offline result must never replace an existing roster. Keep
          // verified evidence even if a later subscription disconnects.
          const events = await fetch(bounded(buildAppKeysFilter(owner)));
          assertOpen();
          for (const event of events) {
            if (event.pubkey === owner && verifyEvent(event)) await runtime.applyVerifiedAppKeysEvent(event);
          }
          assertOpen();
          await runtime.ensureCurrentDeviceRegistered(owner);
        }
        assertOpen();
        await runtime.republishInvite();
        assertOpen();
        void outbox.retry().catch(() => {});
      } finally {
        if (closed) runtime.close();
      }
    },
    async send(peer, event) {
      assertOpen();
      // sendEvent saves the queue even when the peer is offline or undiscovered.
      await runtime.sendEvent(peer, event, owner);
    },
    retry: outbox.retry,
    async close() {
      closed = true;
      runtime.close();
      await outbox.close();
      await Promise.allSettled([...writes]);
    },
  };
}
