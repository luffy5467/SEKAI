import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  fromBase64Url,
  generateRoomKey,
  importRoomKey,
  inviteLink,
  isRoomKey,
  isSealed,
  keyFromFragment,
  makeKeyCheck,
  open,
  openJson,
  SEALED_PREFIX,
  seal,
  sealJson,
  toBase64Url,
  verifyKeyCheck,
} from '../src/e2ee.ts';

describe('room keys', () => {
  it('generates 32-byte base64url keys that are unique', () => {
    const a = generateRoomKey();
    const b = generateRoomKey();
    assert.equal(a.length, 43);
    assert.ok(isRoomKey(a));
    assert.notEqual(a, b);
    assert.equal(fromBase64Url(a).length, 32);
  });

  it('rejects malformed keys', () => {
    for (const bad of [
      '',
      'short',
      'x'.repeat(44),
      `${'A'.repeat(42)}!`,
      'A'.repeat(43).replace('A', '+'),
    ]) {
      assert.equal(isRoomKey(bad), false, bad);
    }
  });

  it('round-trips base64url for every byte value', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    assert.deepEqual(fromBase64Url(toBase64Url(bytes)), bytes);
  });
});

describe('seal / open', () => {
  it('round-trips unicode text and never contains the plaintext', async () => {
    const key = await importRoomKey(generateRoomKey());
    const text = 'Friday screening 金曜日の映画 🎬';
    const sealed = await seal(key, 'chat', text);
    assert.ok(sealed.startsWith(SEALED_PREFIX));
    assert.ok(isSealed(sealed));
    assert.ok(!sealed.includes('Friday'));
    assert.equal(await open(key, 'chat', sealed), text);
  });

  it('uses a fresh IV, so equal plaintexts give different ciphertexts', async () => {
    const key = await importRoomKey(generateRoomKey());
    assert.notEqual(await seal(key, 'chat', 'same'), await seal(key, 'chat', 'same'));
  });

  it('fails with the wrong key', async () => {
    const key = await importRoomKey(generateRoomKey());
    const other = await importRoomKey(generateRoomKey());
    const sealed = await seal(key, 'chat', 'secret');
    await assert.rejects(open(other, 'chat', sealed));
  });

  it('binds the purpose: a chat ciphertext cannot be opened as a room name', async () => {
    const key = await importRoomKey(generateRoomKey());
    const sealed = await seal(key, 'chat', 'secret');
    await assert.rejects(open(key, 'name', sealed));
  });

  it('detects tampering', async () => {
    const key = await importRoomKey(generateRoomKey());
    const sealed = await seal(key, 'queue', 'https://example.com/film.mp4');
    const body = fromBase64Url(sealed.slice(SEALED_PREFIX.length));
    body[body.length - 1] = (body[body.length - 1] ?? 0) ^ 1;
    await assert.rejects(open(key, 'queue', SEALED_PREFIX + toBase64Url(body)));
    await assert.rejects(open(key, 'queue', `${SEALED_PREFIX}AAAA`));
    await assert.rejects(open(key, 'queue', 'plaintext'));
  });

  it('round-trips JSON payloads', async () => {
    const key = await importRoomKey(generateRoomKey());
    const entry = { kind: 'file', url: 'https://cdn.example/a.webm', videoId: null, title: 'A' };
    assert.deepEqual(await openJson(key, 'queue', await sealJson(key, 'queue', entry)), entry);
  });
});

describe('key check', () => {
  it('accepts the right key and rejects another', async () => {
    const key = await importRoomKey(generateRoomKey());
    const check = await makeKeyCheck(key);
    assert.equal(await verifyKeyCheck(key, check), true);
    assert.equal(await verifyKeyCheck(await importRoomKey(generateRoomKey()), check), false);
    assert.equal(await verifyKeyCheck(key, 'garbage'), false);
  });
});

describe('invite links', () => {
  it('puts the key in the fragment and reads it back', () => {
    const key = generateRoomKey();
    const link = inviteLink('https://sekai.example/rooms/ab12-cd34#old', key);
    assert.equal(link, `https://sekai.example/rooms/ab12-cd34#k=${key}`);
    assert.equal(keyFromFragment(new URL(link).hash), key);
  });

  it('ignores missing or malformed fragments', () => {
    assert.equal(keyFromFragment(''), null);
    assert.equal(keyFromFragment('#k=nope'), null);
    assert.equal(keyFromFragment('#other=1'), null);
  });
});
