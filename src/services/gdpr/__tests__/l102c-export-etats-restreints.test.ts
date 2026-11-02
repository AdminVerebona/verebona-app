/**
 * Lot 102C — export RGPD « Mes données » dans les états restreints et
 * archive en parties numérotées (ticket conformité légale, P2).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GDPR_EXPORT_API_ALLOWLIST, canExportInRestrictedState, isGdprExportApiRequest, parseExportPartParam, restrictedStateOf,
} from '../restricted-export-access';
import { isApiAllowedWhilePendingDeletion } from '@/lib/auth/account-closure';
import { buildGdprExportContent, partManifest, planExportParts, type DocumentCandidate } from '../export-content';

const read = (p: string) => readFileSync(resolve(__dirname, '../../../..', p), 'utf8');
const MB = 1024 * 1024;
const doc = (id: number, size: number, extra: Partial<DocumentCandidate> = {}): DocumentCandidate => ({
  id, originalFilename: `f${id}.pdf`, filename: `f${id}.pdf`, mimeType: 'application/pdf', size, s3Key: `k/${id}`, s3Bucket: null, ...extra,
});

describe('L102C-EXP-01 — états restreints : l’export n’est jamais retiré', () => {
  it.each(['active', 'trial_readonly', 'subscription_ended_readonly', 'withdrawal_readonly', 'unpaid_restricted', 'no_subscription', 'pending_deletion'])('%s → autorisé', (s) => {
    expect(canExportInRestrictedState(s)).toBe(true);
  });
  it('suspendu / supprimé → refusé (connexion déjà refusée)', () => {
    expect(canExportInRestrictedState('suspended')).toBe(false);
    expect(canExportInRestrictedState('deleted')).toBe(false);
  });
  it('L102C-EXP-02 : un état INCONNU (nouvel état 102A non raccordé) reste autorisé — un oubli ne retire jamais un droit', () => {
    expect(canExportInRestrictedState('read_only_after_purge_notice')).toBe(true);
    expect(canExportInRestrictedState(null)).toBe(true);
  });
  it('projection des mécanismes actuels (statut utilisateur, statut d’abonnement, rétractation)', () => {
    expect(restrictedStateOf({ subscriptionStatus: 'readonly' })).toBe('trial_readonly');
    expect(restrictedStateOf({ subscriptionStatus: 'canceled' })).toBe('subscription_ended_readonly');
    expect(restrictedStateOf({ subscriptionStatus: 'canceled', withdrawn: true })).toBe('withdrawal_readonly');
    expect(restrictedStateOf({ subscriptionStatus: 'past_due' })).toBe('unpaid_restricted');
    expect(restrictedStateOf({ subscriptionStatus: 'none' })).toBe('no_subscription');
    expect(restrictedStateOf({ userStatus: 'PENDING_DELETION', subscriptionStatus: 'active' })).toBe('pending_deletion');
    expect(restrictedStateOf({ userStatus: 'SUSPENDED' })).toBe('suspended');
    expect(restrictedStateOf({ subscriptionStatus: 'active' })).toBe('active');
  });
});

describe('L102C-EXP-03 — liste d’autorisations unique (middleware, session, 102A)', () => {
  it('compte en suppression : demande, état et téléchargement (toutes parties) autorisés', () => {
    expect(isApiAllowedWhilePendingDeletion('/api/users/me/gdpr-export', 'POST')).toBe(true);
    expect(isApiAllowedWhilePendingDeletion('/api/users/me/gdpr-export', 'GET')).toBe(true);
    expect(isApiAllowedWhilePendingDeletion('/api/users/me/gdpr-export/download', 'GET')).toBe(true);
    // La requête (`?part=N`) ne fait pas partie du chemin.
    expect(isApiAllowedWhilePendingDeletion('/api/users/me/gdpr-export/download/', 'GET')).toBe(true);
    expect(isApiAllowedWhilePendingDeletion('/api/assets', 'POST')).toBe(false);
  });
  it('même liste dans `account-closure` (aucune copie divergente)', () => {
    const src = read('src/lib/auth/account-closure.ts');
    expect(src).toContain('...GDPR_EXPORT_API_ALLOWLIST');
    expect(src).not.toMatch(/path: '\/api\/users\/me\/gdpr-export'/);
    for (const a of GDPR_EXPORT_API_ALLOWLIST) for (const m of a.methods) expect(isGdprExportApiRequest(a.path, m)).toBe(true);
    expect(isGdprExportApiRequest('/api/users/me/gdpr-export', 'DELETE')).toBe(false);
  });
  it('les routes d’export n’appellent aucune garde de lecture seule ni de droits commerciaux', () => {
    for (const p of ['src/app/api/users/me/gdpr-export/route.ts', 'src/app/api/users/me/gdpr-export/download/route.ts']) {
      const src = read(p);
      expect(src).not.toMatch(/write-access-guard|refuserSiLectureSeule|getEntitlements|canWrite/);
      expect(src).toMatch(/SessionService\.getSession/);
    }
  });
  it('le middleware ne bloque pas le mode restreint et ne range pas l’export parmi les opérations commerciales', () => {
    const mw = read('src/middleware.ts');
    expect(mw).not.toMatch(/NO_ACTIVE_ACCOUNT['"]\s*,\s*\n?\s*status: 403/);
    const commerce = read('src/lib/native/commerce.ts');
    expect(commerce).not.toMatch(/gdpr-export/);
  });
  it('« Mes données » reste affiché sur l’écran « Compte en cours de suppression »', () => {
    expect(read('src/app/compte-en-suppression/page.tsx')).toMatch(/<MyDataCard defaultOpen \/>/);
  });
  it('numéro de partie : 1 par défaut, entier positif seulement', () => {
    expect(parseExportPartParam(null)).toBe(1);
    expect(parseExportPartParam('')).toBe(1);
    expect(parseExportPartParam('3')).toBe(3);
    expect(parseExportPartParam('0')).toBeNull();
    expect(parseExportPartParam('-1')).toBeNull();
    expect(parseExportPartParam('2;drop')).toBeNull();
    expect(parseExportPartParam('99999')).toBeNull();
  });
});

describe('L102C-EXP-04 — tous les originaux, en parties de taille bornée', () => {
  it('aucun document omis pour cause de taille : 1,2 Go → parties ≤ 100 Mo', () => {
    const docs = Array.from({ length: 24 }, (_, i) => doc(i + 1, 50 * MB));
    const plan = planExportParts(docs, { maxPartBytes: 100 * MB, maxParts: 200 });
    expect(plan.include).toHaveLength(24);
    expect(plan.skipped).toEqual([]);
    expect(plan.parts).toHaveLength(12);
    for (const p of plan.parts) expect(p.bytes).toBeLessThanOrEqual(100 * MB);
    expect(plan.parts.map((p) => p.number)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });
  it('un document plus gros que la borne occupe seul sa partie (jamais coupé ni omis)', () => {
    const plan = planExportParts([doc(1, 10 * MB), doc(2, 300 * MB), doc(3, 10 * MB)], { maxPartBytes: 100 * MB, maxParts: 10 });
    expect(plan.parts.map((p) => p.documents.map((d) => d.id))).toEqual([[1], [2], [3]]);
  });
  it('partie 1 toujours présente (données), même sans document ; fichier absent du stockage listé', () => {
    const plan = planExportParts([doc(1, 1, { s3Key: null })], { maxPartBytes: MB, maxParts: 5 });
    expect(plan.parts).toEqual([{ number: 1, documents: [], bytes: 0 }]);
    expect(plan.skipped[0]).toMatchObject({ id: 1, reason: 'NO_STORED_FILE' });
  });
  it('garde-fou du nombre de parties : au-delà, listé PART_LIMIT (jamais silencieux)', () => {
    const plan = planExportParts([doc(1, 60), doc(2, 60), doc(3, 60)], { maxPartBytes: 100, maxParts: 2 });
    expect(plan.parts).toHaveLength(2);
    expect(plan.skipped).toEqual([expect.objectContaining({ id: 3, reason: 'PART_LIMIT' })]);
  });
  it('noms uniques sur toute l’archive (parties extraites dans un même dossier)', () => {
    const plan = planExportParts([doc(1, 60, { originalFilename: 'a.pdf', filename: 'a.pdf' }), doc(2, 60, { originalFilename: 'a.pdf', filename: 'a.pdf' })], { maxPartBytes: 100, maxParts: 5 });
    const paths = plan.include.map((d) => d.path);
    expect(new Set(paths).size).toBe(2);
    expect(plan.parts).toHaveLength(2);
  });
  it('manifeste global (partie 1) : contenu de chaque partie ; manifeste propre à chaque partie ; LISEZ-MOI', () => {
    const plan = planExportParts([doc(1, 60), doc(2, 60)], { maxPartBytes: 100, maxParts: 5 });
    const c = buildGdprExportContent({
      generatedAt: new Date('2033-01-02T10:00:00Z'), userId: 7, accountIds: [3], tables: [{ table: 'assets', rows: [{ id: 1 }] }], documents: plan,
      parts: plan.parts.map((p) => ({ plan: p, fileName: `x-partie-${p.number}.zip` })),
    });
    expect(c.manifest.version).toBe(2);
    expect(c.manifest.parts).toEqual([
      { part: 1, fileName: 'x-partie-1.zip', documents: 1, documentsBytes: 60, files: [{ id: 1, path: plan.parts[0].documents[0].path }] },
      { part: 2, fileName: 'x-partie-2.zip', documents: 1, documentsBytes: 60, files: [{ id: 2, path: plan.parts[1].documents[0].path }] },
    ]);
    expect(c.textFiles['LISEZ-MOI.txt']).toMatch(/découpée en 2 parties/);
    const m2 = JSON.parse(partManifest({ generatedAt: new Date('2033-01-02T10:00:00Z'), part: plan.parts[1], totalParts: 2 }));
    expect(m2).toMatchObject({ part: 2, totalParts: 2, documents: [{ id: 2 }] });
  });
  it('l’ancien plafond global n’est plus appliqué par la génération', () => {
    // Lot 103C : la génération est portée par le travail durable `gdpr-export.job.ts`.
    const src = read('src/services/gdpr/gdpr-export.job.ts');
    expect(src).toMatch(/planExportParts\(/);
    expect(src).not.toMatch(/planDocumentFiles\(|envInt\('GDPR_EXPORT_MAX_DOCUMENT_BYTES'/);
    expect(src).toMatch(/GDPR_EXPORT_PART_MAX_BYTES/);
  });
});

describe('L102C-EXP-02b — raccord avec le modèle d\'état restreint 102A', () => {
  it('chaque motif du cycle de vie (fin d\'essai, fin d\'abonnement, rétractation, suppression demandée) garde l\'export', async () => {
    const { RESTRICTED_REASONS } = await import('@/lib/account-lifecycle/retention-policy');
    const { canExportInRestrictedState } = await import('@/services/gdpr/restricted-export-access');
    vi.doMock('@/db', () => ({ db: {}, pgClient: {} }));
    const { EXPORT_STATE_OF } = await import('@/services/account/restricted-state.service');
    for (const r of RESTRICTED_REASONS) {
      expect(EXPORT_STATE_OF[r]).toBeTruthy();
      expect(canExportInRestrictedState(EXPORT_STATE_OF[r])).toBe(true);
    }
  });
});
