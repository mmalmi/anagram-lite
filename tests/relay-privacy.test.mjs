import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import { AppKeys, Invite, Session } from 'nostr-double-ratchet';
import { AppKeys as BrowserAppKeys } from '../vendor/nostr-double-ratchet.mjs';
import * as transport from '../js/transport.js';

test('DR sends, sibling copies, retries and discovery use separate anonymous AUTH connections', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => server.once('listening', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/`;
  const frames = [];
  let serial = 0, rejectFirst = true;
  const secret = generateSecretKey(), owner = getPublicKey(secret);
  const peer = getPublicKey(generateSecretKey()), sibling = getPublicKey(generateSecretKey());
  const seal = recipient => Session.init(getPublicKey(generateSecretKey()), generateSecretKey(), true,
    generateSecretKey()).sendEvent({ kind: 14, content: 'private' }, [['p', recipient]]).event;
  const ownCopy = seal(sibling), peerCopy = seal(peer);
  const ownerProof = finalizeEvent(new AppKeys([{ identityPubkey: owner, createdAt: Math.floor(Date.now() / 1000) }]).getEvent({ ownerPubkey: owner }), secret);
  const firstContact = (await Invite.createNew(peer, peer).accept(owner, secret, owner, ownerProof)).event;
  const privateIds = new Set([ownCopy.id, peerCopy.id, firstContact.id]);
  server.on('connection', socket => {
    const connection = ++serial, challenge = `privacy-${connection}`;
    let authenticated = false;
    socket.send(JSON.stringify(['AUTH', challenge]));
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      frames.push({ connection, message });
      const [command, value] = message;
      if (command === 'AUTH') {
        authenticated = verifyEvent(value) && value.kind === 22242 && value.tags.some(tag => tag[0] === 'challenge' && tag[1] === challenge);
        socket.send(JSON.stringify(['OK', value.id, authenticated, authenticated ? '' : 'auth-required: invalid']));
      } else if (command === 'EVENT') {
        const accepted = authenticated && !(value.id === peerCopy.id && rejectFirst);
        if (authenticated && value.id === peerCopy.id) rejectFirst = false;
        socket.send(JSON.stringify(['OK', value.id, accepted, accepted ? '' : authenticated ? 'blocked: retry' : 'auth-required: authenticate']));
      } else if (command === 'REQ') {
        if (authenticated && message.slice(2).some(filter => filter.kinds?.includes(37368) && filter.authors?.includes(owner)))
          socket.send(JSON.stringify(['EVENT', value, ownerProof]));
        socket.send(JSON.stringify(authenticated
          ? ['EOSE', value] : ['CLOSED', value, 'auth-required: authenticate']));
      }
    });
  });
  const original = { app: [...transport.APP_RELAYS], ndr: [...transport.NDR_RELAYS], indexers: [...transport.INDEXERS] };
  transport.APP_RELAYS.splice(0, transport.APP_RELAYS.length, url);
  transport.NDR_RELAYS.splice(0, transport.NDR_RELAYS.length, url);
  transport.INDEXERS.splice(0, transport.INDEXERS.length, url);
  const signer = { sign: async event => finalizeEvent(event, secret) };
  transport.setAuthSigner(signer);
  const subscriptions = [], snapshots = [];
  try {
    subscriptions.push(transport.subscribe('ndr', { kinds: [1059], '#p': [sibling] }));
    for (const key of [owner, peer]) subscriptions.push(transport.subscribe('ndr', { kinds: [37368], authors: [key] }, {
      onevent: event => snapshots.push(event),
    }));
    const roster = await transport.queryConfirmed('ndr', { kinds: [37368], authors: [owner] });
    assert.ok(roster.some(event => event.id === ownerProof.id));
    assert.equal(Object.isFrozen(roster[0]), false);
    assert.equal(Object.isFrozen(roster[0].tags), false);
    assert.equal(BrowserAppKeys.fromEvent(roster[0]).getAllDevices()[0].identityPubkey, owner);
    assert.ok(snapshots.length > 0);
    assert.equal(BrowserAppKeys.fromEvent(snapshots[0]).getAllDevices()[0].identityPubkey, owner);
    await transport.queryConfirmed('ndr', { kinds: [30078], authors: [peer] });
    subscriptions.push(transport.subscribe('index', { kinds: [0, 10002, 10050], authors: [owner, peer, sibling] }));
    await transport.query('index', { kinds: [0, 10002, 10050], authors: [owner, peer, sibling] });
    await transport.get('index', { kinds: [0], authors: [peer] });
    await transport.publish('ndr', finalizeEvent(Invite.createNew(owner, owner).getEvent(), secret), signer);
    await assert.rejects(transport.publish('ndr', peerCopy, signer));
    for (const event of [peerCopy, ownCopy, firstContact]) await transport.publish('ndr', event, signer);
    const privateConnections = new Set(frames.filter(({ message }) => message[0] === 'EVENT' && privateIds.has(message[1].id)).map(frame => frame.connection));
    assert.ok(privateConnections.size >= 4);
    const authKeys = new Set();
    for (const connection of privateConnections) {
      const messages = frames.filter(frame => frame.connection === connection).map(frame => frame.message);
      assert.ok(!messages.some(message => message[0] === 'REQ'));
      assert.equal(new Set(messages.filter(message => message[0] === 'EVENT').map(message => message[1].id)).size, 1);
      const keys = new Set(messages.filter(message => message[0] === 'AUTH').map(message => message[1].pubkey));
      assert.equal(keys.size, 1);
      for (const key of keys) {
        assert.ok(![owner, peer, sibling].includes(key));
        assert.ok(!authKeys.has(key));
        authKeys.add(key);
      }
    }
    assert.ok(frames.some(({ message }) => message[0] === 'AUTH' && message[1].pubkey === owner));
    for (const connection of new Set(frames.filter(({ message }) => message[0] === 'REQ' && message.slice(2)
      .some(filter => filter.kinds?.some(kind => [0, 10002, 10050, 37368, 30078].includes(kind)))).map(frame => frame.connection))) {
      const messages = frames.filter(frame => frame.connection === connection).map(frame => frame.message);
      assert.ok(!messages.some(message => message[0] === 'EVENT'));
      assert.ok(messages.filter(message => message[0] === 'AUTH').every(message => message[1].pubkey !== owner));
      assert.equal(new Set(messages.filter(message => message[0] === 'REQ').flatMap(message =>
        message.slice(2).flatMap(filter => filter.authors ?? filter['#p'] ?? []))).size, 1);
    }
    await assert.rejects(transport.queryConfirmed('ndr', { kinds: [37368], authors: [owner], '#p': [peer] }));
  } finally {
    subscriptions.forEach(subscription => subscription.close());
    transport.reset();
    transport.APP_RELAYS.splice(0, transport.APP_RELAYS.length, ...original.app);
    transport.NDR_RELAYS.splice(0, transport.NDR_RELAYS.length, ...original.ndr);
    transport.INDEXERS.splice(0, transport.INDEXERS.length, ...original.indexers);
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});
