// App state as Preact signals. Every update replaces values immutably so components re-render.
import { signal, computed, batch } from '@preact/signals';
import * as nostr from './nostr.js';
import * as transport from './transport.js';
import * as db from './db.js';
import { watchNdrCapability } from './ndr-discovery.js';

export const me = signal(null); // signer
export const profiles = signal({}); // pubkey -> profile
export const dms = signal({}); // peer -> messages, oldest first
export const inboxRelays = signal(null); // null = unknown, [] = none published
export const syncing = signal(false);
export const joinedRooms = signal([]); // [{ address, owner, slug, relays, name }]
export const roomState = signal({}); // address -> { room, messages, loading, error, exhausted }
export const route = signal(parseRoute());
export const toast = signal('');
export const reactions = signal({}); // target message id -> [{ id, pubkey, emoji }]
export const contacts = signal([]);
export const chatPrefs = signal({ pinned: [], muted: [] }); // chat keys
export const blocked = signal([]); // pubkeys blocked via the NIP-51 mute list ('bp', Anagram)
export const clearedAt = signal({}); // peer -> time the chat was deleted on this device
let muteList = null; // { event, entries } once read
let muteQueue = Promise.resolve();
export const drafts = signal({}); // chat key -> unsent text
export const readMarks = signal({}); // chat key (peer hex or room address) -> last read created_at
let readSince = 0; // messages before first use of this device count as read // pubkeys from the private contact list
let contactList = null; // { event } once loaded, so we never overwrite a list we haven't read

const storage = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

export function notify(message) {
  toast.value = message;
  setTimeout(() => toast.value === message && (toast.value = ''), 4000);
}

// ---------- Routing ----------

function parseRoute() {
  const page = location.hash.match(/^#\/(settings|new)$/)?.[1];
  if (page) return { kind: page };
  const [, kind, id] = location.hash.match(/^#\/(dm|room|public)\/(.+)$/) ?? [];
  try {
    return kind ? { kind: kind === 'public' ? 'room' : kind, id: decodeURIComponent(id) } : { kind: 'home' };
  } catch {
    return { kind: 'home' }; // malformed percent-encoding in the hash
  }
}
window.addEventListener('hashchange', () => (route.value = parseRoute()));
export const go = (hash) => (location.hash = hash);

// ---------- Session ----------

let inboxSub = null;
const roomSubs = new Map();

// ---------- Accounts ----------
// Remembered accounts live in localStorage as serialized signers; one is active.

export const accounts = signal([]); // [{ pubkey, type }]
export const addingAccount = signal(false);

function savedAccounts() {
  const list = storage.get('lite:accounts', null);
  if (list) return list;
  // Migrate the single-session format used before multiple accounts.
  const legacy = storage.get('lite:session', null);
  return legacy?.type ? [{ pubkey: legacy.pubkey ?? null, saved: legacy }] : [];
}

function refreshAccounts() {
  accounts.value = savedAccounts()
    .filter((a) => a.pubkey)
    .map((a) => ({ pubkey: a.pubkey, type: a.saved.type }));
}

function rememberAccount(signer) {
  const list = savedAccounts().filter((a) => a.pubkey && a.pubkey !== signer.pubkey);
  storage.set('lite:accounts', [{ pubkey: signer.pubkey, saved: nostr.serializeSigner(signer) }, ...list]);
  storage.set('lite:session', undefined);
  refreshAccounts();
}

// Stop everything belonging to the current account without forgetting it.
async function teardown() {
  const ndrClosed = stopNdr();
  clearTimeout(incomingTimer);
  incomingTimer = undefined;
  incoming = { messages: [], reactions: [] };
  flushSaves();
  if (draftTimer) {
    clearTimeout(draftTimer);
    if (me.value) storage.set(`lite:drafts:${me.value.pubkey}`, drafts.value);
  }
  inboxSub?.close();
  inboxSub = null;
  clearTimeout(settingsTimer);
  settingsTimer = 0;
  settingsLoaded = false;
  for (const sub of roomSubs.values()) sub.close();
  roomSubs.clear();
  // Drop every relay connection (they carry the old account's AUTH) and all paging cursors.
  transport.reset();
  contactsLoaded = null;
  contactQueue = Promise.resolve();
  muteList = null;
  muteQueue = Promise.resolve();
  closeDirectChat();
  resolveHistory?.();
  protocolChecks.clear();
  directProtocols.value = {};
  autoProtocols.value = {};
  preferDoubleRatchet.value = true;
  ndrEdits.clear();
  ndrDeletions.clear();
  for (const timer of ndrExpiryTimers.values()) clearTimeout(timer);
  ndrExpiryTimers.clear();
  theirInbox.clear();
  retries.clear();
  sendStatus.value = {};
  seenWraps.clear();
  deleted.clear();
  contactList = null;
  batch(() => {
    me.value = null;
    contacts.value = [];
    myFollows.value = [];
    accepted.value = [];
    blocked.value = [];
    clearedAt.value = {};
    reactions.value = {};
    dms.value = {};
    roomState.value = {};
    joinedRooms.value = [];
    inboxRelays.value = null;
    syncing.value = false;
    dmHistoryDone.value = false;
  });
  await ndrClosed;
}

export async function switchAccount(pubkey) {
  const entry = savedAccounts().find((a) => a.pubkey === pubkey);
  if (!entry || me.value?.pubkey === pubkey) return;
  const signer = await nostr.restoreSigner(entry.saved);
  go('');
  await login(signer, true);
}

export async function login(signer, remember) {
  if (me.value) await teardown();
  addingAccount.value = false;
  liveSince = nostr.now() - 10;
  historyReady = new Promise((resolve) => { resolveHistory = resolve; });
  me.value = signer;
  nostr.enableAuth(signer);
  if (remember) rememberAccount(signer);
  storage.set('lite:active', signer.pubkey);
  readMarks.value = storage.get(`lite:read:${signer.pubkey}`, {});
  drafts.value = storage.get(`lite:drafts:${signer.pubkey}`, {});
  chatPrefs.value = { pinned: [], muted: [], ...storage.get(`lite:prefs:${signer.pubkey}`, {}) };
  prefTimes = storage.get(`lite:preftimes:${signer.pubkey}`, { pinned: {}, muted: {} });
  hidden.value = storage.get(`lite:hidden:${signer.pubkey}`, []);
  clearedAt.value = storage.get(`lite:cleared:${signer.pubkey}`, {});
  readSince = storage.get(`lite:read-since:${signer.pubkey}`, 0);
  if (!readSince) storage.set(`lite:read-since:${signer.pubkey}`, (readSince = nostr.now()));
  const starter = nostr.starterRoom();
  const saved = storage.get(`lite:rooms:${signer.pubkey}`, null);
  joinedRooms.value = saved ?? (starter ? [roomEntry(starter)] : []);
  if (starter && !saved) setRoom(starter.address, { room: starter });
  requestProfiles([signer.pubkey]);
  for (const room of joinedRooms.value) openRoom(room);
  loadContacts();
  loadMuteList();
  directProtocols.value = storage.get(`lite:protocols:${signer.pubkey}`, {});
  autoProtocols.value = storage.get(`lite:auto-protocols:${signer.pubkey}`, {});
  preferDoubleRatchet.value = storage.get(`lite:prefer-ndr:${signer.pubkey}`, true);
  loadMyFollows(signer);
  await startInbox();
  if (me.value === signer && storage.get(`lite:ndr:${signer.pubkey}`, false))
    startNdr().catch((e) => notify(`Encrypted messaging unavailable: ${e.message}`));
  loadSettingsSync(signer);
}

// ---------- Settings sync across devices ----------
// One encrypted kind 30078 (d=nostr.chat) holds read marks (max wins), pinned/muted chats
// (newest change per chat wins) and hidden messages (union). Published a few seconds after
// a change; incoming copies from other devices are merged live.

let prefTimes = { pinned: {}, muted: {} }; // chat key -> time of the last pin/mute change
let settingsEvent = null; // last seen/published event (for created_at ordering)
let settingsTimer = 0;
let settingsLoaded = false;

function settingsDoc() {
  const read = Object.entries(readMarks.value).sort((a, b) => b[1] - a[1]).slice(0, 400);
  const lists = {};
  for (const list of ['pinned', 'muted'])
    lists[list] = Object.fromEntries(Object.entries(prefTimes[list]).map(([key, at]) => [key, { on: chatPrefs.value[list].includes(key), at }]));
  return { v: 1, read: Object.fromEntries(read), ...lists, hidden: hidden.value.slice(-500) };
}

// Merge another device's copy into local state. Returns true if anything changed here.
function mergeSettings(data) {
  let changed = false;
  const read = { ...readMarks.value };
  for (const [key, ts] of Object.entries(data.read ?? {}))
    if (typeof ts === 'number' && ts > (read[key] ?? 0)) (read[key] = ts), (changed = true);
  if (changed) {
    readMarks.value = read;
    storage.set(`lite:read:${me.value.pubkey}`, read);
  }
  const prefs = { ...chatPrefs.value };
  for (const list of ['pinned', 'muted'])
    for (const [key, entry] of Object.entries(data[list] ?? {})) {
      if (!entry || typeof entry.at !== 'number' || entry.at <= (prefTimes[list][key] ?? 0)) continue;
      prefTimes[list][key] = entry.at;
      const has = prefs[list].includes(key);
      if (entry.on && !has) prefs[list] = [...prefs[list], key];
      if (!entry.on && has) prefs[list] = prefs[list].filter((k) => k !== key);
      changed = true;
    }
  if (prefs !== chatPrefs.value) {
    chatPrefs.value = prefs;
    storage.set(`lite:prefs:${me.value.pubkey}`, prefs);
    storage.set(`lite:preftimes:${me.value.pubkey}`, prefTimes);
  }
  const extra = (data.hidden ?? []).filter((id) => typeof id === 'string' && !hidden.value.includes(id));
  if (extra.length) {
    hidden.value = [...hidden.value, ...extra];
    storage.set(`lite:hidden:${me.value.pubkey}`, hidden.value);
    for (const id of extra) dropEverywhere(id);
    changed = true;
  }
  return changed;
}

async function loadSettingsSync(signer) {
  settingsLoaded = false;
  settingsEvent = null;
  try {
    const found = await nostr.fetchSettings(signer);
    if (me.value !== signer) return;
    if (found) {
      settingsEvent = found.event;
      mergeSettings(found.data);
    }
  } catch {}
  settingsLoaded = true;
  roomSubs.set(
    'settings',
    transport.subscribe('self', { kinds: [30078], authors: [signer.pubkey], '#d': [nostr.SETTINGS_D], since: nostr.now() }, {
      onevent: async (event) => {
        if (me.value !== signer || event.created_at <= (settingsEvent?.created_at ?? 0)) return;
        const parsed = await nostr.parseSettings(signer, event);
        if (!parsed || me.value !== signer) return;
        settingsEvent = event;
        mergeSettings(parsed.data);
      },
    }),
  );
}

function scheduleSettingsPublish() {
  if (!me.value || !settingsLoaded) return; // never publish over a copy we haven't read yet
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(publishSettingsNow, 4000);
}

async function publishSettingsNow() {
  const signer = me.value;
  if (!signer || !settingsLoaded) return;
  try {
    const event = await nostr.publishSettings(signer, settingsDoc(), settingsEvent);
    if (me.value === signer) settingsEvent = event;
  } catch {}
}

// Flush a pending publish when the tab goes to the background.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && settingsTimer) {
    clearTimeout(settingsTimer);
    settingsTimer = 0;
    publishSettingsNow();
  }
});

