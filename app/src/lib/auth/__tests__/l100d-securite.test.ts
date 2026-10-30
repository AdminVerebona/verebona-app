/**
 * Lot 100D — décisions PO A2, A3, A5 du 27/10/2026 (CDC 18 §20, §22). Sans
 * base ni réseau.
 *
 *   L100D-A2  e-mail de sécurité « Vos autres appareils ont été déconnectés » :
 *             seulement si au moins une session a réellement été révoquée,
 *             une seule fois (clé d'idempotence sans `sid`), contenu sobre
 *             (ni IP, ni jeton, ni lien commercial, conseil « si ce n'est pas
 *             vous »), notification de sécurité obligatoire, gabarit éditable
 *             au BO ; émis par la SEULE route « autres appareils » ;
 *   L100D-A3  reconnaissance d'appareil sans historique d'adresses : étiquette
 *             héritée gardée par compte (jamais l'adresse) ; demandes
 *             confirmées conservées 30 jours ;
 *   L100D-A5  toute première session (mot de passe, Google, Apple, lien
 *             d'activation) : aucune alerte ; session suivante sur un autre
 *             appareil : alerte.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const emitted: Array<Record<string, unknown>> = [];
let emitFails = false;
vi.mock('@/lib/notifications', () => ({
  emit: async (input: Record<string, unknown>) => {
    if (emitFails) throw new Error('smtp');
    emitted.push(input);
  },
}));

import { confirmOtherSessionsRevoked } from '@/lib/auth/other-sessions-alert';
import { sessionPublicId } from '@/lib/auth/session-registry';
import { getCatalogEntry, otherSessionsRevokedContent } from '@/lib/notifications/catalog';
import { NOTIFICATION_EMAIL_TEMPLATES } from '@/lib/email/template-editor';
import {
  __legacyDeviceCookieValueForTests, buildDeviceCookieValue, legacyDeviceTagFor, parseDeviceCookie, trustedDeviceFor,
} from '@/lib/auth/device-trust';
import { EMAIL_CHANGE_CONFIRMED_RETENTION_DAYS } from '@/services/auth/email-change.service';
import { __setNewDeviceAlertDepsForTests, processNewDeviceAlert, type NewDeviceAlertMessage } from '@/lib/auth/new-device-alert';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules' && e.name !== 'test') walk(rel, out); }
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}

beforeEach(() => {
  emitted.length = 0;
  emitFails = false;
});

// ── A2 ──────────────────────────────────────────────────────────────────────

describe('L100D-A2 — confirmation après « Déconnecter tous les autres appareils »', () => {
  it('aucune session réellement révoquée : aucun e-mail (jamais de confirmation trompeuse)', async () => {
    expect(await confirmOtherSessionsRevoked({ userId: 7, sid: 'sid-courant', count: 0 })).toBe('none_revoked');
    expect(await confirmOtherSessionsRevoked({ userId: 7, sid: 'sid-courant', count: -1 })).toBe('none_revoked');
    expect(emitted).toHaveLength(0);
  });

  it('au moins une session révoquée : UNE notification de sécurité, clé d’idempotence sans le sid', async () => {
    const sid = 'sid-secret-123';
    expect(await confirmOtherSessionsRevoked({ userId: 7, sid, count: 2, deviceLabel: 'PC Windows', browserLabel: 'Chrome' })).toBe('queued');
    expect(emitted).toHaveLength(1);
    const e = emitted[0];
    expect(e).toMatchObject({ type: 'OTHER_SESSIONS_REVOKED', recipientUserIds: [7], entityType: 'user', entityId: 7 });
    expect(e.payload).toMatchObject({ count: 2, deviceLabel: 'PC Windows', browserLabel: 'Chrome' });
    expect(e.dedupeKey).toBe(`security:other-sessions-revoked:7:${sessionPublicId(sid)}`);
    expect(JSON.stringify(e)).not.toContain(sid);
    // Même demande rejouée : même clé (la file `notification_outbox` est unique sur cette clé).
    await confirmOtherSessionsRevoked({ userId: 7, sid, count: 1 });
    expect(emitted[1].dedupeKey).toBe(e.dedupeKey);
  });

  it('échec d’envoi : journalisé, jamais d’exception (la révocation est déjà validée)', async () => {
    emitFails = true;
    expect(await confirmOtherSessionsRevoked({ userId: 7, sid: 's', count: 1 })).toBe('error');
  });

  it('contenu sobre : date, nombre, appareil demandeur, conseil ; ni IP, ni jeton, ni lien commercial', () => {
    const r = otherSessionsRevokedContent({ at: '2026-10-29T09:05:00.000Z', count: 3, deviceLabel: 'iPhone', browserLabel: 'Application Verebona' });
    expect(r.emailTemplateCode).toBe('notif_other_sessions_revoked');
    expect(r.bellBody).toContain('3 autres appareils ont été déconnectés');
    expect(r.bellBody).toContain('29 octobre 2026 à 10 h 05');
    expect(r.bellBody).toContain('iPhone · Application Verebona');
    expect(r.bellBody).toMatch(/Si c’est vous, vous n’avez rien à faire\. Sinon, modifiez dès maintenant votre mot de passe/);
    expect(r.bellBody).not.toMatch(/https?:|offre|tarif|abonnement|€|jeton|token|\d+\.\d+\.\d+\.\d+/i);
    expect(otherSessionsRevokedContent({ at: '2026-10-29T09:05:00.000Z', count: 1 }).bellBody).toContain('1 autre appareil a été déconnecté');
    expect(r.bellBody).not.toMatch(/Opération/);
  });

  it('notification de sécurité : e-mail OBLIGATOIRE (lot 101B : cloche et push supprimés), lien Appareils connectés, gabarit éditable au BO', () => {
    const entry = getCatalogEntry('OTHER_SESSIONS_REVOKED')!;
    expect(entry).toMatchObject({ category: 'security', mandatoryBell: false, mandatoryEmail: true });
    expect(Object.keys(entry.retiredChannels ?? {}).sort()).toEqual(['bell', 'push']);
    // Lot 101C : ancre du sous-bloc « Appareils connectés » (fermé par défaut, ouvert par ce lien).
    expect(entry.deepLink({})).toBe('/mon-compte#appareils-connectes');
    expect(entry.payloadSchema.safeParse({ at: new Date().toISOString(), count: 0 }).success).toBe(false);
    expect(NOTIFICATION_EMAIL_TEMPLATES.NOTIF_OTHER_SESSIONS_REVOKED.events).toEqual(['OTHER_SESSIONS_REVOKED']);
    const sql = read('src/db/migrations/0878_l100d_gabarit_autres_appareils_deconnectes.sql');
    expect(sql).toContain("'notif_other_sessions_revoked'");
    expect(sql).toContain('ON CONFLICT (type) DO NOTHING');
  });

  it('émise par la SEULE route « Déconnecter tous les autres appareils » (ni appareil seul, ni BO, ni mot de passe, ni rejeu)', () => {
    const emitters = walk('src').filter((f) => {
      const s = read(f);
      return f !== 'src/lib/auth/other-sessions-alert.ts'
        && (s.includes('confirmOtherSessionsRevoked') || s.includes("'OTHER_SESSIONS_REVOKED'") || s.includes('notif_other_sessions_revoked'));
    });
    expect(emitters.sort()).toEqual([
      'src/app/api/users/me/sessions/revoke-others/route.ts',
      'src/lib/email/template-editor.ts',
      'src/lib/notifications/catalog.ts',
      'src/types/notifications.ts',
    ]);
    const route = read('src/app/api/users/me/sessions/revoke-others/route.ts');
    expect(route).toContain('revokeAllUserSessionsWithReport');
    expect(route).toMatch(/count: registryRevoked/);
    expect(route).toContain('securityEmail');
    expect(read('src/app/api/users/me/sessions/[id]/route.ts')).not.toContain('confirmOtherSessionsRevoked');
  });

  it('le nombre compté est celui des sessions ACTIVES réellement révoquées par cet appel', () => {
    const db = read('src/db/index.ts');
    expect(db).toMatch(/revokedCount = revoked\.filter\(\(r\) => new Date\(r\.expires_at\)\.getTime\(\) > at\.getTime\(\)\)\.length/);
    expect(db).toContain('WHERE user_id = ${userId} AND revoked_at IS NULL');
  });
});

// ── A3 ──────────────────────────────────────────────────────────────────────

describe('L100D-A3 — appareils reconnus indépendants de l’historique des adresses', () => {
  const ORIGINE = 'origine@exemple.fr';
  const cree = Date.now() - 10 * 24 * 3600_000;

  it('entrée HÉRITÉE reconnue grâce à l’étiquette gardée (sans adresse) ; refusée pour un autre compte ou une autre étiquette', () => {
    const herite = __legacyDeviceCookieValueForTests(ORIGINE, Date.now() - 3600_000);
    const tag = legacyDeviceTagFor(ORIGINE)!;
    expect(tag).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(tag).not.toContain('origine');
    expect(trustedDeviceFor(herite.value, { userId: 5, legacyTag: tag, legacyNotBeforeMs: cree })).toBe(herite.deviceId);
    expect(trustedDeviceFor(herite.value, { userId: 5, legacyTag: legacyDeviceTagFor('autre@exemple.fr'), legacyNotBeforeMs: cree })).toBeNull();
    // Compte créé APRÈS l'émission de l'entrée : pas le sien (adresse reprise).
    expect(trustedDeviceFor(herite.value, { userId: 6, legacyTag: tag, legacyNotBeforeMs: Date.now() })).toBeNull();
    // L'étiquette gardée prime sur une adresse (purgée ou non).
    expect(trustedDeviceFor(herite.value, { userId: 5, legacyTag: tag, legacyEmail: 'actuelle@exemple.fr', legacyNotBeforeMs: cree })).toBe(herite.deviceId);
  });

  it('entrée `uid` : reconnue sans aucune information d’adresse (identifiant stable du compte)', () => {
    const { value, deviceId } = buildDeviceCookieValue(null, { userId: 9 });
    expect(trustedDeviceFor(value, { userId: 9 })).toBe(deviceId);
    expect(trustedDeviceFor(value, { userId: 10 })).toBeNull();
  });

  it('reconnexion : l’entrée héritée désignée par l’étiquette est remplacée par l’entrée `uid`', () => {
    const herite = __legacyDeviceCookieValueForTests(ORIGINE, Date.now() - 3600_000);
    const tag = legacyDeviceTagFor(ORIGINE)!;
    const neuf = buildDeviceCookieValue(herite.value, { userId: 5, legacyTag: tag, legacyNotBeforeMs: cree });
    expect(neuf.deviceId).toBe(herite.deviceId);
    expect(parseDeviceCookie(neuf.value)!.entries).toHaveLength(1);
    expect(parseDeviceCookie(neuf.value)!.entries[0].tag).not.toBe(tag);
    expect(trustedDeviceFor(neuf.value, { userId: 5 })).toBe(herite.deviceId);
  });

  it('demandes confirmées conservées 30 jours ; étiquette gardée AVANT suppression, dans la même transaction', () => {
    expect(EMAIL_CHANGE_CONFIRMED_RETENTION_DAYS).toBe(30);
    const svc = read('src/services/auth/email-change.service.ts');
    const purge = svc.slice(svc.indexOf('export async function purgeEmailChangeRequests'));
    expect(purge).toContain('pgClient.begin');
    expect(purge.indexOf('INSERT INTO device_trust_legacy_accounts')).toBeLessThan(purge.indexOf('DELETE FROM email_change_requests'));
    expect(purge).toContain('const confirmedLimit = new Date(now.getTime() - EMAIL_CHANGE_CONFIRMED_RETENTION_DAYS * 24 * 60 * 60 * 1000)');
    const acct = read('src/lib/auth/device-account.ts');
    expect(acct.match(/FROM device_trust_legacy_accounts l/g)).toHaveLength(2);
    const mig = read('src/db/migrations/0879_l100d_appareils_reconnus_transition.sql');
    expect(mig).toContain('CREATE TABLE IF NOT EXISTS device_trust_legacy_accounts');
    expect(mig).toContain('ON DELETE CASCADE');
    expect(mig).not.toMatch(/\bemail\s+TEXT/i);
  });

  it('nouvelle table déclarée partout (diagnostic, recette, export RGPD exclu, restauration)', () => {
    for (const f of [
      'src/services/admin/diagnostics-export/coverage.ts', 'src/services/admin/diagnostics-export/recette-catalog.ts',
      'src/services/gdpr/export-content.ts', 'src/services/backup/schema-signature.ts',
    ]) expect(read(f), f).toContain('device_trust_legacy_accounts');
  });
});

// ── A5 ──────────────────────────────────────────────────────────────────────

describe('L100D-A5 — pas d’alerte à la toute première session (mot de passe, Google, Apple, activation)', () => {
  const request = () => new NextRequest('http://localhost:3000/api/auth/login', { method: 'POST' });
  const client = { deviceKey: 'k1', deviceSource: 'cookie', clientType: 'WEB', appVersion: null, deviceLabel: 'PC Windows', browserLabel: 'Chrome' } as never;

  it.each(['password', 'google', 'apple', 'email_link'])('%s : première session → aucune alerte ; session suivante sur un appareil inconnu → alerte', async (method) => {
    const sent: NewDeviceAlertMessage[] = [];
    let first = true;
    __setNewDeviceAlertDepsForTests({
      account: async (userId) => ({ userId }),
      deviceSeen: async () => false,
      isAccountCreation: async () => first,
      send: async (m) => { sent.push(m); },
    });
    try {
      expect(await processNewDeviceAlert(request(), { userId: 1, sid: 's1', method, client })).toBe('account_creation');
      expect(sent).toHaveLength(0);
      first = false;
      expect(await processNewDeviceAlert(request(), { userId: 1, sid: 's2', method: method === 'email_link' ? 'password' : method, client })).toBe('sent');
      expect(sent).toHaveLength(1);
    } finally {
      __setNewDeviceAlertDepsForTests(null);
    }
  });
});
