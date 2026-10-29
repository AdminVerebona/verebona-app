/**
 * Lot 72D — ticket P0 « Premium Duo — compte partagé » : briques pures et
 * parité desktop / mobile. Les parcours réels (inscription, vérification,
 * acceptation, connexion, changement d'espace, retrait, rattrapage) sont
 * couverts sur PostgreSQL 16 par `src/test/e2e/scenarios/l72d-duo-compte-partage.e2e.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { orderSessionAccounts, resolveSessionAccount, withoutArchivedAccounts } from '@/lib/auth/account-suspension';
import { readSpaceParam, withSpaceParam } from '@/lib/shell/space-link';
import { getPlanLabel } from '@/lib/plan-label';
import { isOwnerOnlyNotification } from '@/lib/notifications/recipient-resolver';
import { summarizeBackfill } from '@/services/admin/ops/backfill/report-format';
import { BACKFILL_DEFINITIONS, validateBackfillRequest } from '@/services/admin/ops/backfill/definitions';
import { accountCapacity, spacePlanLabel } from '@/services/account/membership.service';
import { duoRouteRemoved, DUO_CROSS_VALIDATION_REMOVED } from '@/lib/duo/removed-routes';

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const t = (iso: string) => new Date(iso);
const cand = (id: number, role: string, lastSelectedAt: Date | null, extra: Record<string, unknown> = {}) => ({
  account: { id, isActive: true, ...extra }, membershipId: id, role, joinedAt: t('2026-01-01'), lastSelectedAt,
});

describe('L72D-04 — choix de l’espace à la connexion', () => {
  it('le dernier espace choisi passe avant l’ordre « titulaire d’abord »', () => {
    const ordre = orderSessionAccounts([cand(1, 'owner', null), cand(2, 'member', t('2026-10-01')), cand(3, 'member', t('2026-10-10'))]);
    expect(ordre.map((c) => c.account.id)).toEqual([3, 2, 1]);
  });

  it('sans choix mémorisé : ordre historique inchangé (titulaire, puis ancienneté)', () => {
    expect(orderSessionAccounts([cand(2, 'member', null), cand(1, 'owner', null)]).map((c) => c.account.id)).toEqual([1, 2]);
  });

  it('compte archivé (Q9) : jamais choisi par défaut, sauf s’il est le seul', () => {
    const r = resolveSessionAccount([cand(1, 'owner', t('2026-10-10'), { archivedAt: t('2026-10-11') }), cand(2, 'member', null)], { role: 'USER' });
    expect(r.allowed && r.account?.id).toBe(2);
    expect(withoutArchivedAccounts([cand(1, 'owner', null, { archivedAt: t('2026-10-11') })]).map((c) => c.account.id)).toEqual([1]);
  });

  it('refresh : le compte de la session reste choisi tant qu’il est accessible', () => {
    const r = resolveSessionAccount([cand(1, 'owner', t('2026-10-10')), cand(2, 'member', null)], { role: 'USER', preferredAccountId: 2 });
    expect(r.allowed && r.account?.id).toBe(2);
  });
});

describe('L72D-08 — libellé « Premium Duo — Membre » (Q16)', () => {
  it('membre : jamais d’essai ni de compteur J-x', () => {
    expect(getPlanLabel({ plan: 'PREMIUM_DUO', duoRole: 'MEMBER', trialStatus: 'active', trialDaysLeft: 3 })).toBe('Premium Duo — Membre');
    expect(getPlanLabel({ plan: 'PREMIUM_DUO', duoRole: 'BILLING_OWNER' })).toBe('Premium Duo');
    expect(getPlanLabel({ plan: 'STANDARD', trialStatus: 'active', trialDaysLeft: 2 })).toBe('Essai gratuit · J-2');
    expect(spacePlanLabel('PREMIUM_DUO', 'member')).toBe('Premium Duo — Membre');
    expect(spacePlanLabel('PREMIUM_DUO', 'owner')).toBe('Premium Duo — Titulaire');
    expect(spacePlanLabel('STANDARD', 'owner')).toBe('Standard');
  });
});

describe('L72D-17 — capacité générique (aucune limite structurelle à deux)', () => {
  it('max_members fait foi ; un Duo historique à 1 garde ses deux places', () => {
    expect(accountCapacity({ planType: 'PREMIUM_DUO', maxMembers: 1 })).toBe(2);
    expect(accountCapacity({ planType: 'PREMIUM_DUO', maxMembers: 5 })).toBe(5);
    expect(accountCapacity({ planType: 'STANDARD', maxMembers: 1 })).toBe(1);
  });
});

describe('L72D-19 — notifications (Q15) et liens vers un espace (Q7)', () => {
  it('facturation, essai, renouvellement, impayé, parrainage : titulaire seulement', () => {
    for (const t of ['TRIAL_ENDED', 'TRIAL_ENDING', 'SUBSCRIPTION_RENEWED', 'PAYMENT_FAILED', 'REFERRAL_REWARD_GRANTED']) expect(isOwnerOnlyNotification(t), t).toBe(true);
    for (const t of ['DEADLINE_REMINDER', 'DOCUMENT_ANALYZED', 'DUO_MEMBERSHIP_ENDED', 'ACCOUNT_INVITATION']) expect(isOwnerOnlyNotification(t), t).toBe(false);
  });

  it('lien interne : paramètre `space` ajouté, relu, retiré ; lien externe intact', () => {
    expect(withSpaceParam('/agenda', 12)).toBe('/agenda?space=12');
    expect(withSpaceParam('/assets/3?tab=a#x', 12)).toBe('/assets/3?tab=a&space=12#x');
    expect(withSpaceParam('/agenda?space=4', 12)).toBe('/agenda?space=12');
    expect(withSpaceParam('//evil.example/x', 12)).toBe('//evil.example/x');
    expect(withSpaceParam('/agenda', null)).toBe('/agenda');
    expect(readSpaceParam('https://app.x/assets/3?tab=a&space=12#x')).toEqual({ accountId: 12, cleaned: '/assets/3?tab=a#x' });
    expect(readSpaceParam('https://app.x/accueil?space=abc').accountId).toBeNull();
  });

  it('push et e-mail portent l’espace émetteur ; la cloche bascule avant d’ouvrir', () => {
    const canaux = lire('src/lib/notifications/channels.ts');
    // Lot 94 (M3) : plus de Web Push ; le push mobile natif porte l'espace émetteur.
    expect(lire('src/lib/notifications/mobile-push.ts')).toMatch(/withSpaceParam\(href \?\? null, accountId\)/);
    expect(canaux).toMatch(/absoluteUrl\(withSpaceParam\(rendered\.href/);
    const cloche = lire('src/components/NotificationBell.tsx');
    expect(cloche).toContain('switchToAccount(notif.accountId, cible)');
    expect(lire('src/components/DashboardLayout.tsx')).toContain('readSpaceParam(window.location.href)');
  });
});

describe('L72D-UI — même composant sur ordinateur et sur mobile', () => {
  it('sélecteur d’espace (Q6) dans le menu de l’avatar ET le panneau du compte mobile, visible dès 2 espaces', () => {
    expect(lire('src/components/TopBar.tsx')).toMatch(/<AccountSwitcher accountsCount=\{user\.accountsCount\} variant="menu" \/>/);
    expect(lire('src/components/mobile/mobile-account-panel.tsx')).toMatch(/<AccountSwitcher accountsCount=\{accountsCount\} variant="panel" \/>/);
    const comp = lire('src/components/account/AccountSwitcher.tsx');
    expect(comp).toMatch(/\(accountsCount \?\? 1\) >= 2/);
    expect(comp).toContain("'/api/auth/switch-account'");
    expect(comp).toContain('window.location.assign(target)');
  });

  it('écran « sans espace » (Q8) rendu par la coquille unique, desktop et mobile', () => {
    const layout = lire('src/components/DashboardLayout.tsx');
    expect(layout).toMatch(/user\.accountId === null[\s\S]{0,120}<NoSpaceScreen/);
    const ecran = lire('src/components/shell/NoSpaceScreen.tsx');
    expect(ecran).toContain("'/api/accounts/personal'");
    expect(ecran).toContain('Rejoindre l’espace Premium Duo');
  });

  it('après acceptation : rechargement complet sur l’espace du Duo (page d’invitation, vérification, accueil)', () => {
    for (const p of ['src/app/duo/join/[token]/page.tsx', 'src/app/(auth)/verify-email/page.tsx', 'src/app/(dashboard)/accueil/page.tsx']) {
      expect(lire(p), p).toContain("window.location.assign('/accueil')");
    }
  });
});

describe('L72D-15 — rattrapage BO « duo-shared-account » (bloc 11)', () => {
  it('catalogue : simulation, application, restauration ; motif obligatoire ; filtre compte', () => {
    const def = BACKFILL_DEFINITIONS.find((d) => d.script === 'duo-shared-account')!;
    expect(def).toMatchObject({ order: 11, actions: ['simulate', 'apply', 'restore'], accountFilter: true });
    expect(validateBackfillRequest({ script: 'duo-shared-account', action: 'simulate', accountId: 4 })).toMatchObject({ ok: true });
    expect(validateBackfillRequest({ script: 'duo-shared-account', action: 'apply', reason: 'x' })).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(validateBackfillRequest({ script: 'duo-shared-account', action: 'restore', reason: 'Retour arrière 72D', runId: 'pas-un-uuid' })).toMatchObject({ ok: false, code: 'INVALID_RUN_ID' });
  });

  it('synthèse lisible avant / après', () => {
    const inv = { A: 1, B: 2, C: 0, D1: 1, D2: 1, D3: 0, D4: 0, E: 2, F: 0, G: 0, H: 1, I: 0 };
    const base = {
      runId: null, accountId: null, before: inv, after: null,
      actions: { ownerMembershipsCreated: 0, ownerMembershipsReactivated: 0, memberMembershipsCreated: 0, memberMembershipsReactivated: 0, accountsArchived: 0, planTypesFixed: 0, lastSelectedSet: 0 },
      duos: [], undecidable: [], seatsExceeded: [], suspiciousInvitations: [], billingMismatches: [], ownerFixes: [], planTypeFixes: [],
    };
    const sim = summarizeBackfill('duo-shared-account', 'simulate', null, { result: { ...base, mode: 'simulate' } });
    expect(sim.headline).toBe('Simulation : 2 membre(s) Duo à rattacher au compte partagé, 1 adhésion(s) titulaire à rétablir, 1 compte(s) artificiel(s) vide(s) à archiver, 0 Duo indécidable(s).');
    expect(sim.restorable).toBe(false);
    const app = summarizeBackfill('duo-shared-account', 'apply', null, { result: {
      ...base, mode: 'apply', runId: '11111111-1111-4111-8111-111111111111', after: { ...inv, A: 0, B: 0 },
      actions: { ...base.actions, memberMembershipsCreated: 2, ownerMembershipsCreated: 1, accountsArchived: 1 },
    } });
    expect(app).toMatchObject({ restorable: true, scriptRunId: '11111111-1111-4111-8111-111111111111' });
    expect(app.headline).toContain('2 membre(s) rattaché(s)');
  });
});

describe('L72D-14 / Q11 — validations croisées retirées', () => {
  it('routes en 410 avec un code stable et une trace', async () => {
    const r = duoRouteRemoved(new NextRequest('http://x/api/assets/3/move-request', { method: 'POST' }));
    expect(r.status).toBe(410);
    expect((await r.json()).code).toBe(DUO_CROSS_VALIDATION_REMOVED);
    for (const p of [
      'src/app/api/assets/[id]/move-request/route.ts', 'src/app/api/assets/[id]/delete-request/route.ts',
      'src/app/api/move-requests/[id]/respond/route.ts', 'src/app/api/delete-requests/[id]/respond/route.ts',
      'src/app/api/duos/[id]/requests/inbox/route.ts', 'src/app/api/duos/[id]/recovery/assets/route.ts', 'src/app/api/duos/[id]/leave/route.ts',
    ]) expect(lire(p), p).toContain('duoRouteRemoved');
  });

  it('migration 0522 : demandes en attente annulées, verrous levés, journalisés, rien supprimé', () => {
    const m = lire('src/db/migrations/0522_l72d_cancel_cross_validation.sql');
    expect(m).toMatch(/SET status = 'CANCELLED'/);
    expect(m).toMatch(/SET lock_state = 'NONE'/);
    expect(m).toContain('duo_shared_account_journal');
    expect(m).not.toMatch(/\b(DELETE FROM|DROP TABLE|DROP COLUMN)\b/);
  });
});