// ---------- Delete for me ----------
// Hides a message on your devices only (no NIP-09); synced through the settings event.

export const hidden = signal([]);
export const isHidden = (id) => hidden.value.includes(id);

function dropEverywhere(id) {
  const next = {};
  let touched = false;
  for (const [peer, thread] of Object.entries(dms.value)) {
    const kept = thread.filter((m) => m.id !== id && !m.prev?.includes(id));
    if (kept.length !== thread.length) touched = true;
    next[peer] = kept;
  }
  if (touched) dms.value = next;
  for (const [address, state] of Object.entries(roomState.value))
    if (state.messages.some((m) => m.id === id)) setRoom(address, { messages: state.messages.filter((m) => m.id !== id) });
  db.deleteRoomMessages([id]).catch(() => {});
}

export function hideMessage(message) {
  if (!me.value || isHidden(message.id)) return;
  hidden.value = [...hidden.value, ...knownIds(message)];
  storage.set(`lite:hidden:${me.value.pubkey}`, hidden.value);
  for (const id of knownIds(message)) dropEverywhere(id);
  scheduleSettingsPublish();
}

// ---------- Message requests ----------
// A DM from someone you don't know lands in "Requests" instead of the chat list and makes
// no sound. Known: yourself, contacts, people you follow (kind 3, or nostr.social),
// anyone you have written to, and anyone you accepted.

export const myFollows = signal([]);
export const accepted = signal([]); // accepted request peers (local; Accept also adds a contact)
function loadMyFollows(signer) {
  accepted.value = storage.get(`lite:accepted:${signer.pubkey}`, []);
  followsOf(signer.pubkey).then((list) => me.value === signer && (myFollows.value = list));
}

export function isKnown(peer) {
  const mine = me.value?.pubkey;
  if (!mine || peer === mine) return true;
  if (contacts.value.includes(peer) || myFollows.value.includes(peer) || accepted.value.includes(peer)) return true;
  return (dms.value[peer] ?? []).some((m) => m.pubkey === mine);
}

export async function acceptRequest(peer) {
  accepted.value = nostr.uniq([...accepted.value, peer]);
  storage.set(`lite:accepted:${me.value.pubkey}`, accepted.value);
  await addContact(peer);
}

export const restoring = signal(true); // true until the saved session has been looked at

export async function restoreSession() {
  try {
    return await restoreSavedSession();
  } finally {
    restoring.value = false;
  }
}

async function restoreSavedSession() {
  const list = savedAccounts();
  refreshAccounts();
  const active = storage.get('lite:active', null);
  const entry = list.find((a) => a.pubkey === active) ?? list[0];
  if (!entry) return false;
  try {
    const signer = await nostr.restoreSigner(entry.saved);
    // Fill in the pubkey for sessions migrated from the old format. Not awaited: the UI
    // renders as soon as the account is known and the inbox fills in behind it.
    login(signer, !entry.pubkey).catch((e) => notify(`Startup problem: ${e.message}`));
    return true;
  } catch (e) {
    notify(`Could not restore session: ${e.message}`);
    return false;
  }
}

// Sign out of the current account only; move to the next remembered one if any.
export async function logout() {
  const current = me.value?.pubkey;
  const flushed = flushSaves();
  await teardown();
  // Forget this account's data on this device: decrypted DMs and per-account settings.
  if (current) {
    await flushed;
    await db.clearAccount(current).catch(() => {});
    for (const key of Object.keys(localStorage)) if (key.startsWith('lite:') && key.endsWith(`:${current}`)) storage.set(key, undefined);
    if (storage.get('lite:active', null) === current) storage.set('lite:active', undefined);
  }
  storage.set('lite:accounts', savedAccounts().filter((a) => a.pubkey !== current));
  storage.set('lite:session', undefined);
  refreshAccounts();
  go('');
  const next = accounts.value[0];
  if (next) await switchAccount(next.pubkey).catch((e) => notify(`Could not switch: ${e.message}`));
}

// ---------- Blocking & deleting chats ----------

export const isBlocked = (pk) => blocked.value.includes(pk);

async function loadMuteList() {
  const signer = me.value;
  try {
    const list = await nostr.fetchMuteList(signer);
    if (me.value !== signer) return;
    muteList = list;
    applyBlocked(nostr.uniq(list.entries.filter((t) => t[0] === 'bp').map((t) => t[1])));
  } catch (e) {
    notify(`Could not read your block list: ${e.message}`);
  }
}

// Drop a blocked person's messages everywhere they are already shown.
function applyBlocked(list) {
  const unblocked = blocked.value.filter((pk) => !list.includes(pk));
  blocked.value = list;
  const gone = new Set(list);
  const next = { ...dms.value };
  for (const pk of list) delete next[pk];
  dms.value = next;
  const rooms = {};
  for (const [address, state] of Object.entries(roomState.value))
    rooms[address] = { ...state, messages: state.messages.filter((m) => !gone.has(m.pubkey)) };
  roomState.value = rooms;
  // Unblocked: their stored conversation comes back without a reload.
  if (unblocked.length && me.value) {
    const account = me.value.pubkey;
    db.loadDirectMessages(account)
      .then((rows) => {
        if (me.value?.pubkey !== account) return;
        addMessages(rows.filter((m) => unblocked.includes(m.peer) && !m.deletedBy && m.kind !== 7 && !isDeleted(m.id, m.pubkey)));
      })
      .catch(() => {});
  }
}

export function toggleBlock(pubkey) {
  const run = muteQueue.then(async () => {
    const signer = me.value;
    // Merge into the newest list so mutes and other entries set elsewhere survive.
    const latest = await nostr.fetchMuteList(signer).catch(() => null);
    const base = latest?.event && latest.event.created_at > (muteList?.event?.created_at ?? 0) ? latest : muteList;
    if (!base && !latest) throw new Error('your block list could not be read, try again');
    const current = nostr.uniq((base?.entries ?? []).filter((t) => t[0] === 'bp').map((t) => t[1]));
    const nextList = current.includes(pubkey) ? current.filter((pk) => pk !== pubkey) : [...current, pubkey];
    muteList = await nostr.publishMuteList(signer, nextList, base ?? { event: null, entries: [] });
    if (me.value === signer) applyBlocked(nextList);
  });
  muteQueue = run.catch(() => {});
  return run;
}

// Delete a chat on this device: hide everything up to now and drop stored messages.
export async function deleteChat(peer) {
  const signer = me.value;
  clearedAt.value = { ...clearedAt.value, [peer]: nostr.now() };
  storage.set(`lite:cleared:${signer.pubkey}`, clearedAt.value);
  const next = { ...dms.value };
  delete next[peer];
  dms.value = next;
  await db.deleteConversation(signer.pubkey, peer).catch(() => {});
}

// ---------- Pinned & muted chats ----------

export const isPinned = (key) => chatPrefs.value.pinned.includes(key);
export const isMuted = (key) => chatPrefs.value.muted.includes(key);

function togglePref(list, key) {
  const current = chatPrefs.value[list];
  const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
  chatPrefs.value = { ...chatPrefs.value, [list]: next };
  storage.set(`lite:prefs:${me.value.pubkey}`, chatPrefs.value);
  prefTimes[list][key] = nostr.now();
  storage.set(`lite:preftimes:${me.value.pubkey}`, prefTimes);
  scheduleSettingsPublish();
}
export const togglePinned = (key) => togglePref('pinned', key);
export const toggleMuted = (key) => togglePref('muted', key);

// ---------- Drafts ----------

let draftTimer;
export function setDraft(key, text) {
  if (!me.value || !key || (drafts.value[key] ?? '') === text) return;
  const next = { ...drafts.value };
  if (text.trim()) next[key] = text;
  else delete next[key];
  drafts.value = next;
  // Debounce storage writes while typing.
  clearTimeout(draftTimer);
  const account = me.value.pubkey;
  const snapshot = drafts.value;
  draftTimer = setTimeout(() => storage.set(`lite:drafts:${account}`, snapshot), 300);
}

db.onOpenBlocked(() => notify('Close other nostr.chat tabs so this one can finish updating.'));

// ---------- Connection status ----------

// 'offline' (no network) | 'connecting' (no relay up) | 'updating' (syncing) | 'ok'
export const connection = signal('ok');
function updateConnection() {
  if (!me.value) return (connection.value = 'ok');
  if (!navigator.onLine) return (connection.value = 'offline');
  connection.value = !transport.up() ? 'connecting' : syncing.value ? 'updating' : 'ok';
}
addEventListener('online', updateConnection);
addEventListener('offline', updateConnection);
setInterval(updateConnection, 2000);

// ---------- Unread ----------

export function markRead(key, ts) {
  if (!me.value || (readMarks.value[key] ?? 0) >= ts) return;
  readMarks.value = { ...readMarks.value, [key]: ts };
  storage.set(`lite:read:${me.value.pubkey}`, readMarks.value);
  scheduleSettingsPublish();
}

// Everything after this time counts as unread in a chat.
export const readPoint = (key) => Math.max(readMarks.value[key] ?? 0, readSince);

export function unreadCount(key, messages) {
  const since = readPoint(key);
  let n = 0;
  for (let i = messages.length - 1; i >= 0 && messages[i].created_at > since; i--)
    if (messages[i].pubkey !== me.value?.pubkey) n++;
  return n;
}

// Unread messages in a chat that @mention you or reply to you (for the @ badge).
export function unreadMentions(key, messages) {
  const since = readPoint(key);
  let n = 0;
  for (let i = messages.length - 1; i >= 0 && messages[i].created_at > since; i--)
    if (messages[i].pubkey !== me.value?.pubkey && mentionsMe(messages[i])) n++;
  return n;
}

