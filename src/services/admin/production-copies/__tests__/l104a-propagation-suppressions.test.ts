/**
 * Lot 104A (P1-F) — propagation des suppressions de production vers les
 * copies en préproduction : protocole PUR (empreintes, signatures,
 * correspondance), configuration, politique prudente. Aucun réseau.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  DELETION_SIGNAL_HEADERS, DELETION_SIGNAL_PATH, accountIdFingerprint, buildSignalIndex, canonicalRequest, emailFingerprint, matchSubject,
  parseSignalPage, signRequest, signResponse, signalKey, signalKeyStatus, signalSourceUrl, userIdFingerprint,
  verifyRequestSignature, verifyResponseSignature, type DeletionSignalEntry,
} from '../deletion-signals';

const KEY = 'k'.repeat(40);
const OTHER = 'z'.repeat(40);
const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('L104A-F1 — empreintes non réversibles', () => {
  it('déterministes pour une même clé, différentes selon la clé, le type et la valeur ; adresse normalisée', () => {
    expect(userIdFingerprint(KEY, 12)).toMatch(/^[0-9a-f]{64}$/);
    expect(userIdFingerprint(KEY, 12)).toBe(userIdFingerprint(KEY, 12));
    expect(userIdFingerprint(KEY, 12)).not.toBe(userIdFingerprint(OTHER, 12));
    expect(userIdFingerprint(KEY, 12)).not.toBe(accountIdFingerprint(KEY, 12));
    expect(emailFingerprint(KEY, ' Lea@Exemple.FR ')).toBe(emailFingerprint(KEY, 'lea@exemple.fr'));
    expect(emailFingerprint(KEY, 'pas-une-adresse')).toBeNull();
    // Rien de l'identifiant ni de l'adresse n'apparaît dans l'empreinte.
    expect(emailFingerprint(KEY, 'lea@exemple.fr')).not.toMatch(/lea|exemple/);
  });
});

describe('L104A-F2 — configuration (noms seulement, jamais la valeur)', () => {
  it('clé absente / trop courte / valable ; adresse de la production HTTPS', () => {
    expect(signalKeyStatus({})).toBe('missing');
    expect(signalKeyStatus({ PRODUCTION_DELETION_SIGNAL_KEY: 'court' })).toBe('too_short');
    expect(signalKey({ PRODUCTION_DELETION_SIGNAL_KEY: 'court' })).toBeNull();
    expect(signalKey({ PRODUCTION_DELETION_SIGNAL_KEY: ` ${KEY} ` })).toBe(KEY);
    expect(signalSourceUrl({ PRODUCTION_DELETION_SIGNAL_URL: 'https://app.verebona.fr' })).toBe(`https://app.verebona.fr${DELETION_SIGNAL_PATH}`);
    expect(signalSourceUrl({ PRODUCTION_DELETION_SIGNAL_URL: 'http://app.verebona.fr' })).toBeNull();
    expect(signalSourceUrl({ PRODUCTION_DELETION_SIGNAL_URL: 'https://u:p@app.verebona.fr' })).toBeNull();
    expect(signalSourceUrl({ PRODUCTION_DELETION_SIGNAL_URL: 'https://app.verebona.fr/x?cle=1' })).toBeNull();
    expect(signalSourceUrl({})).toBeNull();
  });
});

describe('L104A-F3 — requêtes et réponses signées (aucun secret transmis)', () => {
  const now = Date.parse('2026-11-02T10:00:00Z');
  const ts = String(now);
  const params = new URLSearchParams({ limit: '500', after: 'r12' });

  it('requête : signature valide, paramètres dans un autre ordre acceptés ; altérée, périmée, absente ou autre clé → refus', () => {
    const sig = signRequest(KEY, 'GET', DELETION_SIGNAL_PATH, { after: 'r12', limit: '500' }, ts);
    expect(verifyRequestSignature(KEY, { method: 'GET', pathname: DELETION_SIGNAL_PATH, params, timestamp: ts, signature: sig }, now)).toEqual({ ok: true });
    expect(verifyRequestSignature(KEY, { method: 'GET', pathname: DELETION_SIGNAL_PATH, params: new URLSearchParams({ limit: '500', after: 'r0' }), timestamp: ts, signature: sig }, now)).toEqual({ ok: false, reason: 'INVALID' });
    expect(verifyRequestSignature(KEY, { method: 'GET', pathname: DELETION_SIGNAL_PATH, params, timestamp: ts, signature: sig }, now + 6 * 60_000)).toEqual({ ok: false, reason: 'STALE' });
    expect(verifyRequestSignature(KEY, { method: 'GET', pathname: DELETION_SIGNAL_PATH, params, timestamp: null, signature: sig }, now)).toEqual({ ok: false, reason: 'MISSING' });
    expect(verifyRequestSignature(OTHER, { method: 'GET', pathname: DELETION_SIGNAL_PATH, params, timestamp: ts, signature: sig }, now)).toEqual({ ok: false, reason: 'INVALID' });
    expect(canonicalRequest('get', DELETION_SIGNAL_PATH, params, ts)).not.toContain(KEY);
  });

  it('réponse : corps altéré ou rejoué hors délai → refus', () => {
    const body = '{"a":1}';
    const sig = signResponse(KEY, body, ts);
    expect(verifyResponseSignature(KEY, body, ts, sig, now)).toEqual({ ok: true });
    expect(verifyResponseSignature(KEY, '{"a":2}', ts, sig, now)).toEqual({ ok: false, reason: 'INVALID' });
    expect(verifyResponseSignature(KEY, body, ts, sig, now + 10 * 60_000)).toEqual({ ok: false, reason: 'STALE' });
    expect(DELETION_SIGNAL_HEADERS.signature).toBe('x-verebona-signal-signature');
  });
});

describe('L104A-F4 — charge utile minimale et correspondance', () => {
  const fp = (n: number) => userIdFingerprint(KEY, n);
  const entry = (over: Partial<DeletionSignalEntry>): DeletionSignalEntry => ({ ref: 'r1', executedAt: '2026-11-01T10:00:00.000Z', scope: 'account', subjects: [], contacts: [], ...over });

  it('page : validée tout ou rien ; aucun champ nominatif accepté', () => {
    const ok = parseSignalPage({ schema: 'verebona-deletion-signals-v1', environment: 'production', generatedAt: 'x', coversSince: '2026-10-01T00:00:00Z', entries: [entry({ subjects: [fp(1)] })], next: null });
    expect(ok.ok).toBe(true);
    expect(parseSignalPage({ schema: 'autre', environment: 'production', coversSince: '2026-10-01T00:00:00Z', entries: [], next: null }).ok).toBe(false);
    expect(parseSignalPage({ schema: 'verebona-deletion-signals-v1', environment: 'production', coversSince: '2026-10-01T00:00:00Z', entries: [{ ...entry({}), subjects: ['lea@exemple.fr'] }], next: null }).ok).toBe(false);
  });

  it('identifiant : toujours ; adresse : seulement pour une suppression POSTÉRIEURE à l’instantané de la copie (adresse réutilisable)', () => {
    const snap = new Date('2026-10-15T00:00:00Z');
    const mail = emailFingerprint(KEY, 'lea@exemple.fr')!;
    const idx = buildSignalIndex([
      entry({ ref: 'r1', subjects: [fp(5)], executedAt: '2026-09-01T00:00:00.000Z' }),
      entry({ ref: 'r2', scope: 'user', contacts: [mail], executedAt: '2026-10-01T00:00:00.000Z' }),
    ]);
    expect(matchSubject({ idFingerprints: [fp(5)], contactFingerprints: [], copySnapshotAt: snap }, idx)?.ref).toBe('r1');
    expect(matchSubject({ idFingerprints: [fp(6)], contactFingerprints: [mail], copySnapshotAt: snap }, idx)).toBeNull();
    const idx2 = buildSignalIndex([entry({ ref: 'r3', scope: 'user', contacts: [mail], executedAt: '2026-10-20T00:00:00.000Z' })]);
    expect(matchSubject({ idFingerprints: [fp(6)], contactFingerprints: [mail], copySnapshotAt: snap }, idx2)?.ref).toBe('r3');
    expect(matchSubject({ idFingerprints: [fp(7)], contactFingerprints: [], copySnapshotAt: snap }, idx2)).toBeNull();
  });
});

describe('L104A-F5 — raccords : registre 102A réutilisé, moteur unique, politique prudente', () => {
  it('le moteur de purge calcule les empreintes d’adresse avant la cascade ; la propagation passe par le rejeu 102A', () => {
    const engine = lire('src/services/account/scheduled-deletion.service.ts');
    expect(engine).toMatch(/const signalContacts = await deletedContactFingerprints\(tx, userIds\);\s*[\s\S]{0,300}await tx\.delete\(users\)/);
    const svc = lire('src/services/admin/production-copies/deletion-propagation.service.ts');
    expect(svc).toMatch(/replayRegistryEntry/);
    expect(svc).toMatch(/FROM account_deletion_registry/);
    expect(svc).not.toMatch(/DELETE FROM (users|accounts)/);
  });

  it('import refusé tant que la propagation n’est pas prête (autorisation ET restauration)', () => {
    const copies = lire('src/services/admin/production-copies/production-copies.service.ts');
    expect(copies).toMatch(/DELETION_PROPAGATION_NOT_READY/);
    expect(copies).toMatch(/guardRestoreOrigin[\s\S]*deletionPropagationReadiness/);
  });

  it('tâche planifiée déclarée au catalogue et route exposée sans session (signature HMAC)', () => {
    expect(lire('src/services/scheduling/scheduled-tasks.catalog.ts')).toMatch(/code: 'production-deletion-signals'/);
    expect(lire('src/middleware.ts')).toContain(`'${DELETION_SIGNAL_PATH}'`);
    expect(lire('docs/exploitation/copies-donnees-reelles-preproduction.md')).toMatch(/PRODUCTION_DELETION_SIGNAL_KEY/);
  });
});
