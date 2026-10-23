/**
 * Lot 83E — contrôles C5 (Agenda / T4 / « À traiter ») et C6 (T6,
 * notifications, abonnements, Duo) du registre de cohérence : contrat,
 * couverture, décisions pures, comptes non éligibles (C-Q10), retrait de la
 * campagne de pertinence et du balayage horaire de projection (C-Q9). Sans
 * base (voir `l83e-coherence-c5-c6.e2e.ts` pour l'exécution réelle).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COHERENCE_REGISTRY, activeChecks, getCheck } from '../registry';
import { COVERAGE_INVENTORY } from '../registry/coverage';
import { checkRunsInScope, SUBSCRIPTION_STATE_REASONS } from '../orchestrator';
import { COHERENCE_BUSINESS_EVENTS } from '../events';
import { projectionAnomaly, projectionGaps } from '../registry/checks/agenda-projection';
import { t6Anomaly } from '../registry/checks/t6-notifications';
import { billingDesync, duoFindings, entitlementDesync } from '../registry/checks/billing';
import { STATE_FAMILY_RULES, relevanceCardRuleCodes, documentFieldRuleCodes } from '../registry/checks/to-process-relevance';
import { expectedAccountState } from '@/services/billing/subscription-sync.service';

const ROOT = join(__dirname, '../../../..');
const lire = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const NOUVEAUX = [
  'COH-TODO-STALE-DECISIONS', 'COH-TODO-RELEVANCE-CARDS', 'COH-TODO-ORPHAN-CARDS', 'COH-TODO-RESOLUTION-PROPAGATION',
  'COH-AGENDA-OPERATION-PROJECTION', 'COH-AGENDA-PROJECTION-ORPHANS',
  'COH-T6-EVALUATIONS', 'COH-NOTIF-OUTBOX', 'COH-SUBSCRIPTION-COMMUNICATIONS',
  'COH-BILLING-STRIPE', 'COH-ENTITLEMENTS', 'COH-DUO-RELATIONS',
];

describe('L83E-U-REG — contrôles C5 / C6 enregistrés au registre', () => {
  it('L83E-U-REG-01 — ajoutés en fin de registre, actifs ; le point d’extension T4 documentaire est déclaré et jamais exécuté', () => {
    const actifs = activeChecks().map((c) => c.id);
    for (const id of NOUVEAUX) expect(actifs, id).toContain(id);
    // Ordre existant conservé (ajout en fin : 83B ajoute aussi ses lignes).
    expect(COHERENCE_REGISTRY.map((c) => c.id).slice(0, 6)).toEqual([
      'COH-TODO-DOCUMENT-FIELDS', 'COH-DOC-LINKS', 'COH-AGENDA-OCCURRENCES', 'COH-AGENDA-ORPHANS', 'COH-TCO-EXTRACTED-EXPENSES', 'COH-DOC-EXTRACT-CHAIN',
    ]);
    const t4 = getCheck('COH-AGENDA-T4-DOCUMENT-DEADLINES')!;
    expect(t4.status).toBe('PLANNED');
    expect(actifs).not.toContain(t4.id);
    // Orphelins d'agenda : nouvelle version (événements documentaires inclus) → stock réexaminé.
    expect(getCheck('COH-AGENDA-ORPHANS')!.version).toBe(2);
  });

  it('L83E-U-REG-02 — chaque déclencheur est un événement relayé ; aucun contrôle de C6 n’écrit chez Stripe ni n’émet de communication', () => {
    const relayes = new Set([...COHERENCE_BUSINESS_EVENTS, 'SOURCE_ANALYZED']);
    for (const id of NOUVEAUX) for (const t of getCheck(id)!.triggers) expect(relayes.has(t), `${id} → ${t}`).toBe(true);
    const code = sansCommentaires(lire('src/services/coherence/registry/checks/billing.ts') + lire('src/services/coherence/registry/checks/t6-notifications.ts'));
    expect(code).not.toMatch(/subscriptions\.(update|cancel|create|del)|invoices\.|refunds\.|customers\.(update|create|del)/);
    expect(code).not.toMatch(/\bemit\(|emitNotification|sendEmail|processEmailJob|processOutboxIds|enqueue\(/);
    // Lecture Stripe : une seule méthode utilisée.
    expect([...new Set(code.match(/subscriptions\.\w+/g))]).toEqual(['subscriptions.retrieve']);
    // Aucune écriture SQL directe dans les contrôles du lot (réparations : services métier).
    const tous = sansCommentaires(['to-process-relevance', 'agenda-projection', 't6-notifications', 'billing']
      .map((f) => lire(`src/services/coherence/registry/checks/${f}.ts`)).join('\n'));
    expect(tous).not.toMatch(/\b(UPDATE\s+\w+\s+SET|DELETE\s+FROM|INSERT\s+INTO)\b/i);
  });

  it('L83E-U-REG-03 — détection seule là où le CDC l’exige (Duo, T6, communications) ; surveillances existantes non signalées deux fois', () => {
    for (const id of ['COH-DUO-RELATIONS', 'COH-T6-EVALUATIONS', 'COH-SUBSCRIPTION-COMMUNICATIONS']) expect(getCheck(id)!.repair, id).toBeUndefined();
    expect(getCheck('COH-T6-EVALUATIONS')!.externalSupervision).toMatch(/mascot-t6-supervision/);
  });
});

describe('L83E-U-COVERAGE — couverture explicite (CA-19)', () => {
  it('agenda, « À traiter », T6, comptes, abonnements, notifications : contrôles cités, lacunes restantes déclarées', () => {
    const par = new Map(COVERAGE_INVENTORY.map((e) => [e.domain, e]));
    expect(par.get('agenda')!.checks).toEqual(expect.arrayContaining(['COH-AGENDA-OPERATION-PROJECTION', 'COH-AGENDA-PROJECTION-ORPHANS']));
    expect(par.get('agenda')!.gap!.planned).toMatch(/COH-AGENDA-T4-DOCUMENT-DEADLINES/);
    expect(par.get('a-traiter')!.checks).toEqual(expect.arrayContaining(['COH-TODO-STALE-DECISIONS', 'COH-TODO-RELEVANCE-CARDS', 'COH-TODO-ORPHAN-CARDS', 'COH-TODO-RESOLUTION-PROPAGATION']));
    expect(par.get('t6')!.checks).toEqual(['COH-T6-EVALUATIONS']);
    expect(par.get('comptes')!.checks).toEqual(['COH-DUO-RELATIONS']);
    expect(par.get('abonnements')!.checks).toEqual(['COH-BILLING-STRIPE', 'COH-ENTITLEMENTS']);
    expect(par.get('notifications')!.checks).toEqual(['COH-NOTIF-OUTBOX', 'COH-SUBSCRIPTION-COMMUNICATIONS']);
  });
});

describe('L83E-U-RELEVANCE — campagne l76 devenue contrôle (mêmes règles, une seule chaîne)', () => {
  it('familles de la campagne couvertes ; cartes « donnée » documentaires laissées à COH-TODO-DOCUMENT-FIELDS', async () => {
    const cartes = await relevanceCardRuleCodes();
    expect(cartes).toEqual(expect.arrayContaining(['DOC-INTERVENTION', ...STATE_FAMILY_RULES]));
    const donnees = await documentFieldRuleCodes();
    expect(donnees).toEqual(expect.arrayContaining(['DATA-CONTRACT-END', 'DATA-WARRANTY-END']));
    for (const r of donnees) expect(cartes, r).not.toContain(r);
  });

  it('C-Q9 — moteur de campagne RETIRÉ (code, tâche, route) ; historique conservé en lecture', async () => {
    const svc = await import('@/services/to-process/relevance-campaign.service');
    for (const f of ['runRelevanceCampaign', 'startRelevanceCampaign', 'retryCampaignErrors', 'campaignOutcomeOf']) expect((svc as Record<string, unknown>)[f], f).toBeUndefined();
    expect(typeof svc.listRelevanceCampaigns).toBe('function');
    expect(typeof svc.listCampaignItems).toBe('function');
    const fautes: string[] = [];
    const walk = (d: string, out: string[] = []): string[] => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e)) out.push(p);
      }
      return out;
    };
    for (const f of walk(join(ROOT, 'src'))) {
      const rel = relative(ROOT, f);
      if (rel.endsWith('l83e-registre-c5-c6.test.ts')) continue;
      const src = sansCommentaires(readFileSync(f, 'utf8'));
      if (/\b(runRelevanceCampaign|startRelevanceCampaign|retryCampaignErrors|startAgendaProjectionSweep|listAccountsNeedingProjection)\s*\(/.test(src)) fautes.push(rel);
    }
    expect(fautes).toEqual([]);
    const { SCHEDULED_TASKS } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const t = SCHEDULED_TASKS.find((x) => x.code === 'to-process-relevance-reevaluation')!;
    expect(t.label).not.toMatch(/pertinence/);
    expect(sansCommentaires(lire('src/app/api/admin/ai/queue/to-process-relevance/route.ts'))).toMatch(/CAMPAIGN_RETIRED/);
    expect(existsSync(join(ROOT, 'src/db/migrations/0676_l83e_pertinence_vers_registre.sql'))).toBe(true);
  });
});

describe('L83E-U-PROJECTION — écarts de projection (projection appelée, jamais recopiée)', () => {
  it('CREATE = échéance calculable absente ; REMOVE / DETACH = événement obsolète ; intervention : LINK laissé à 76H', () => {
    expect(projectionAnomaly(projectionGaps('CONTRACT', [{ kind: 'CREATE' }, { kind: 'ABSTAIN' }]))).toBe('MISSING_CALCULABLE_EVENT');
    expect(projectionAnomaly(projectionGaps('CLAIM', [{ kind: 'DETACH', itemId: 3 }]))).toBe('OBSOLETE_EVENT');
    expect(projectionAnomaly(projectionGaps('CONTRACT', [{ kind: 'SYNC', itemId: 3 }, { kind: 'ROLE', itemId: 3 }]))).toBe('EVENT_OUT_OF_SYNC');
    expect(projectionGaps('INTERVENTION', [{ kind: 'LINK', itemId: 1 }, { kind: 'CONSOLIDATE' }])).toEqual([]);
    expect(projectionAnomaly(projectionGaps('ACQUISITION', [{ kind: 'LINK', itemId: 1 }]))).toBe('EVENT_NOT_LINKED');
    expect(projectionGaps('CONTRACT', [{ kind: 'ABSTAIN', candidates: [1] }, { kind: 'SUPPRESSED' }, { kind: 'RETITLE' }, { kind: 'PROPOSE_DONE' }])).toEqual([]);
    // Aucune règle de projection recopiée : le contrôle n'importe que le point d'entrée public.
    const code = sansCommentaires(lire('src/services/coherence/registry/checks/agenda-projection.ts'));
    expect(code).not.toMatch(/decideProjection|planOperationProjection|projectionKeyOf|matchExistingItem/);
    expect(code).toMatch(/projectAccountOperations/);
  });
});

describe('L83E-U-T6 — état effectif des évaluations (81B, pur)', () => {
  it('PENDING sans exécution au-delà du délai, interruption non reprise, essai dû, tentatives épuisées, décision réclamée en boucle', () => {
    expect(t6Anomaly({ state: 'PENDING', stale: false, interrupted: false }, false)).toBeNull();
    expect(t6Anomaly({ state: 'PENDING', stale: true, interrupted: false }, false)).toBe('T6_PENDING_WITHOUT_EXECUTION');
    expect(t6Anomaly({ state: 'PENDING', stale: true, interrupted: true }, false)).toBe('T6_INTERRUPTED_NOT_RESUMED');
    expect(t6Anomaly({ state: 'RETRY_WAIT', stale: true, interrupted: false }, false)).toBe('T6_RETRY_OVERDUE');
    expect(t6Anomaly({ state: 'FAILED', stale: true, interrupted: false }, false)).toBe('T6_ATTEMPTS_EXHAUSTED');
    expect(t6Anomaly({ state: 'COMPLETED', stale: false, interrupted: false }, true)).toBeNull();
    expect(t6Anomaly({ state: 'COMPLETED', stale: true, interrupted: false }, false)).toBe('T6_DECISION_RECLAIMED');
    expect(t6Anomaly({ state: 'RUNNING', stale: false, interrupted: false }, true)).toBe('T6_PREGEN_EXHAUSTED');
  });
});

describe('L83E-U-BILLING — abonnement, droits, Duo (purs)', () => {
  it('écarts Stripe ↔ local : base du rapprochement annuel, plus périodicité mensuelle et prix', () => {
    expect(billingDesync([], { annual: false, priceIds: ['price_a'] }, { billing_period: 'monthly', stripe_price_id: 'price_a' })).toEqual([]);
    expect(billingDesync(['STATUS'], { annual: false, priceIds: ['price_a'] }, { billing_period: 'yearly', stripe_price_id: 'price_b' })).toEqual(['STATUS', 'BILLING_PERIOD', 'PRICE']);
    expect(billingDesync([], { annual: true, priceIds: [] }, null)).toEqual(['LOCAL_MISSING']);
  });

  it('état dénormalisé attendu = correspondance de la synchronisation ; écarts nommés', () => {
    expect(expectedAccountState({ planCode: 'premium', status: 'active', cancelAtPeriodEnd: false })).toEqual({ planType: 'PREMIUM', status: 'ACTIVE' });
    expect(expectedAccountState({ planCode: 'premium_duo', status: 'active', cancelAtPeriodEnd: true })).toEqual({ planType: 'PREMIUM_DUO', status: 'CANCELED' });
    expect(expectedAccountState({ planCode: 'premium', status: 'past_due', cancelAtPeriodEnd: false })).toEqual({ planType: 'PREMIUM', status: 'PAST_DUE' });
    expect(expectedAccountState({ planCode: 'premium', status: 'canceled', cancelAtPeriodEnd: false })).toEqual({ planType: 'STANDARD', status: 'EXPIRED' });
    expect(expectedAccountState({ planCode: 'premium', status: 'readonly', cancelAtPeriodEnd: false })).toEqual({ planType: null, status: 'WITHDRAWN' });
    expect(expectedAccountState({ planCode: 'standard', status: 'trialing', cancelAtPeriodEnd: false })).toBeNull();
    expect(entitlementDesync({ planType: 'PREMIUM', status: 'ACTIVE' }, { planType: 'STANDARD', status: 'EXPIRED', ownerPlanType: 'STANDARD' }))
      .toEqual(['ACCOUNT_STATUS_MISMATCH', 'ACCOUNT_PLAN_MISMATCH']);
    expect(entitlementDesync({ planType: null, status: 'WITHDRAWN' }, { planType: 'PREMIUM', status: 'WITHDRAWN', ownerPlanType: 'PREMIUM' })).toEqual([]);
    expect(entitlementDesync({ planType: 'PREMIUM', status: 'ACTIVE' }, { planType: 'PREMIUM', status: 'ACTIVE', ownerPlanType: 'STANDARD' })).toEqual(['OWNER_PLAN_MISMATCH']);
  });

  it('Duo : quota d’utilisateurs, Duo actif sans offre Duo, plus de deux membres, invité d’un Duo terminé', () => {
    const base = { activeMembers: 1, maxUsers: 1, duoStatus: null, duoPlanInForce: false, activeDuoMembers: 0, endedDuoActiveGuests: 0 };
    expect(duoFindings(base)).toEqual([]);
    expect(duoFindings({ ...base, activeMembers: 2 })).toEqual(['USERS_OVER_QUOTA']);
    expect(duoFindings({ ...base, duoStatus: 'ACTIVE' })).toEqual(['DUO_ACTIVE_WITHOUT_DUO_PLAN']);
    expect(duoFindings({ ...base, duoStatus: 'ACTIVE', duoPlanInForce: true, activeDuoMembers: 3, maxUsers: 2 })).toEqual(['DUO_MEMBERS_OVER_LIMIT']);
    expect(duoFindings({ ...base, duoStatus: 'CANCELED', endedDuoActiveGuests: 1 })).toEqual(['DUO_GUEST_IN_ENDED_DUO']);
  });
});

describe('L83E-U-C-Q10 — comptes non éligibles : lecture de l’état d’abonnement SEULE', () => {
  it('seuls les contrôles d’abonnement s’y exécutent ; motifs d’abonnement seulement (jamais suspendu, neutralisé, introuvable)', () => {
    const lecture = COHERENCE_REGISTRY.filter((c) => c.ineligibleAccounts === 'SUBSCRIPTION_STATE_READ').map((c) => c.id).sort();
    expect(lecture).toEqual(['COH-BILLING-STRIPE', 'COH-DUO-RELATIONS', 'COH-ENTITLEMENTS', 'COH-SUBSCRIPTION-COMMUNICATIONS']);
    for (const c of activeChecks()) {
      expect(checkRunsInScope(c, 'ELIGIBLE'), c.id).toBe(true);
      expect(checkRunsInScope(c, 'SUBSCRIPTION_STATE_READ'), c.id).toBe(lecture.includes(c.id));
    }
    expect([...SUBSCRIPTION_STATE_REASONS].sort()).toEqual(['NO_SUBSCRIPTION', 'READ_ONLY', 'SUBSCRIPTION_ENDED', 'TRIAL_EXPIRED', 'UNPAID', 'WITHDRAWN']);
    for (const r of ['ACCOUNT_SUSPENDED', 'ACCOUNT_ARCHIVED', 'ACCOUNT_NOT_FOUND', 'ELIGIBILITY_UNREADABLE']) expect(SUBSCRIPTION_STATE_REASONS.has(r), r).toBe(false);
    // Le moteur neutralise toute réparation hors périmètre ÉLIGIBLE, sauf propriété DÉCLARATIVE du contrôle
    // (lot 84A, L83-Q1 : `repairOnIneligibleBilling`) — aucun identifiant de contrôle codé en dur.
    const moteur = sansCommentaires(lire('src/services/coherence/engine.ts'));
    expect(moteur).toMatch(/repairPermittedInScope\(check, ctx\.accountScope \?\? 'ELIGIBLE'\)/);
    expect(moteur).not.toMatch(/COH-BILLING|COH-ENTITLEMENTS/);
  });
});