export function markAllRead() {
  const next = { ...readMarks.value };
  for (const [peer, thread] of Object.entries(dms.value)) if (thread.length) next[peer] = thread.at(-1).created_at;
  for (const room of joinedRooms.value) {
    const last = roomState.value[room.address]?.messages.at(-1);
    if (last) next[room.address] = last.created_at;
  }
  readMarks.value = next;
  storage.set(`lite:read:${me.value.pubkey}`, next);
  scheduleSettingsPublish();
}

export const totalUnread = computed(() => {
  if (!me.value) return 0;
  let n = 0;
  // Muted chats keep their own badge but stay out of the total, like Telegram.
  // Requests from strangers don't count either; they have their own section.
  for (const [peer, thread] of Object.entries(dms.value)) if (!isMuted(peer) && isKnown(peer)) n += unreadCount(peer, thread);
  for (const room of joinedRooms.value)
    if (!isMuted(room.address)) n += unreadCount(room.address, roomState.value[room.address]?.messages ?? []);
  return n;
});

// ---------- Incoming-message notifications ----------

let liveSince = Infinity; // only messages newer than login are "new"
const incomingListeners = new Set();
export const onIncoming = (fn) => (incomingListeners.add(fn), () => incomingListeners.delete(fn));

export const notifySettings = signal(storage.get('lite:notify', { dms: true, rooms: 'mentions', sound: true }));
export function setNotifySettings(patch) {
  notifySettings.value = { ...notifySettings.value, ...patch };
  storage.set('lite:notify', notifySettings.value);
}

// True when a room message @mentions us or replies to one of our messages.
export function mentionsMe(event) {
  const pk = me.value?.pubkey;
  if (!pk) return false;
  if (event.tags.some((t) => (t[0] === 'p' || t[0] === 'q') && (t[1] === pk || t[3] === pk))) return true;
  if (event.content.includes(nostr.did(pk)) || event.content.includes(nostr.npub(pk))) return true;
  return /nostr:nprofile1/.test(event.content) && (event.content.match(/nprofile1[02-9ac-hj-np-z]+/g) ?? []).some((p) => nostr.decodePubkey(p) === pk);
}

function emitIncoming(chat, message) {
  if (!me.value || message.pubkey === me.value.pubkey || message.created_at < liveSince || isBlocked(message.pubkey)) return;
  const settings = notifySettings.value;
  if (isMuted(chat.peer ?? chat.room.address)) return;
  if (chat.peer && (!settings.dms || !isKnown(chat.peer))) return;
  if (chat.room && (settings.rooms === 'off' || (settings.rooms === 'mentions' && !mentionsMe(message)))) return;
  for (const fn of incomingListeners) fn(chat, message);
}

// ---------- Media uploads ----------

export const mediaServer = signal(storage.get('lite:blossom', nostr.DEFAULT_BLOSSOM));
export function setMediaServer(value) {
  const origin = nostr.normalizeBlossomServer(value);
  if (!origin) throw new Error('Enter an https:// server address without a path.');
  mediaServer.value = origin;
  storage.set('lite:blossom', origin);
}
export const uploadMedia = (file) => nostr.uploadBlossom(me.value, file, mediaServer.value);

// ---------- Search ----------

// Newest-first message matches across DMs and joined rooms (what is loaded locally).
export function searchMessages(query, limit = 50) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const hits = [];
  for (const [peer, thread] of Object.entries(dms.value))
    for (const m of thread) if (m.content.toLowerCase().includes(q)) hits.push({ chat: { peer }, m });
  for (const room of joinedRooms.value)
    for (const m of roomState.value[room.address]?.messages ?? [])
      if (m.content.toLowerCase().includes(q)) hits.push({ chat: { room }, m });
  return hits.sort((a, b) => b.m.created_at - a.m.created_at).slice(0, limit);
}

// ---------- Profiles ----------

const pendingProfiles = new Set();
const requested = new Set();
let profileTimer;

db.loadProfiles()
  .then((rows) => {
    profiles.value = { ...Object.fromEntries(rows.map((p) => [p.pubkey, p])), ...profiles.value };
  })
  .catch(() => {});

export function requestProfiles(pubkeys) {
  for (const pk of pubkeys) if (!requested.has(pk)) pendingProfiles.add(pk);
  clearTimeout(profileTimer);
  profileTimer = setTimeout(async () => {
    const keys = [...pendingProfiles];
    pendingProfiles.clear();
    keys.forEach((k) => requested.add(k));
    // nostr.social answers in ~100 ms with the signed kind 0; relays follow as a fallback.
    for (const k of keys) if (!profiles.value[k]) fetchDirectoryProfile(k);
    for (let i = 0; i < keys.length; i += 100) {
      const found = await nostr.fetchProfiles(keys.slice(i, i + 100)).catch(() => []);
      // Also refresh rows cached before newer fields (about, website) existed.
      const fresh = found.filter((p) => {
        const cached = profiles.value[p.pubkey];
        // Signed relay profiles always replace the unsigned DID-document hint.
        return !cached || cached.source === 'did' || cached.created_at < p.created_at || !('about' in cached);
      });
      if (!fresh.length) continue;
      profiles.value = { ...profiles.value, ...Object.fromEntries(fresh.map((p) => [p.pubkey, p])) };
      db.saveProfiles(fresh).catch(() => {});
    }
  }, 250);
}

export const displayName = (pk) => profiles.value[pk]?.name || nostr.shortKey(pk);

// Verified profiles from elsewhere (e.g. people search) go into the cache too.
export function rememberProfiles(list) {
  const fresh = list.filter((p) => {
    const cached = profiles.value[p.pubkey];
    return !cached || cached.created_at < p.created_at;
  }).map(({ followers: _, ...p }) => p);
  if (!fresh.length) return;
  profiles.value = { ...profiles.value, ...Object.fromEntries(fresh.map((p) => [p.pubkey, p])) };
  db.saveProfiles(fresh).catch(() => {});
}

const followsCache = new Map();
export function followsOf(pk) {
  if (!followsCache.has(pk)) followsCache.set(pk, nostr.fetchFollows(pk).catch(() => []));
  return followsCache.get(pk);
}

// ---------- did:nostr documents (nostr.social resolver) ----------

export const didDocs = signal({}); // pubkey -> resolved document, or { error }
const didInFlight = new Map();
let didActive = 0;
const didWaiting = [];

// Directory profile: a verified signed kind 0, stored like any relay profile.
function fetchDirectoryProfile(pk) {
  return queued(() => nostr.fetchDirectoryProfile(pk))
    .then((p) => {
      if (!p) return;
      const cached = profiles.value[pk];
      if (cached && cached.created_at >= p.created_at && cached.source !== 'did') return;
      profiles.value = { ...profiles.value, [pk]: p };
      db.saveProfiles([p]).catch(() => {});
    })
    .catch(() => {});
}

// HTTP requests to nostr.social run at most 6 at a time.
function queued(fn) {
  const ready = new Promise((resolve) => didWaiting.push(resolve));
  pumpDid();
  return ready
    .then(fn)
    .finally(() => {
      didActive--;
      pumpDid();
    });
}

// Resolve a DID document (cached per session).
export function resolveDid(pk) {
  if (didInFlight.has(pk)) return didInFlight.get(pk);
  const job = queued(() => nostr.resolveDid(pk))
    .then(
      (r) => {
        didDocs.value = { ...didDocs.value, [pk]: r };
        return r;
      },
      (e) => {
        didDocs.value = { ...didDocs.value, [pk]: { error: e.message } };
        return null;
      },
    );
  didInFlight.set(pk, job);
  return job;
}
function pumpDid() {
  while (didActive < 6 && didWaiting.length) {
    didActive++;
    didWaiting.shift()();
  }
}

// Verified NIP-05 addresses: pubkey -> address that checked out ('' = failed). Per session.
export const nip05Verified = signal({});
const nip05Checking = new Set();
// Verifying fetches https://<their domain>/.well-known/nostr.json, which tells that domain
// your IP. So it happens automatically only for people you already deal with (yourself,
// contacts, people you've messaged); for anyone else it waits for an explicit tap.
const trustedForLookup = (pk) => pk === me.value?.pubkey || contacts.value.includes(pk) || (dms.value[pk] ?? []).some((m) => m.pubkey === me.value?.pubkey);

export function verifyNip05Now(pk) {
  const address = profiles.value[pk]?.nip05;
  const key = `${pk}:${address}`;
  if (!address || nip05Checking.has(key)) return;
  nip05Checking.add(key);
  nostr.verifyNip05(pk, address).then((ok) => (nip05Verified.value = { ...nip05Verified.value, [pk]: ok ? address : '' }));
}

// The verified address, or '' (unverified, failed, or not yet checked).
export function verifiedNip05(pk) {
  const address = profiles.value[pk]?.nip05;
  if (!address) return '';
  const known = nip05Verified.value[pk];
  if (known !== undefined && (known === '' || known === address)) return known;
  if (trustedForLookup(pk)) verifyNip05Now(pk);
  return '';
}

// ---------- Optional double-ratchet DMs ----------

export const directProtocols = signal({}); // peer -> Auto or explicit override
export const preferDoubleRatchet = signal(true);
const autoProtocols = signal({}); // Auto can upgrade to NDR, never silently downgrade
export const protocolChecking = signal(null);
export const directPreference = (peer) => directProtocols.value[peer] ?? 'auto';
export const directProtocol = (peer) => directPreference(peer) === 'auto' ? autoProtocols.value[peer] ?? 'nip17' : directPreference(peer);
const protocolChecks = new Map();
let historyReady = Promise.resolve();
let resolveHistory;
let directChatPeer;
let discovery;

