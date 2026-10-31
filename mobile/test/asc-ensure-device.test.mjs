/**
 * Lot 101-septies — appareil technique pour la signature iOS en CI (sans réseau).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';
import { ascJwt, techUdid, TECH_DEVICE_NAME } from '../scripts/asc-ensure-device.mjs';

test('jeton ES256 conforme à l’API App Store Connect (en-tête, audience, durée ≤ 20 min, signature)', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const jwt = ascJwt({ keyPem, keyId: 'ABCDEFGH12', issuerId: '12345678-1234-1234-1234-123456789012', now: 1_000 });
  const [h, p, s] = jwt.split('.');
  const dec = (x) => JSON.parse(Buffer.from(x, 'base64url').toString());
  assert.deepEqual(dec(h), { alg: 'ES256', kid: 'ABCDEFGH12', typ: 'JWT' });
  assert.deepEqual(dec(p), { iss: '12345678-1234-1234-1234-123456789012', iat: 1_000, exp: 1_600, aud: 'appstoreconnect-v1' });
  const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  assert.equal(ok, true);
});

test('UDID technique : format des iPhone récents, stable par équipe, distinct entre équipes', () => {
  const a = techUdid('R28H4Z2PP9');
  assert.match(a, /^00008030-[0-9A-F]{16}$/);
  assert.equal(techUdid('R28H4Z2PP9'), a);
  assert.notEqual(techUdid('AUTREEQUIP'), a);
  assert.match(TECH_DEVICE_NAME, /ne pas supprimer/);
});
