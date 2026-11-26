import test from 'node:test';
import assert from 'node:assert/strict';
import * as transport from '../js/transport.js';
import { Subscription } from 'nostr-tools/abstract-relay';
import { WebSocketServer } from 'ws';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';

test('ratchet handshake subscription recovers once after relay AUTH and stops on close', { timeout: 10000 }, async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => server.once('listening', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/`;
  const secret = generateSecretKey(), inviteSecret = generateSecretKey(), recipient = getPublicKey(inviteSecret);
  const onauth = async event => finalizeEvent(event, inviteSecret);
  const handshake = finalizeEvent({ kind: 1059, created_at: Math.floor(Date.now() / 1000),
    tags: [['p', recipient], ['v', '2']], content: 'encrypted handshake' }, generateSecretKey());
  const requests = new Map();
  server.on('connection', socket => {
    let authenticated = false;
    socket.send(JSON.stringify(['AUTH', 'test-challenge']));
    socket.on('message', bytes => {
      const [verb, value, filter] = JSON.parse(String(bytes));
      if (verb === 'AUTH') {
        authenticated = value.pubkey === recipient;
        socket.send(JSON.stringify(['OK', value.id, authenticated, '']));
      } else if (verb === 'REQ') {
        const count = (requests.get(filter.limit) ?? 0) + 1;
        requests.set(filter.limit, count);
        // Match the public relay's rejection, including its ERROR prefix. AUTH
        // completion alone does not restore this closed subscription.
        if (count === 1 || filter.limit === 2) socket.send(JSON.stringify([
          'CLOSED', value, 'ERROR: auth-required: requested filter requires authentication',
        ]));
        else if (authenticated) {
          socket.send(JSON.stringify(['EVENT', value, handshake]));
          socket.send(JSON.stringify(['EOSE', value]));
        }
      }
    });
  });
  const original = [...transport.NDR_RELAYS];
  transport.NDR_RELAYS.splice(0, transport.NDR_RELAYS.length, url);
  transport.setAuthSigner({ sign: async event => finalizeEvent(event, secret) });
  const subscriptions = [];
  try {
    const received = new Promise(resolve => subscriptions.push(transport.subscribe('ndr',
      { kinds: [1059], '#p': [recipient], limit: 1 }, { onevent: resolve, onauth })));
    const delivered = await Promise.race([received, new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Handshake subscription was not restored')), 1500))]);
    assert.equal(delivered.id, handshake.id);
    assert.equal(requests.get(1), 2);

    await new Promise(resolve => subscriptions.push(transport.subscribe('ndr',
      { kinds: [1059], '#p': [recipient], limit: 2 }, { onclose: resolve, onauth })));
    assert.equal(requests.get(2), 2, 'a repeated rejection must not loop');

    // Closing while AUTH is pending must not reopen an account subscription.
    let release, asked;
    const pending = new Promise(resolve => { asked = resolve; });
    const sub = transport.subscribe('ndr', { kinds: [1059], '#p': [recipient], limit: 3 }, {
      onauth: event => { asked(); return new Promise(resolve => { release = () => resolve(onauth(event)); }); },
    });
    subscriptions.push(sub);
    await pending;
    transport.reset();
    release();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(requests.get(3), 1);
  } finally {
    subscriptions.forEach(sub => sub.close());
    transport.reset();
    transport.NDR_RELAYS.splice(0, transport.NDR_RELAYS.length, ...original);
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});

test('ratchet scope includes current inbox and shared Iris relay without changing ordinary scopes', () => {
  transport.setOwnRelays(['wss://own.example']);
  assert.ok(transport.resolve('ndr').includes('wss://own.example'));
  assert.ok(transport.resolve('ndr').includes('wss://relay.snort.social'));
  assert.ok(transport.resolve({ ndr: true, relays: ['wss://peer.example'] }).includes('wss://peer.example'));
  for (const scope of ['app', 'index', 'self', { peer: 'owner', relays: ['wss://peer.example'] }])
    assert.ok(!transport.resolve(scope).includes('wss://relay.snort.social'));
  transport.reset();
  assert.ok(!transport.resolve('ndr').includes('wss://own.example'));
});

test('confirmed public reads reject failed relays but accept genuine empty EOSE', async () => {
  const original = transport.pool.ensureRelay;
  let empty = false, closures = 0;
  transport.pool.ensureRelay = async () => ({ subscribe(_filters, callbacks) {
    queueMicrotask(() => empty ? callbacks.oneose() : callbacks.onclose());
    return { close() { closures++; } };
  } });
  try {
    await assert.rejects(transport.queryConfirmed('app', { kinds: [1], limit: 10 }), /Connect to a relay/);
    empty = true;
    assert.deepEqual(await transport.queryConfirmed('app', { kinds: [1], limit: 10 }), []);
    assert.equal(closures, transport.APP_RELAYS.length * 2);
  } finally { transport.pool.ensureRelay = original; }
});

test('NIP-17 still requires a recipient relay ACK while ratchet publications retain shared-relay delivery', async () => {
  const original = transport.pool.publish;
  transport.pool.publish = (relays) => relays.map(url => url === 'wss://peer.example'
    ? Promise.reject(new Error('Recipient relay unavailable')) : Promise.resolve());
  const event = { id: 'signed-envelope' };
  try {
    await assert.rejects(transport.publish({ peer: 'owner', relays: ['wss://peer.example'] }, event), error => error.partial === true);
    assert.equal(await transport.publish({ ndr: true, relays: ['wss://peer.example'] }, event), event);
  } finally { transport.pool.publish = original; }
});

test('nostr-tools synthesized EOSE cannot authorize a silent connected relay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = transport.pool.ensureRelay;
  const subscriptions = [];
  transport.pool.ensureRelay = async (_url, options) => {
    assert.equal(options.connectionTimeout, 5000);
    return { subscribe(filters, callbacks) {
      const relay = { url: 'wss://silent.example', baseEoseTimeout: 4400, connected: true, openSubs: new Map(), send() {} };
      const sub = new Subscription(relay, 'test', filters, callbacks);
      subscriptions.push(sub);
      sub.fire();
      return sub;
    } };
  };
  try {
    let settled = false;
    const result = transport.queryConfirmed('app', { kinds: [1], limit: 10 });
    result.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(result, /Connect to a relay/);
    await Promise.resolve();
    t.mock.timers.tick(4400);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled, false);
    assert.ok(subscriptions.every(sub => !sub.eosed));
    t.mock.timers.tick(600);
    await rejected;
    assert.ok(subscriptions.every(sub => sub.closed));
    t.mock.timers.tick(2147483647);
    assert.ok(subscriptions.every(sub => !sub.eosed));
  } finally { transport.pool.ensureRelay = original; t.mock.timers.reset(); }
});

test('a WebSocket handshake that never opens reaches the connection deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = transport.pool._WebSocket;
  const sockets = [];
  transport.pool._WebSocket = class {
    constructor() { sockets.push(this); }
    close() { this.closed = true; }
  };
  try {
    const result = transport.queryConfirmed('app', { kinds: [1], limit: 10 });
    const rejected = assert.rejects(result, /Connect to a relay/);
    await Promise.resolve();
    t.mock.timers.tick(4999);
    assert.equal(sockets.length, transport.APP_RELAYS.length);
    assert.ok(sockets.every(socket => !socket.closed));
    t.mock.timers.tick(1);
    await rejected;
    assert.ok(sockets.every(socket => socket.closed));
    assert.equal(transport.pool.relays.size, 0);
  } finally { transport.pool._WebSocket = original; transport.reset(); t.mock.timers.reset(); }
});