function saveDirectPreference(peer, preference) {
  directProtocols.value = { ...directProtocols.value, [peer]: preference };
  storage.set(`lite:protocols:${me.value.pubkey}`, directProtocols.value);
}
function chooseAutoNdr(peer) {
  if (autoProtocols.value[peer] === 'ndr') return;
  autoProtocols.value = { ...autoProtocols.value, [peer]: 'ndr' };
  storage.set(`lite:auto-protocols:${me.value.pubkey}`, autoProtocols.value);
}
function preserveCachedProtocols(messages) {
  // Pre-existing cached history keeps its transport until the person chooses Auto.
  for (const message of messages) if (message.peer && directProtocols.value[message.peer] === undefined)
    saveDirectPreference(message.peer, message.protocol === 'ndr' ? 'ndr' : 'nip17');
}
function stopDiscovery() {
  discovery?.close();
  discovery = null;
  protocolChecking.value = null;
}
export function closeDirectChat() {
  directChatPeer = null;
  stopDiscovery();
}
export function openDirectChat(peer) {
  closeDirectChat();
  directChatPeer = peer;
  protocolChecks.delete(peer); // Reopening can discover newly enabled devices.
  void historyReady.then(() => { if (directChatPeer === peer) return prepareDirectProtocol(peer); });
  return () => { if (directChatPeer === peer) closeDirectChat(); };
}
export function setPreferDoubleRatchet(enabled) {
  preferDoubleRatchet.value = !!enabled;
  storage.set(`lite:prefer-ndr:${me.value.pubkey}`, !!enabled);
  protocolChecks.clear();
  stopDiscovery();
  if (directChatPeer) void prepareDirectProtocol(directChatPeer);
}
export async function prepareDirectProtocol(peer) {
  const account = me.value;
  await historyReady;
  if (!account || me.value !== account) return;
  if (directProtocols.value[peer] === undefined) saveDirectPreference(peer, 'auto');
  if (directPreference(peer) !== 'auto' || !preferDoubleRatchet.value || directProtocol(peer) === 'ndr') return Promise.resolve();
  if (protocolChecks.has(peer)) return protocolChecks.get(peer);
  const signer = me.value;
  const active = () => me.value === signer && directPreference(peer) === 'auto' && preferDoubleRatchet.value;
  const live = peer === directChatPeer;
  if (live) protocolChecking.value = peer;
  const watcher = watchNdrCapability({
    peer,
    subscribe: (filter, callbacks) => {
      const sub = transport.subscribe('ndr', filter, callbacks);
      return () => sub.close();
    },
    onCapability: (supported) => {
      if (!active() || !supported) return;
      chooseAutoNdr(peer);
      startNdr().catch((error) => { if (active()) notify(`Encrypted messaging unavailable: ${error.message}`); });
    },
  });
  if (live) discovery = watcher;
  const checked = watcher.initial.finally(() => {
    if (me.value === signer && discovery === watcher) protocolChecking.value = null;
    if (!live) watcher.close();
  });
  protocolChecks.set(peer, checked);
  return checked;
}
let ndrClient;
let ndrStarting;
let ndrGeneration = 0;
let releaseNdrLock;
const ndrEdits = new Map();
const ndrDeletions = new Map();
const ndrExpiryTimers = new Map();

function stopNdr() {
  ndrGeneration++;
  const closing = ndrClient?.close();
  const starting = ndrStarting;
  ndrClient = null;
  ndrStarting = null;
  const release = releaseNdrLock;
  releaseNdrLock = null;
  // A signer approval may stay open indefinitely. The closed adapter rejects
  // late callbacks and storage writes; do not hold sign-out hostage to it.
  starting?.catch(() => {});
  return Promise.allSettled([closing]).then(() => release?.());
}

async function lockNdr(account) {
  if (!navigator.locks) throw new Error('This browser cannot safely store encrypted chats. Try an up-to-date browser.');
  return new Promise((resolve, reject) => {
    navigator.locks.request(`anagram-lite:ndr:${account}`, { ifAvailable: true }, async (lock) => {
      if (!lock) { reject(new Error('Encrypted messaging is active in another tab. Close it and try again.')); return; }
      await new Promise((release) => resolve(release));
    }).catch(reject);
  });
}

function startNdr() {
  if (ndrStarting) return ndrStarting;
  const signer = me.value;
  const generation = ndrGeneration;
  const active = () => me.value === signer && generation === ndrGeneration;
  ndrStarting = (async () => {
    const release = await lockNdr(signer.pubkey);
    if (!active()) { release(); throw new Error('Account changed'); }
    releaseNdrLock = release;
    const { createNdrClient } = await import('./ndr.js');
    if (!active()) throw new Error('Account changed');
    const client = createNdrClient({
      owner: signer.pubkey,
      storage: db.ndrStorage(signer.pubkey),
      sign: (event) => {
        if (!active()) throw new Error('Account changed');
        return signer.sign(event);
      },
      subscribe: (filter, callback) => {
        const sub = transport.subscribe('ndr', filter, { onevent: callback });
        return () => sub.close();
      },
      fetch: (filter) => transport.queryConfirmed('ndr', filter),
      publish: async (event) => {
        if (!active()) throw new Error('Account changed');
        // NDR registration and discovery use this same shared set. Do not look
        // up a recipient's public relay list on the account's authenticated pool.
        return transport.publish('ndr', event, signer);
      },
      receive: async (event, peer) => {
        if (!active()) throw new Error('Account changed');
        await receiveNdr(signer, event, peer);
      },
      delivery: async (id, status, context) => {
        if (!active() || !id) return;
        const m = Object.values(dms.value).flat().find((m) => m.id === id);
        if (!m || context && context.recipientOwnerPubkey !== m.peer) return;
        setStatus(id, status === 'sent' ? null : 'failed');
        if (status === 'sent') {
          markSent(m);
          await db.saveDirectMessages([current(m)]);
        }
      },
    });
    ndrClient = client;
    try {
      await client.start();
      if (!active()) throw new Error('Account changed');
      storage.set(`lite:ndr:${signer.pubkey}`, true);
      return client;
    } catch (error) {
      await client.close();
      if (active()) { ndrClient = null; ndrStarting = null; releaseNdrLock?.(); releaseNdrLock = null; }
      throw error;
    }
  })().catch((error) => {
    if (active()) { ndrStarting = null; releaseNdrLock?.(); releaseNdrLock = null; }
    throw error;
  });
  return ndrStarting;
}

window.addEventListener('online', () => ndrClient?.retry().catch(() => {}));

export async function setDirectProtocol(peer, protocol) {
  if (!['auto', 'nip17', 'ndr'].includes(protocol)) throw new Error('Unknown message encryption');
  // A failed device registration must not undo the user's encryption choice.
  saveDirectPreference(peer, protocol);
  if (protocol === 'ndr') chooseAutoNdr(peer);
  protocolChecks.delete(peer);
  if (directChatPeer === peer) stopDiscovery();
  if (protocol === 'ndr') await startNdr();
  if (protocol === 'auto') await prepareDirectProtocol(peer);
}

const ndrExpiresAt = (row) => row.protocol === 'ndr' ? Number(row.tags?.find((t) => t[0] === 'expiration')?.[1]) || Infinity : Infinity;
function scheduleNdrExpiry(row) {
  const remaining = ndrExpiresAt(row) * 1000 - Date.now();
  if (!Number.isFinite(remaining) || ndrExpiryTimers.has(row.id)) return;
  if (remaining <= 0) {
    if (me.value?.pubkey === row.account) removeMessage(row.id, row.pubkey);
    db.deleteDirectMessage(row.account, row.id).catch(() => {});
    return;
  }
  ndrExpiryTimers.set(row.id, setTimeout(() => {
    ndrExpiryTimers.delete(row.id);
    scheduleNdrExpiry(row);
  }, Math.min(remaining, 2147483647)));
}

function applyNdrEdit(message) {
  const edit = ndrEdits.get(`${message.id}:${message.pubkey}:${message.peer}`);
  return edit && edit.created_at >= message.created_at && message.protocol === 'ndr' && edit.pubkey === message.pubkey && edit.peer === message.peer
    ? { ...message, content: edit.content, edited: true } : message;
}

function rememberNdrEdit(row) {
  const target = row.tags.find((t) => t[0] === 'e')?.[1];
  const key = `${target}:${row.pubkey}:${row.peer}`;
  const previous = ndrEdits.get(key);
  const order = (r) => `${String(r.created_at).padStart(12, '0')}:${String(r.tags.find((t) => t[0] === 'ms')?.[1] ?? r.created_at * 1000).padStart(16, '0')}:${r.id}`;
  if (!previous || order(row) > order(previous)) ndrEdits.set(key, row);
  return target;
}

async function receiveNdr(signer, event, peer) {
  if (!Number.isSafeInteger(event.created_at) || event.created_at < 0 || event.created_at > nostr.now() + 300) return;
  if (isBlocked(peer) || event.created_at <= (clearedAt.value[peer] ?? 0)) return;
  const expiration = event.tags.find((t) => t[0] === 'expiration')?.[1];
  if (expiration !== undefined && (!Number.isSafeInteger(Number(expiration)) || Number(expiration) <= nostr.now())) return;
  const base = { ...event, account: signer.pubkey, peer, protocol: 'ndr' };
  if (event.kind === 5) {
    if (event.content !== '') return;
    const ids = event.tags.filter((t) => t[0] === 'e' && /^[a-f0-9]{64}$/.test(t[1])).map((t) => t[1]);
    // A deletion from another author must not overwrite the original cached row.
    await db.saveDirectMessages(ids.map((id) => ({ account: signer.pubkey, id: `ndr-delete:${event.pubkey}:${id}`, deletedId: id, deletedBy: event.pubkey, created_at: Math.max(event.created_at, ndrDeletions.get(`${id}:${event.pubkey}`) ?? 0) })));
    if (me.value === signer) {
      for (const id of ids) ndrDeletions.set(`${id}:${event.pubkey}`, Math.max(event.created_at, ndrDeletions.get(`${id}:${event.pubkey}`) ?? 0));
      const eligible = ids.filter((id) => !(dms.value[peer] ?? []).some((m) => m.id === id && m.created_at > event.created_at));
      applyDeletions(eligible, event.pubkey);
    }
  } else if (event.kind === 1009) {
    const targets = event.tags.filter((t) => t[0] === 'e');
    const kinds = event.tags.filter((t) => t[0] === 'k');
    const ms = event.tags.filter((t) => t[0] === 'ms');
    if (targets.length !== 1 || !/^[a-f0-9]{64}$/.test(targets[0][1]) || !event.content.trim() ||
        new TextEncoder().encode(event.content).length > 32768 || kinds.length !== 1 || kinds[0][1] !== '14' ||
        ms.length > 1 || ms.length && (!/^\d+$/.test(ms[0][1]) || !Number.isSafeInteger(Number(ms[0][1])) || Math.floor(Number(ms[0][1]) / 1000) !== event.created_at)) return;
    await db.saveDirectMessages([base]);
    if (me.value !== signer) return;
    const target = rememberNdrEdit(base);
    const thread = dms.value[peer] ?? [];
    dms.value = { ...dms.value, [peer]: thread.map((m) => m.id === target ? applyNdrEdit(m) : m) };
  } else if (event.kind === 7 && reactionTarget(event)) {
    const row = { ...base, target: reactionTarget(event), emoji: nostr.normalizeEmoji(event.content) };
    await db.saveDirectMessages([row]);
    if (me.value === signer) addReactions([row]);
  } else if (event.kind === 14 && event.content && !isMessageDeleted(base) && !isHidden(event.id)) {
    const row = { ...base, reply: event.tags.find((t) => t[0] === 'e' && (!t[3] || t[3] === 'reply'))?.[1] };
    await db.saveDirectMessages([row]);
    if (me.value !== signer) return;
    if (directProtocols.value[peer] === undefined) saveDirectPreference(peer, 'auto');
    if (directPreference(peer) === 'auto') chooseAutoNdr(peer);
    const seen = dms.value[peer]?.some((m) => m.id === row.id);
    addMessages([row]);
    requestProfiles([peer]);
    if (!seen) emitIncoming({ peer }, row);
  }
}

