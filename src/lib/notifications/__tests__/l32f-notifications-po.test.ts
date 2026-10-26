/**
 * Lot 32 — décisions PO du 07/10/2026 sur les notifications et réglages.
 *
 *   PO-Q18/Q19 : après un envoi réussi (fichier ou lien web), une
 *                NOTIFICATION pour tous les comptes (Standard compris), une
 *                seule par lot d'envoi ; pas de toast.
 *   PO-Q25     : le rappel du matin (8 h 30 – 11 h) peut être désactivé
 *                depuis le réglage des notifications.
 *   PO-Q23     : aucun plafond mensuel de coût IA par compte par défaut.
 *   PO-Q24     : pas de lien « Renoncer au contrat » sur la page de connexion.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs = new Map<string, boolean>();
vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: vi.fn() } }));
vi.mock('../preferences', () => ({
  getPreference: async (_u: number, category: string, mode: string, channel: string) => prefs.get(`${category}|${mode}|${channel}`) ?? null,
}));
vi.mock('../news-consent', () => ({ hasActiveNewsConsent: async () => false }));

const { NOTIFICATION_CATALOG } = await import('../catalog');
const { resolveChannels } = await import('../policy-resolver');
const { uploadNotificationText } = await import('../upload-notification-text');
const { sanitizeFileIds, uploadDedupeKey } = await import('@/services/documents/upload-notification.service');

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

beforeEach(() => prefs.clear());

describe('PO-Q18/Q19 — notification après un envoi réussi', () => {
  const entry = NOTIFICATION_CATALOG.DOCUMENT_UPLOAD_COMPLETED!;

  it('type au catalogue : cloche toujours, push / e-mail selon les préférences « Documents »', async () => {
    expect(entry).toMatchObject({ category: 'documents', neverBell: false, mandatoryBell: false, mandatoryEmail: false });
    expect(await resolveChannels(1, entry)).toEqual({ bell: true, push: false, email: false });
    prefs.set('documents|immediate|email', true);
    prefs.set('documents|immediate|push', true);
    expect(await resolveChannels(1, entry)).toEqual({ bell: true, push: true, email: true });
    expect(entry.render({ count: 1 }).emailTemplateCode).toBe('notif_document_upload');
    expect(read('src/db/migrations/0279_lot32_withdrawal_immediate.sql')).toContain("('notif_document_upload'");
  });

  it('textes : fichier nommé, lien web, lot de plusieurs documents ; push générique', () => {
    expect(uploadNotificationText({ count: 1, documentTitle: 'Facture.pdf' })).toEqual({ title: 'Document ajouté', body: '« Facture.pdf » a bien été ajouté.' });
    expect(uploadNotificationText({ count: 1, kind: 'web_link', documentTitle: 'Notice' }).title).toBe('Lien web ajouté');
    expect(uploadNotificationText({ count: 3 })).toEqual({ title: 'Documents ajoutés', body: '3 documents ont bien été ajoutés.' });
    const r = entry.render({ count: 1, documentTitle: 'Acte de vente.pdf' });
    expect(r.pushBody).not.toContain('Acte de vente');
    expect(entry.deepLink({ count: 1, assetFileId: 42 })).toContain('42');
    expect(entry.deepLink({ count: 2 })).toBe('/documents');
    expect(entry.payloadSchema.safeParse({ count: 0 }).success).toBe(false);
  });

  it('une seule notification par lot : clé de déduplication par lot (reprise tardive comprise)', () => {
    expect(uploadDedupeKey(7, 'lot-abc', [3, 1])).toBe(uploadDedupeKey(7, 'lot-abc', [9]));
    expect(uploadDedupeKey(7, null, [3, 1])).toBe(uploadDedupeKey(7, undefined, [1, 3]));
    expect(uploadDedupeKey(7, null, [1])).not.toBe(uploadDedupeKey(7, null, [2]));
    expect(uploadDedupeKey(7, 'x y; drop', [1])).toBe(uploadDedupeKey(7, null, [1]));
    expect(sanitizeFileIds([1, '2', 2, -3, 'x', 4.5])).toEqual([1, 2]);
  });

  it('tous les comptes (aucune condition d’offre), aucun toast ; fichiers et lien web', () => {
    const svc = read('src/services/documents/upload-notification.service.ts');
    expect(svc).not.toMatch(/isPremium|planType|plan_code|getCommercialPlan/);
    expect(svc).toContain('recipientUserIds: [input.userId]');
    const dialog = read('src/components/documents/unified-document-dialog.tsx');
    expect(dialog).toContain('signalerEnvoiReussi(bilan.fileIds, bilan.lotId);');
    expect(dialog).toContain('signalerEnvoiReussi(ids, `wl-${webLink.id}`);');
    expect(dialog).not.toMatch(/toast\.success/);
    expect(read('src/lib/upload-notification-client.ts')).not.toMatch(/from 'sonner'|toast\(/);
    // Pas d'affichage forcé dans la cloche (`mustDeliver` réservé aux obligatoires) : pas de toast.
    expect(entry.mandatoryBell).toBe(false);
  });

  it('la cloche sait l’afficher, et le BO le nomme', () => {
    const bell = read('src/components/NotificationBell.tsx');
    expect(bell).toContain("case 'DOCUMENT_UPLOAD_COMPLETED':");
    expect(read('src/services/admin/communications.service.ts')).toContain("DOCUMENT_UPLOAD_COMPLETED: 'Documents ajoutés (envoi réussi)'");
  });
});

describe('PO-Q25 — le rappel du matin peut être désactivé depuis le réglage des notifications', () => {
  it('rappels d’échéance J-7 (envoyés à partir de 8 h 30) : e-mail coupé par le switch « Échéances et rappels »', async () => {
    const j7 = NOTIFICATION_CATALOG.DEADLINE_DUE_IN_7_DAYS!;
    expect(j7.mandatoryEmail).toBe(false);
    expect((await resolveChannels(1, j7)).email).toBe(true);
    prefs.set('deadlines|immediate|email', false);
    expect((await resolveChannels(1, j7)).email).toBe(false);
  });

  it('récapitulatif « À traiter » de 8 h 30 : e-mail coupé par son switch dédié', async () => {
    const digest = NOTIFICATION_CATALOG.TO_PROCESS_DAILY_DIGEST!;
    expect(digest.mandatoryEmail).toBe(false);
    prefs.set('to_process|daily_digest|email', false);
    expect((await resolveChannels(1, digest)).email).toBe(false);
  });

  it('ces switchs sont proposés et NON verrouillés dans Mon compte → Notifications', () => {
    const verrouillees = Object.values(NOTIFICATION_CATALOG).filter((e) => e?.mandatoryEmail).map((e) => e!.category);
    expect(verrouillees).not.toContain('deadlines');
    expect(verrouillees).not.toContain('to_process');
    const page = read('src/app/(dashboard)/mon-compte/notifications/page.tsx');
    expect(page).toContain('Récapitulatif quotidien à 8 h 30');
    // Fenêtre d'envoi 8 h 30 – 11 h inchangée (décision PO : OK).
    expect(read('src/lib/notifications/scheduled/morning-events.ts')).toContain('MORNING_SLOT: readonly [number, number] = [8, 30]');
  });
});

describe('PO-Q23 — aucun plafond mensuel de coût IA par compte par défaut', () => {
  it('plafonds par offre (lot 22) et plafond de l’assistant : 0 = sans plafond par défaut', async () => {
    const { ASSISTANT_SETTINGS } = await import('@/services/verebona-assistant/config/assistant-settings');
    const plafonds = ASSISTANT_SETTINGS.filter((d) => d.key.startsWith('ai_cost_cap_') || d.key === 'monthly_budget_micros');
    expect(plafonds.map((d) => d.key).sort()).toEqual([
      'ai_cost_cap_premium_duo_micros', 'ai_cost_cap_premium_micros', 'ai_cost_cap_premium_pro_micros', 'ai_cost_cap_standard_micros', 'monthly_budget_micros',
    ]);
    for (const d of plafonds) expect(d.default, d.key).toBe(0);
    expect(read('src/services/verebona-assistant/config/assistant-config.ts')).toContain("num('VEREBONA_ASSISTANT_MONTHLY_BUDGET_MICROS', 0)");
  });

  it('le mécanisme reste en place : une valeur réglée dans le BO plafonne ; 0 / absente = aucun plafond', async () => {
    const { effectiveCap, costCapLevel } = await import('@/services/ai/gateway/account-cost-cap');
    expect(effectiveCap({ offerCapMicros: null, overrideMicros: null })).toEqual({ capMicros: null, source: null });
    expect(effectiveCap({ offerCapMicros: 0, overrideMicros: null }).capMicros).toBeNull();
    expect(costCapLevel(5_000_000, null)).toBe('none');
    expect(effectiveCap({ offerCapMicros: 3_000_000, overrideMicros: null })).toEqual({ capMicros: 3_000_000, source: 'offer' });
    expect(costCapLevel(3_000_000, 3_000_000)).toBe('reached');
    // Le suivi des coûts n'est pas conditionné au plafond (cumul lu en base).
    expect(read('src/services/ai/gateway/account-cost-cap.ts')).toContain('SELECT COALESCE(SUM(cost_micros), 0)::bigint AS spent');
  });
});

describe('PO-Q24 — pas de lien « Renoncer au contrat » sur la page de connexion', () => {
  it('la page de connexion et son pied de page ne l’affichent pas', () => {
    const login = read('src/app/(auth)/login/page.tsx');
    expect(login).not.toContain('/retractation');
    expect(login).not.toContain('Renoncer au contrat');
    expect(login).toContain('<AuthFooter />');
    const footers = read('src/components/LandingFooter.tsx');
    const auth = footers.slice(footers.indexOf('export function AuthFooter'), footers.indexOf('export function LandingFooter'));
    expect(auth).not.toContain('/retractation');
  });

  it('conservé ailleurs (légalement utile) : pieds de page des autres écrans hors connexion, Mon compte pendant le délai', () => {
    expect(read('src/components/LandingFooter.tsx')).toMatch(/href: '\/retractation',\s+label: 'Renoncer au contrat ici'/);
    expect(read('src/components/Footer.tsx')).toMatch(/href: '\/retractation',\s+label: 'Renoncer au contrat ici'/);
    expect(read('src/components/account/WithdrawalCard.tsx')).toContain('<Link href="/retractation">Renoncer au contrat ici</Link>');
  });
});
