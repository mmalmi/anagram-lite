import test from 'node:test';
import assert from 'node:assert/strict';
import * as nostr from '../js/nostr.js';
import * as transport from '../js/transport.js';
import { WebSocketServer } from 'ws';
import { verifyEvent } from 'nostr-tools';

test('existing NIP-17 DMs, replies, edits, reactions and deletions remain gift wrapped', async () => {
  const alice = nostr.newKeySigner();
  const bob = nostr.newKeySigner();
  const published = [];
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => server.once('listening', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/`, authKeys = [];
  const original = { app: [...transport.APP_RELAYS], indexers: [...transport.INDEXERS] };
  transport.APP_RELAYS.splice(0, transport.APP_RELAYS.length, url);
  transport.INDEXERS.splice(0);
  server.on('connection', socket => {
    let authenticated = false;
    socket.send(JSON.stringify(['AUTH', 'legacy-private-fixture']));
    socket.on('message', bytes => {
      const [command, event] = JSON.parse(bytes.toString());
      if (command === 'AUTH') {
        authenticated = verifyEvent(event);
        authKeys.push(event.pubkey);
        socket.send(JSON.stringify(['OK', event.id, authenticated, '']));
      } else if (command === 'EVENT') {
        if (authenticated) published.push(event);
        socket.send(JSON.stringify(['OK', event.id, authenticated, authenticated ? '' : 'auth-required: authenticate']));
      }
    });
  });
  try {
    const first = await nostr.sendDirectMessage(alice, bob.pubkey, 'Hello', [], null, null);
    const reply = await nostr.sendDirectMessage(bob, alice.pubkey, 'Reply', [], first.id, null);
    const edit = await nostr.sendDirectMessage(alice, bob.pubkey, 'Changed', [], null, first);
    const reaction = await nostr.sendRumor(bob, alice.pubkey, 7, '+', [['p', alice.pubkey], ['e', first.id]], []);
    const deletion = await nostr.sendRumor(alice, bob.pubkey, 5, '', [['p', bob.pubkey], ['e', first.id]], []);
    const received = [];
    for (const event of published) {
      assert.equal(event.kind, 1059);
      const signer = event.tags[0][1] === bob.pubkey ? bob : alice;
      received.push(await nostr.unwrap(signer, event));
    }
    for (const event of [first, reply, edit, reaction, deletion]) assert.ok(received.some((row) => row.id === event.id));
    assert.ok(reply.tags.some((tag) => tag[3] === 'reply'));
    assert.ok(nostr.isEdited(edit.tags));
    assert.equal(edit.created_at, first.created_at);
    assert.ok(authKeys.length >= 5);
    assert.ok(authKeys.every(key => ![alice.pubkey, bob.pubkey].includes(key)));
  } finally {
    transport.reset();
    transport.APP_RELAYS.splice(0, transport.APP_RELAYS.length, ...original.app);
    transport.INDEXERS.splice(0, transport.INDEXERS.length, ...original.indexers);
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});