async function sendNdrRumor(peer, kind, content, tags, onRumor) {
  const signer = me.value;
  const client = await startNdr();
  if (me.value !== signer) throw new Error('Account changed');
  const nowMs = Date.now();
  const event = nostr.makeRumor(signer.pubkey, kind, content, [...tags, ['ms', String(nowMs)]], Math.floor(nowMs / 1000));
  onRumor?.(event);
  await client.send(peer, event);
  return event;
}

// 'verified' | 'failed' | 'checking' | 'unchecked' | 'none' for the claimed address.
export function nip05State(pk) {
  const address = profiles.value[pk]?.nip05;
  if (!address) return { state: 'none', address: '' };
  const known = nip05Verified.value[pk];
  if (known === address) return { state: 'verified', address };
  if (known === '') return { state: 'failed', address };
  return { state: nip05Checking.has(`${pk}:${address}`) ? 'checking' : 'unchecked', address };
}

// ---------- Direct messages ----------

const seenWraps = new Set();
// Deletion requests seen, keyed by message id -> the pubkeys that asked. A deletion only
// counts when the asker is the message's author, so a stranger's kind 5 for someone
// else's id can never hide (or later resurrect) that message.
const deleted = new Map();
const isDeleted = (id, author) => deleted.get(id)?.has(author) ?? false;
const markDeleted = (id, author) => (deleted.get(id) ?? deleted.set(id, new Set()).get(id)).add(author);
// Tombstone rows live under their own key so they can never overwrite a message row.
const tombstone = (account, id, author) => ({ account, id: `del:${id}:${author}`, target: id, deletedBy: author });
const isMessageDeleted = (m) => isDeleted(m.id, m.pubkey) || (ndrDeletions.get(`${m.id}:${m.pubkey}`) ?? -1) >= m.created_at;
let queue = Promise.resolve();
let pendingRows = [];
let flushTimer;

// ---------- Edits ----------
// Like Anagram, a replacement takes the original's place and remembers every earlier
// id (prev), so reactions, quotes and deletions aimed at any version still match.

export const editTarget = (m) => m.tags?.find((t) => t[0] === 'e' && t[3] === 'edit')?.[1];
export const rootId = (m) => m.prev?.[0] ?? m.id;
const knownIds = (m) => [m.id, ...(m.prev ?? [])];

const removedById = new Map(); // deleted messages, so a later replacement can inherit their ids

function collapseEdits(thread, onMerged) {
  // A replacement whose predecessor was already deleted (the edit flow deletes it first)
  // still inherits the predecessor's id chain.
  thread = thread.map((m) => {
    const target = editTarget(m);
    if (!target || m.prev?.includes(target) || thread.some((x) => x.id === target)) return m;
    const gone = removedById.get(target);
    if (!isDeleted(target, m.pubkey) && !(gone && gone.pubkey === m.pubkey)) return m;
    const merged = { ...m, prev: nostr.uniq([...(gone?.prev ?? []), target, ...(m.prev ?? [])]), reply: m.reply ?? gone?.reply };
    onMerged?.(merged);
    return merged;
  });
  let list = thread;
  for (let pass = 0; pass < 8; pass++) {
    const byId = new Map();
    for (const m of list) for (const id of knownIds(m)) byId.set(id, m);
    const superseded = new Set();
    const replaced = new Map();
    for (const m of list) {
      const target = editTarget(m);
      const old = target && byId.get(target);
      if (!old || old === m || old.pubkey !== m.pubkey || superseded.has(old.id) || replaced.has(old.id)) continue;
      superseded.add(old.id);
      const merged = {
        ...m,
        prev: nostr.uniq([...(old.prev ?? []), old.id, ...(m.prev ?? [])]).filter((id) => id !== m.id),
        reply: m.reply ?? old.reply,
      };
      replaced.set(m.id, merged);
      onMerged?.(merged);
    }
    if (!superseded.size) break;
    list = list.filter((m) => !superseded.has(m.id)).map((m) => replaced.get(m.id) ?? m);
  }
  return list;
}

// The stored row should be the merged in-memory version (with its edit id chain).
const current = (m) => dms.value[m.peer]?.find((x) => x.id === m.id) ?? m;

function addMessages(list) {
  if (!list.length) return;
  const next = { ...dms.value };
  const touched = new Set();
  for (const m of list) {
    scheduleNdrExpiry(m);
    if (m.protocol === 'ndr' && m.kind !== 14 || ndrExpiresAt(m) <= nostr.now() || isMessageDeleted(m)) continue;
    if (isBlocked(m.pubkey) || isBlocked(m.peer) || m.created_at <= (clearedAt.value[m.peer] ?? 0) || isHidden(m.id)) continue;
    const thread = next[m.peer] ?? [];
    if (thread.some((x) => knownIds(x).includes(m.id))) continue;
    next[m.peer] = [...thread, applyNdrEdit(m)];
    touched.add(m.peer);
  }
  // Persist merged id chains so reactions to earlier versions still match after reload.
  for (const peer of touched) next[peer] = collapseEdits(next[peer].sort((a, b) => a.created_at - b.created_at), queueSave);
  dms.value = next;
}

function removeMessage(id, author) {
  for (const thread of Object.values(dms.value))
    for (const m of thread) if (m.id === id && m.pubkey === author) removedById.set(id, m);
  const next = {};
  for (const [peer, thread] of Object.entries(dms.value))
    next[peer] = thread.filter((m) => !(m.id === id && m.pubkey === author));
  dms.value = next;
}

// ---------- Reactions & deletions (shared by DMs and rooms) ----------

function addReactions(list) {
  const next = { ...reactions.value };
  let changed = false;
  for (const r of list) {
    if (isDeleted(r.id, r.pubkey)) continue;
    const current = next[r.target] ?? [];
    if (current.some((x) => x.id === r.id)) continue;
    next[r.target] = [...current, { id: r.id, pubkey: r.pubkey, emoji: r.emoji }];
    changed = true;
  }
  if (changed) reactions.value = next;
}

// Apply deletion requests; only the original author can delete.
function applyDeletions(ids, author) {
  for (const id of ids) markDeleted(id, author);
  const gone = new Set(ids);
  const next = {};
  for (const [target, list] of Object.entries(reactions.value))
    next[target] = list.filter((r) => !(gone.has(r.id) && r.pubkey === author));
  reactions.value = next;
  for (const id of ids) removeMessage(id, author);
  for (const [address, state] of Object.entries(roomState.value)) {
    for (const m of state.messages) if (gone.has(m.id) && m.pubkey === author) removedById.set(m.id, m);
    db.deleteRoomMessages(state.messages.filter((m) => gone.has(m.id) && m.pubkey === author).map((m) => m.id)).catch(() => {});
    const kept = state.messages.filter((m) => !(gone.has(m.id) && m.pubkey === author));
    if (kept.length !== state.messages.length) setRoom(address, { messages: kept });
  }
}

const reactionTarget = (event) => event.tags.find((t) => t[0] === 'e' && /^[a-f0-9]{64}$/.test(t[1]))?.[1];

function queueSave(row) {
  // Late writes for an account that is no longer active (e.g. just signed out) are dropped.
  if (row.account !== me.value?.pubkey || ndrExpiresAt(row) <= nostr.now()) return;
  pendingRows.push(row);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushSaves, 300);
}

function flushSaves() {
  clearTimeout(flushTimer);
  const rows = pendingRows;
  pendingRows = [];
  return rows.length ? db.saveDirectMessages(rows).catch((e) => notify(`Saving messages failed: ${e.message}`)) : Promise.resolve();
}

function peerOf(rumor, self) {
  const others = nostr
    .uniq([rumor.pubkey, ...rumor.tags.filter((t) => t[0] === 'p').map((t) => t[1])])
    .filter((pk) => pk !== self);
  if (others.length > 1) return null; // group DMs are out of scope
  return others[0] ?? self;
}

async function handleWrap(wrap) {
  const signer = me.value;
  if (!signer || seenWraps.has(wrap.id)) return;
  seenWraps.add(wrap.id);
  if (await db.hasWrap(signer.pubkey, wrap.id).catch(() => false)) return;
  let rumor;
  try {
    rumor = await nostr.unwrap(signer, wrap);
  } catch (e) {
    // Bad data is final; signer trouble (locked extension, bunker timeout) retries next session.
    if (e.permanent) markWrapDone(signer.pubkey, wrap.id);
    else db.markWrapFailure(signer.pubkey, wrap.id).catch(() => {});
    return;
  }
  if (me.value !== signer) return;
  const peer = peerOf(rumor, signer.pubkey);
  if (peer && rumor.kind === 5) {
    const ids = rumor.tags.filter((t) => t[0] === 'e').map((t) => t[1]);
    applyDeletions(ids, rumor.pubkey);
    for (const id of ids) queueSave(tombstone(signer.pubkey, id, rumor.pubkey));
  } else if (peer && rumor.kind === 7 && reactionTarget(rumor)) {
    const r = { account: signer.pubkey, id: rumor.id, peer, pubkey: rumor.pubkey, kind: 7, target: reactionTarget(rumor), emoji: nostr.normalizeEmoji(rumor.content), created_at: rumor.created_at };
    batchIncoming({ reaction: r });
    queueSave(r);
  } else if (peer && (rumor.kind === 14 || rumor.kind === 15) && rumor.content) {
    if (!isDeleted(rumor.id, rumor.pubkey)) {
      const reply = rumor.tags.find((t) => t[0] === 'e' && t[3] === 'reply')?.[1];
      const edited = nostr.isEdited(rumor.tags);
      const m = {
        account: signer.pubkey,
        id: rumor.id,
        peer,
        pubkey: rumor.pubkey,
        created_at: rumor.created_at,
        kind: rumor.kind,
        content: rumor.content,
        tags: rumor.tags,
        reply,
        edited,
      };
      batchIncoming({ message: m });
      requestProfiles([peer]);
      if (!edited) emitIncoming({ peer }, m);
    }
  }
  markWrapDone(signer.pubkey, wrap.id);
}

