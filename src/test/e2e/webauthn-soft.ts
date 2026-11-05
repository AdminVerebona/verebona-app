/**
 * Authentificateur WebAuthn LOGICIEL pour les e2e (lot 110B) — produit de
 * vraies réponses (attestation « none », signature ES256) vérifiées par
 * @simplewebauthn/server côté route. Permet de tester l'absence de UV, une
 * mauvaise origine, un défi rejoué, un compteur qui régresse.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest();

export interface SoftCredential { id: Buffer; privateKey: KeyObject; cose: Uint8Array; counter: number; userHandle?: string }

export function newCredential(): SoftCredential {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([
    [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
  ]) as never);
  return { id: randomBytes(16), privateKey, cose, counter: 0 };
}

function flagsOf(o: { uv?: boolean; at?: boolean }): number {
  return 0x01 | (o.uv === false ? 0 : 0x04) | (o.at ? 0x40 : 0) | 0x08 | 0x10; // UP, UV, AT, BE, BS (synchronisée)
}

export function registrationResponse(cred: SoftCredential, options: { challenge: string; rp: { id?: string } }, opts: { origin: string; uv?: boolean; rpId?: string }) {
  const rpId = opts.rpId ?? options.rp.id ?? 'localhost';
  const counter = Buffer.alloc(4); counter.writeUInt32BE(cred.counter);
  const idLen = Buffer.alloc(2); idLen.writeUInt16BE(cred.id.length);
  const authData = Buffer.concat([sha256(rpId), Buffer.from([flagsOf({ uv: opts.uv, at: true })]), counter, Buffer.alloc(16), idLen, cred.id, Buffer.from(cred.cose)]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: opts.origin, crossOrigin: false }));
  const attestationObject = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]) as never);
  return {
    id: b64u(cred.id), rawId: b64u(cred.id), type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
    response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal', 'hybrid'] },
  };
}

export function authenticationResponse(cred: SoftCredential, options: { challenge: string; rpId?: string }, opts: { origin: string; uv?: boolean; rpId?: string; counter?: number }) {
  const rpId = opts.rpId ?? options.rpId ?? 'localhost';
  const counter = Buffer.alloc(4); counter.writeUInt32BE(opts.counter ?? cred.counter);
  const authData = Buffer.concat([sha256(rpId), Buffer.from([flagsOf({ uv: opts.uv })]), counter]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: opts.origin, crossOrigin: false }));
  const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), cred.privateKey);
  return {
    id: b64u(cred.id), rawId: b64u(cred.id), type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
    response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), ...(cred.userHandle ? { userHandle: cred.userHandle } : {}) },
  };
}