// Decrypted gift wraps are applied in batches: one state update (copy, sort, edit merge)
// per burst instead of per message, which matters when syncing thousands of DMs.
let incoming = { messages: [], reactions: [] };
let incomingTimer;
function batchIncoming({ message, reaction }) {
  if (message) incoming.messages.push(message);
  if (reaction) incoming.reactions.push(reaction);
  incomingTimer ??= setTimeout(flushIncoming, 30);
}
function flushIncoming() {
  incomingTimer = undefined;
  const { messages, reactions: rs } = incoming;
  incoming = { messages: [], reactions: [] };
  const live = messages.filter((m) => !isDeleted(m.id, m.pubkey));
  // A newly received conversation stays Auto, even when its first message used
  // NIP-17. Persist that preference before caching it so reload is not migration.
  for (const message of live) if (message.account === me.value?.pubkey && directProtocols.value[message.peer] === undefined)
    saveDirectPreference(message.peer, 'auto');
  batch(() => {
    addMessages(live);
    addReactions(rs);
  });
  for (const m of live) queueSave(current(m));
}

let doneWraps = [];
let doneTimer;
function markWrapDone(account, id) {
  doneWraps.push(id);
  // Only mark wraps done after their messages are on disk, or a reload in between loses them.
  doneTimer ??= setTimeout(() => {
    doneTimer = undefined;
    const ids = doneWraps;
    doneWraps = [];
    flushIncoming();
    flushSaves().then(() => db.markWraps(account, ids).catch(() => {}));
  }, 300);
}

const enqueue = (wrap) => (queue = queue.then(() => handleWrap(wrap)).catch(() => {}));

async function startInbox() {
  const signer = me.value;
  const rows = await db.loadDirectMessages(signer.pubkey).catch(() => []);
  const messages = [];
  const saved = [];
  for (const r of rows) {
    if (r.deletedId) ndrDeletions.set(`${r.deletedId}:${r.deletedBy}`, r.created_at ?? Infinity);
    else if (r.deletedBy) markDeleted(r.target ?? r.id, r.deletedBy);
    else if (r.kind === 1009) rememberNdrEdit(r);
    else if (r.kind === 7) saved.push(r);
    else messages.push(r);
  }
  if (me.value !== signer) return; // switched account while loading
  preserveCachedProtocols(messages);
  resolveHistory?.();
  addMessages(messages.filter((m) => !isMessageDeleted(m)));
  addReactions(saved);
  for (const m of messages) if (m.status === 'pending' && m.tags) resumePending(m);
  requestProfiles(Object.keys(dms.value));

  inboxRelays.value = await nostr.fetchInboxRelays(signer.pubkey).catch(() => []);
  if (me.value !== signer) return;
  transport.setOwnRelays(inboxRelays.value);
  const syncKey = `lite:sync:${signer.pubkey}`;
  const lastSync = storage.get(syncKey, 0);
  syncing.value = true;
  inboxSub = transport.subscribe(
    'self',
    {
      kinds: [1059],
      '#p': [signer.pubkey],
      // Wraps are back-dated up to two days, so overlap generously.
      ...(lastSync ? { since: lastSync - 3 * 86400 } : { limit: 1000 }),
    },
    {
      onevent: enqueue,
      oneose: () =>
        queue.then(() => {
          if (me.value !== signer) return;
          flushIncoming();
          syncing.value = false;
          storage.set(syncKey, nostr.now());
        }),
    },
  );
}

export const dmHistoryDone = signal(false);

export async function loadOlderDirectMessages() {
  const signer = me.value;
  syncing.value = true;
  try {
    const { events, finished } = await transport.pageOlder('self', { kinds: [1059], '#p': [signer.pubkey] }, `dm:${signer.pubkey}`, 500);
    if (me.value !== signer) return;
    events.forEach(enqueue);
    await queue;
    flushIncoming();
    dmHistoryDone.value = finished;
  } finally {
    syncing.value = false;
  }
}

const theirInbox = new Map(); // peer -> Promise<relays>, cached per session
// Where to deliver to someone: their NIP-17 inbox relays, else (people who never
// published kind 10050) their NIP-65 read relays, else only the shared app relays.
const inboxOf = (peer) => {
  if (!theirInbox.has(peer))
    theirInbox.set(
      peer,
      nostr
        .fetchInboxRelays(peer)
        .then((list) => (list.length ? list : nostr.fetchReadRelays(peer)))
        .catch(() => []),
    );
  return theirInbox.get(peer);
};

// Optimistic sends: id -> 'sending' | 'failed'. No entry means a relay accepted it.
export const sendStatus = signal({});
const retries = new Map(); // failed id -> () => Promise that re-publishes
function setStatus(id, status) {
  const next = { ...sendStatus.value };
  if (status) next[id] = status;
  else delete next[id];
  sendStatus.value = next;
}
// onSent runs once a relay accepts (e.g. to clear the persisted 'pending' flag).
async function track(id, sending, retry, onSent) {
  setStatus(id, 'sending');
  try {
    await sending;
    retries.delete(id);
    setStatus(id, null);
    onSent?.();
  } catch (e) {
    retries.set(id, { retry, onSent });
    // partial: it reached shared relays but not the recipient's own; still worth a retry.
    setStatus(id, e.partial ? 'partial' : 'failed');
    notify(e.partial ? e.message : `Not sent: ${e.message}`);
  }
}
export function retrySend(id) {
  const message = Object.values(dms.value).flat().find((m) => m.id === id);
  if (message?.protocol === 'ndr') {
    setStatus(id, 'queued');
    startNdr().then(async (client) => {
      if (!message.ndrQueued) {
        const { id, pubkey, kind, content, tags, created_at } = message;
        await client.send(message.peer, { id, pubkey, kind, content, tags, created_at });
        await markNdrQueued(message);
      }
      await client.retry();
    }).catch((e) => { setStatus(id, 'failed'); notify(e.message); });
    return;
  }
  const entry = retries.get(id);
  if (entry) track(id, entry.retry(), entry.retry, entry.onSent);
}

// A sent DM is stored with status 'pending' until a relay accepts it, so a reload
// mid-send shows ⚠ (with retry) instead of a false ✓.
function resumePending(m) {
  if (m.protocol === 'ndr') {
    retries.set(m.id, { retry: () => startNdr().then((c) => c.retry()) });
    setStatus(m.id, 'queued');
    return;
  }
  const retry = () =>
    nostr.sendRumor(me.value, m.peer, m.kind ?? 14, m.content, m.tags, inboxOf(m.peer), m.created_at);
  retries.set(m.id, { retry, onSent: () => markSent(m) });
  setStatus(m.id, 'failed');
}
function markSent(m) {
  const { status: _, ...sent } = current(m);
  dms.value = { ...dms.value, [m.peer]: (dms.value[m.peer] ?? []).map((row) => row.id === m.id ? sent : row) };
  queueSave(sent);
}

export async function sendDirectMessage(peer, text, reply, edit, extraTags = []) {
  const account = me.value;
  if (!edit && directPreference(peer) === 'auto') await prepareDirectProtocol(peer);
  if (me.value !== account) throw new Error('Account changed');
  if ((edit ? edit.protocol ?? 'nip17' : directProtocol(peer)) === 'ndr')
    return sendNdrMessage(peer, text, reply, extraTags);
  const signer = me.value;
  const replyId = edit ? edit.reply : reply && rootId(reply);
  let rumor;
  // Called synchronously by sendRumor before any await, so the bubble appears instantly.
  const show = (r) => {
    rumor = r;
    const m = {
      account: signer.pubkey,
      id: r.id,
      peer,
      pubkey: signer.pubkey,
      created_at: r.created_at,
      kind: 14,
      content: text,
      reply: replyId,
      edited: !!edit,
      tags: r.tags,
    };
    addMessages([m]);
    saved = current(m);
    queueSave({ ...saved, status: 'pending' });
  };
  let saved;
  const sending = nostr.sendDirectMessage(signer, peer, text, inboxOf(peer), replyId, edit, show, extraTags);
  // A retry re-sends the same rumor, so it can't duplicate the message.
  const retry = () =>
    nostr.sendRumor(signer, peer, 14, text, rumor.tags, inboxOf(peer), rumor.created_at);
  track(rumor.id, sending, retry, () => markSent(saved));
  if (peer !== signer.pubkey) addContact(peer).catch((e) => notify(`Could not update contact list: ${e.message}`));
}

async function markNdrQueued(message) {
  if (message.account !== me.value?.pubkey) return;
  const row = { ...current(message), ndrQueued: true };
  dms.value = { ...dms.value, [row.peer]: (dms.value[row.peer] ?? []).map((m) => m.id === row.id ? row : m) };
  await db.saveDirectMessages([row]);
}

async function sendNdrMessage(peer, text, reply, extraTags) {
  const signer = me.value;
  const client = await startNdr();
  if (me.value !== signer) throw new Error('Account changed');
  const nowMs = Date.now();
  const tags = [['p', peer], ['ms', String(nowMs)], ...(reply ? [['e', rootId(reply)]] : []), ...extraTags];
  const event = nostr.makeRumor(signer.pubkey, 14, text, tags, Math.floor(nowMs / 1000));
  const message = { ...event, account: signer.pubkey, peer, protocol: 'ndr', reply: reply && rootId(reply), status: 'pending' };
  // Save plaintext before handing it to the durable ratchet queue.
  await db.saveDirectMessages([message]);
  if (me.value !== signer) throw new Error('Account changed');
  addMessages([message]);
  setStatus(event.id, 'queued');
  try {
    await client.send(peer, event);
    await markNdrQueued(message);
  } catch (error) {
    setStatus(event.id, 'failed');
    throw error;
  }
  addContact(peer).catch((e) => notify(`Could not update contact list: ${e.message}`));
}

// Edit our kind 0. Fields: name, about, picture, website, nip05.
export async function saveProfile(fields, { fresh = false } = {}) {
  const signer = me.value;
  // A brand-new key has no profile yet, so skip the lookup. Otherwise never publish over a
  // profile we could not read: that would wipe fields other clients set (lud16, banner, ...).
  const previous = fresh ? null : await nostr.fetchOwnProfile(signer.pubkey);
  if (!fresh && !previous.event && Object.keys(profiles.value[signer.pubkey] ?? {}).length)
    throw new Error("Couldn't read your current profile from the network. Try again in a moment.");
  const { event, data } = await nostr.publishProfile(signer, fields, previous);
  const p = {
    pubkey: signer.pubkey,
    created_at: event.created_at,
    name: String(data.display_name || data.name || '').slice(0, 80),
    picture: /^https:\/\//.test(data.picture ?? '') ? data.picture : '',
    nip05: data.nip05 ?? '',
    about: data.about ?? '',
    website: /^https:\/\//.test(data.website ?? '') ? data.website : '',
  };
  profiles.value = { ...profiles.value, [signer.pubkey]: p };
  db.saveProfiles([p]).catch(() => {});
}

// A brand-new key: publish a name and NIP-17 inbox relays so people can find and reach it.
export async function setUpNewAccount(name) {
  await Promise.all([publishDefaultInbox(), name.trim() ? saveProfile({ name: name.trim() }, { fresh: true }) : null]);
}

export function publishDefaultInbox() {
  return saveInboxRelays(nostr.APP_RELAYS.slice(0, 3));
}

// Publish the NIP-17 inbox list (kind 10050) and, with the same relays, the NIP-65 list
// (kind 10002) so other clients and the did:nostr document see where to find us.
export async function saveInboxRelays(list) {
  const relays = nostr.uniq(list.map((r) => nostr.normalizeRelay(r)).filter(Boolean));
  if (!relays.length) throw new Error('Add at least one wss:// relay.');
  if (relays.length > 8) throw new Error('Up to 8 inbox relays.');
  const signer = me.value;
  await nostr.publishInboxRelays(signer, relays);
  nostr.publishRelayList(signer, relays).catch(() => {}); // best effort; the inbox list is what matters
  if (me.value === signer) {
    inboxRelays.value = relays;
    transport.setOwnRelays(relays);
  }
  return relays;
}

export const relayDirectory = signal(null); // suggestions from nostr.social, loaded on demand
export function loadRelayDirectory() {
  if (relayDirectory.value) return;
  nostr
    .fetchRelayDirectory()
    .then((list) => (relayDirectory.value = list))
    .catch(() => (relayDirectory.value = []));
}


let contactsLoaded = null; // resolves once the contact list has been read (or failed)
let contactQueue = Promise.resolve(); // serialises list updates so concurrent adds can't overwrite each other

function loadContacts() {
  return (contactsLoaded = readContacts());
}

async function readContacts() {
  const signer = me.value;
  try {
    const list = await nostr.fetchContactList(signer);
    if (me.value !== signer) return;
    contactList = list;
    contacts.value = list.pubkeys;
    requestProfiles(list.pubkeys);
  } catch (e) {
    notify(`Could not read your contact list: ${e.message}`);
  }
}

// Anagram adds people you message to your private contact list; do the same.
function addContact(pubkey) {
  const run = contactQueue.then(() => addContactNow(pubkey));
  contactQueue = run.catch(() => {});
  return run;
}

async function addContactNow(pubkey) {
  const signer = me.value;
  await contactsLoaded;
  if (me.value !== signer || contacts.value.includes(pubkey)) return;
  // Never publish over a list we could not read: that would wipe the user's contacts.
  if (!contactList) throw new Error('your contact list has not loaded yet');
  const latest = await nostr.fetchContactList(signer);
  const base = latest.event && latest.event.created_at > (contactList.event?.created_at ?? 0) ? latest : contactList;
  const pubkeys = nostr.uniq([...base.pubkeys, pubkey]);
  const event = await nostr.publishContactList(signer, pubkeys, base.event);
  if (me.value !== signer) return;
  contactList = { event, pubkeys };
  contacts.value = pubkeys;
}

export const conversations = computed(() => {
  const rows = Object.entries(dms.value)
    .filter(([, thread]) => thread.length)
    .map(([peer, thread]) => ({ peer, last: thread[thread.length - 1] }));
  const known = new Set(rows.map((r) => r.peer));
  for (const pk of contacts.value)
    if (!known.has(pk) && !isBlocked(pk) && !clearedAt.value[pk]) rows.push({ peer: pk, last: null });
  return rows.sort((a, b) => (b.last?.created_at ?? 0) - (a.last?.created_at ?? 0));
});
export const chatList = computed(() => conversations.value.filter(({ peer }) => isKnown(peer)));
export const requests = computed(() => conversations.value.filter(({ peer, last }) => last && !isKnown(peer)));

// ---------- Public rooms ----------

function setRoom(address, patch) {
  const current = roomState.value[address] ?? { messages: [] };
  roomState.value = { ...roomState.value, [address]: { ...current, ...patch } };
}

// Blocked authors are dropped at the source so they never reach unread counts,
// notifications, previews or search.
const blockedIn = (address) => {
  const room = roomState.value[address]?.room;
  return (pubkey) => !!room && nostr.roomPolicy(room, pubkey) === 'blocked';
};

// Room messages are cached on the device (public signed events); saves are batched per room.
const roomSaves = new Map(); // address -> events waiting to be written
let roomSaveTimer;
function queueRoomSave(address, events) {
  roomSaves.set(address, [...(roomSaves.get(address) ?? []), ...events]);
  clearTimeout(roomSaveTimer);
  roomSaveTimer = setTimeout(() => {
    for (const [room, list] of roomSaves) db.saveRoomMessages(room, list).catch(() => {});
    roomSaves.clear();
  }, 500);
}

function addRoomMessages(address, events, { fromCache = false } = {}) {
  const roomBlocks = blockedIn(address);
  events = events.filter((e) => !roomBlocks(e.pubkey) && !isBlocked(e.pubkey));
  const current = roomState.value[address]?.messages ?? [];
  const ids = new Set(current.flatMap(knownIds));
  const fresh = events.filter(
    (e) => !ids.has(e.id) && !isDeleted(e.id, e.pubkey) && !isHidden(e.id) && nostr.validRoomMessage(e, address),
  );
  if (!fresh.length) return;
  setRoom(address, {
    messages: collapseEdits([...current, ...fresh].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))),
  });
  if (!fromCache) queueRoomSave(address, fresh);
  requestProfiles(nostr.uniq(fresh.map((e) => e.pubkey)));
  const room = roomState.value[address]?.room;
  if (room && joinedRooms.value.some((r) => r.address === address))
    for (const e of fresh) if (!editTarget(e)) emitIncoming({ room }, e);
}

function saveJoined(list) {
  joinedRooms.value = list;
  storage.set(`lite:rooms:${me.value.pubkey}`, list);
}

function roomEntry(room) {
  // The signed definition is kept so the room can render before (or without) the network.
  return { address: room.address, owner: room.owner, slug: room.slug, relays: room.relays, name: room.name, picture: room.picture, event: room.event };
}

function remember(room) {
  const entry = roomEntry(room);
  saveJoined([entry, ...joinedRooms.value.filter((r) => r.address !== room.address)]);
}

export async function openRoom(pointer) {
  const { address } = pointer;
  if (roomSubs.has(address) || roomState.value[address]?.loading) return;
  if (!me.value) return;
  setRoom(address, { loading: true, error: '' });
  const owner = me.value;
  // Show the remembered room and cached history straight away (and offline); the network fills in after.
  const remembered = joinedRooms.value.find((r) => r.address === address)?.event;
  if (remembered && !roomState.value[address]?.room)
    try {
      setRoom(address, { room: nostr.parseRoom(remembered, address) });
    } catch {}
  db.loadRoomMessages(address)
    .then((cached) => me.value === owner && addRoomMessages(address, cached, { fromCache: true }))
    .catch(() => {});
  let room;
  let stale = '';
  try {
    room = await nostr.fetchRoom(pointer);
  } catch (e) {
    if (me.value !== owner) return;
    // Keep the remembered (signed) definition and still go live; just say it couldn't refresh.
    room = roomState.value[address]?.room;
    if (!room) return setRoom(address, { loading: false, error: e.message });
    stale = e.message;
  }
  if (me.value !== owner) return; // switched account while loading
  // A newer room definition may block people whose messages are already loaded.
  const hidden = (pk) => nostr.roomPolicy(room, pk) === 'blocked' || isBlocked(pk);
  setRoom(address, { room, loading: false, stale, messages: (roomState.value[address]?.messages ?? []).filter((m) => !hidden(m.pubkey)) });
  if (joinedRooms.value.some((r) => r.address === address)) {
    // Refresh name/picture without moving the room in the list.
    const entry = roomEntry(room);
    saveJoined(joinedRooms.value.map((r) => (r.address === address ? entry : r)));
  }
  requestProfiles([room.owner]);
  if (room.pinned)
    nostr
      .fetchEvent({ room }, room.pinned)
      .then((e) => e && nostr.validRoomMessage(e, address) && setRoom(address, { pinnedEvent: e }))
      .catch(() => {});
  roomSubs.set(
    address,
    transport.subscribe(
      { room },
      { kinds: [9], '#a': [address], limit: 100 },
      { onevent: (e) => addRoomMessages(address, [e]) },
    ),
  );
  roomSubs.set(
    `${address}:activity`,
    transport.subscribe(
      { room },
      { kinds: [5, 7], '#h': [address], limit: 500 },
      { onevent: (e) => roomActivity(address, e) },
    ),
  );
}

function roomActivity(address, event) {
  if (!event.tags.some((t) => t[0] === 'h' && t[1] === address)) return;
  if (event.kind === 7 && reactionTarget(event))
    addReactions([{ id: event.id, pubkey: event.pubkey, target: reactionTarget(event), emoji: nostr.normalizeEmoji(event.content) }]);
  else if (event.kind === 5)
    applyDeletions(event.tags.filter((t) => t[0] === 'e').map((t) => t[1]), event.pubkey);
}

function dropRoomMessage(address, id) {
  const state = roomState.value[address];
  if (state) setRoom(address, { messages: state.messages.filter((m) => m.id !== id) });
  db.deleteRoomMessages([id]).catch(() => {});
}

// Undo a local deletion (used when publishing it failed).
function undoDeletions(ids, author, restore) {
  for (const id of ids) deleted.get(id)?.delete(author);
  restore();
}

// Telegram-style toggle: same emoji again removes our reaction. The change shows at
// once; publishing happens in the background and is rolled back if every relay refuses.
export async function toggleReaction(context, message, emoji) {
  const signer = me.value;
  const mine = knownIds(message)
    .flatMap((id) => (reactions.value[id] ?? []).map((r) => ({ ...r, target: id })))
    .filter((r) => r.pubkey === signer.pubkey && r.emoji === emoji);
  // React to the original, as Anagram does; earlier ids map to the current version.
  message = { ...message, id: rootId(message) };
  const ids = mine.map((r) => r.id);
  const fail = (what, undo) => (e) => {
    undo();
    notify(`${what} failed: ${e.message}`);
  };
  if (context.room) {
    const room = roomState.value[context.room].room;
    if (mine.length) {
      const event = await nostr.signRoomDeletion(signer, room, ids, 7);
      applyDeletions(ids, signer.pubkey);
      nostr.publish({ room }, event, signer).catch(fail('Removing reaction', () => undoDeletions(ids, signer.pubkey, () => addReactions(mine))));
    } else {
      const event = await nostr.signRoomReaction(signer, room, message, emoji);
      roomActivity(room.address, event);
      nostr.publish({ room }, event, signer).catch(fail('Reaction', () => applyDeletions([event.id], signer.pubkey)));
    }
    return;
  }
  const peer = context.peer;
  const send = (kind, content, tags, onRumor) => message.protocol === 'ndr'
    ? sendNdrRumor(peer, kind, content, [['p', peer], ...tags], onRumor)
    : nostr.sendRumor(signer, peer, kind, content, [['p', peer], ...tags], inboxOf(peer), nostr.now(), onRumor);
  if (mine.length) {
    applyDeletions(ids, signer.pubkey);
    for (const id of ids) queueSave(tombstone(signer.pubkey, id, signer.pubkey));
    send(5, '', [...ids.map((id) => ['e', id]), ['k', '7']]).catch(
      fail('Removing reaction', () =>
        undoDeletions(ids, signer.pubkey, () => {
          addReactions(mine);
          for (const r of mine) queueSave({ account: signer.pubkey, peer, kind: 7, ...r });
        }),
      ),
    );
  } else {
    let added;
    send(7, emoji, [['e', message.id], ['p', message.pubkey], ['k', String(message.kind ?? 14)]], (rumor) => {
      added = { account: signer.pubkey, id: rumor.id, peer, pubkey: signer.pubkey, kind: 7, target: message.id, emoji, created_at: rumor.created_at };
      addReactions([added]);
      queueSave(added);
    }).catch(
      fail('Reaction', () => {
        if (!added) return; // NDR activation can fail before an optimistic rumor exists.
        applyDeletions([added.id], signer.pubkey);
        queueSave(tombstone(signer.pubkey, added.id, signer.pubkey));
      }),
    );
  }
}

// Reply targets that aren't loaded yet: fetch just that message so the quote can show.
export const quotes = signal({}); // id -> event | null (not found)
const quoteFetches = new Set();
export function fetchQuote(address, id) {
  if (quoteFetches.has(id)) return;
  quoteFetches.add(id);
  const room = roomState.value[address]?.room;
  if (!room) return;
  nostr
    .fetchEvent({ room }, id)
    .then((e) => (quotes.value = { ...quotes.value, [id]: e && nostr.validRoomMessage(e, address) ? e : null }))
    .catch(() => {});
}

// Page back through a room's history until a message is loaded (for jumping to it).
export async function loadUntil(address, id, maxPages = 10) {
  const has = () => roomState.value[address]?.messages.some((m) => m.id === id || m.prev?.includes(id));
  for (let i = 0; i < maxPages && !has() && !roomState.value[address]?.exhausted; i++) await loadOlderRoomMessages(address);
  return has();
}


export async function loadOlderRoomMessages(address) {
  const state = roomState.value[address];
  if (!state?.room) return;
  const room = state.room;
  const oldest = state.messages[0]?.created_at;
  const { events, finished } = await transport.pageOlder({ room }, { kinds: [9], '#a': [address] }, `room:${address}`, 100, oldest);
  addRoomMessages(address, events);
  // Reactions and deletions for the older messages too, or deleted ones would reappear.
  const ids = nostr.uniq(events.map((e) => e.id));
  for (let i = 0; i < ids.length; i += 100) {
    const activity = await transport.query({ room }, { kinds: [5, 7], '#e': ids.slice(i, i + 100) }).catch(() => []);
    for (const e of activity) roomActivity(address, e);
  }
  if (finished) setRoom(address, { exhausted: true });
}

export function joinRoom(room) {
  remember(room);
}

// ---------- Room owner tools ----------

// Re-sign the definition with changes and apply it locally (newest definition wins).
export async function updateRoom(address, changes) {
  const room = roomState.value[address]?.room;
  if (!room) throw new Error('Room not loaded.');
  const next = await nostr.updateRoom(me.value, room, changes);
  const hidden = (pk) => nostr.roomPolicy(next, pk) === 'blocked' || isBlocked(pk);
  const patch = { room: next, messages: (roomState.value[address]?.messages ?? []).filter((m) => !hidden(m.pubkey)) };
  if (changes.pinned !== undefined)
    patch.pinnedEvent = changes.pinned ? (roomState.value[address].messages.find((m) => m.id === changes.pinned) ?? roomState.value[address].pinnedEvent ?? null) : null;
  setRoom(address, patch);
  if (joinedRooms.value.some((r) => r.address === address)) saveJoined(joinedRooms.value.map((r) => (r.address === address ? roomEntry(next) : r)));
  return next;
}

// 'trusted' | 'blocked' | 'plain' for a member; blocking wins over trust (Anagram).
export function setMemberPolicy(address, pubkey, policy) {
  const room = roomState.value[address]?.room;
  if (!room) throw new Error('Room not loaded.');
  const trusted = room.trusted.filter((k) => k !== pubkey);
  const blocked = room.blocked.filter((k) => k !== pubkey);
  if (policy === 'trusted') trusted.push(pubkey);
  if (policy === 'blocked') blocked.push(pubkey);
  return updateRoom(address, { trusted, blocked });
}

export const pinMessage = (address, id) => updateRoom(address, { pinned: id ?? '' });

export function leaveRoom(address) {
  saveJoined(joinedRooms.value.filter((r) => r.address !== address));
  for (const key of [address, `${address}:activity`]) {
    roomSubs.get(key)?.close();
    roomSubs.delete(key);
  }
  const next = { ...roomState.value };
  delete next[address];
  roomState.value = next;
  go('');
}

export async function createRoom(input) {
  const room = await nostr.createRoom(me.value, input);
  remember(room);
  return room;
}

export async function sendRoomMessage(address, text, reply, extraTags = []) {
  const room = roomState.value[address].room;
  let onSigned;
  const signed = new Promise((resolve) => (onSigned = resolve));
  const sending = nostr.sendRoomMessage(me.value, room, text, reply, null, (e) => {
    // Signed: show it now; publishing continues in the background.
    addRoomMessages(address, [e]);
    onSigned(e);
  }, extraTags);
  // Signing is the only wait (instant for local keys). A signing error rejects here.
  sending.catch(() => {}); // publish failures are reported by track()
  const event = await Promise.race([signed, sending.then(() => signed)]);
  track(event.id, sending, () => nostr.publish({ room }, event, me.value));
}

// Forward a copy like Anagram does: same text plus its NIP-92 attachments, no attribution.
export function forwardMessage(target, message) {
  const tags = (message.tags ?? []).filter((t) => t[0] === 'imeta');
  return target.room ? sendRoomMessage(target.room, message.content, null, tags) : sendDirectMessage(target.peer, message.content, null, null, tags);
}

// Delete our own message: shown at once, NIP-09 request published in the background
// (restored with a notice if every relay refuses). Honoured by Anagram and most clients.
export async function deleteMessage(context, message, { onlyCurrent = false, background = true } = {}) {
  const signer = me.value;
  if (message.pubkey !== signer.pubkey) throw new Error('You can only delete your own messages.');
  // Deleting removes every version of an edited message; an edit replaces only the current one (Anagram).
  const ids = onlyCurrent ? [message.id] : knownIds(message);
  if (message.protocol === 'ndr') {
    // NDR mutations keep the original rumor ID and use its original transport.
    // The durable local queue returns without waiting for a relay acknowledgment.
    for (const id of ids) await sendNdrRumor(context.peer, 5, '', [['p', context.peer], ['e', id], ['k', String(message.kind ?? 14)]]);
    if (me.value !== signer) return;
    for (const id of ids) queueSave({ account: signer.pubkey, id: `ndr-delete:${signer.pubkey}:${id}`, deletedId: id, deletedBy: signer.pubkey, created_at: nostr.now() });
    applyDeletions(ids, signer.pubkey);
    return;
  }
  let publishing;
  const restore = () =>
    undoDeletions(ids, signer.pubkey, () => {
      if (context.room) addRoomMessages(context.room, [message]);
      else {
        addMessages([message]);
        queueSave(current(message));
      }
    });
  if (context.room) {
    const room = roomState.value[context.room].room;
    const event = await nostr.signRoomDeletion(signer, room, ids, 9);
    applyDeletions(ids, signer.pubkey);
    publishing = nostr.publish({ room }, event, signer);
  } else {
    const peer = context.peer;
    applyDeletions(ids, signer.pubkey);
    for (const id of ids) queueSave(tombstone(signer.pubkey, id, signer.pubkey));
    publishing = nostr.sendRumor(signer, peer, 5, '', [['p', peer], ...ids.map((id) => ['e', id]), ['k', String(message.kind ?? 14)]], inboxOf(peer));
  }
  if (!background) return publishing;
  publishing.catch((e) => {
    restore();
    notify(`Delete failed: ${e.message}`);
  });
}

// Anagram's edit flow: delete the old version, then send a replacement at the same
// timestamp. The new text shows at once with 🕓; the two events publish in order.
export async function editMessage(context, message, text) {
  const signer = me.value;
  if (message.protocol === 'ndr') {
    if (message.pubkey !== signer.pubkey) throw new Error('You can only edit your own messages.');
    const rumor = await sendNdrRumor(context.peer, 1009, text, [['p', context.peer], ['e', rootId(message)], ['k', '14']]);
    if (me.value === signer) await receiveNdr(signer, rumor, context.peer);
    return;
  }
  if (context.room) {
    const room = roomState.value[context.room].room;
    // signRoomMessage copies the edited message's q and imeta tags (Anagram's edit format).
    const replacement = await nostr.signRoomMessage(signer, room, text, null, message);
    const deletion = await nostr.signRoomDeletion(signer, room, [message.id], 9);
    applyDeletions([message.id], signer.pubkey);
    addRoomMessages(context.room, [replacement]);
    setStatus(replacement.id, 'sending');
    const publishReplacement = () => nostr.publish({ room }, replacement, signer);
    try {
      await nostr.publish({ room }, deletion, signer);
    } catch (e) {
      // Nothing changed on the relays, so undo the edit here too; the old text stays.
      dropRoomMessage(context.room, replacement.id);
      setStatus(replacement.id, null);
      undoDeletions([message.id], signer.pubkey, () => addRoomMessages(context.room, [message]));
      throw new Error(`Edit failed: ${e.message}`);
    }
    track(replacement.id, publishReplacement(), publishReplacement);
    return;
  }
  deleteMessage(context, message, { onlyCurrent: true, background: false }).catch((e) => notify(`Edit failed: ${e.message}`));
  sendDirectMessage(context.peer, text, null, message, (message.tags ?? []).filter((t) => t[0] === 'imeta'));
}
