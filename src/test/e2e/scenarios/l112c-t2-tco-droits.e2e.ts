/**
 * Lot 112C (reprise) — DROITS du coût de possession (TCO) dans T2, de bout en
 * bout sur PostgreSQL réel (orchestrateur et ports réels, offre dérivée des
 * DROITS du compte comme POST /api/verebona/messages).
 *
 * Défaut démontré avant correction : un compte Standard qui posait librement
 * « Quel est le coût de possession de Cupra ? » recevait le TCO chiffré
 * (lecture `structured.ownership_cost` sans contrôle d'offre), alors que la
 * fiche (GET /api/assets/:id/tco) le refuse (403 PREMIUM_REQUIRED).
 *
 *   D01  Standard : réponse sans aucun montant, qui explique la réservation
 *        Premium (lecture TCO non exécutée : test unitaire l112c-t2-tco-droits) ;
 *        lot 113AE (#728) : Standard ACTIF a T2 complet — le TCO reste refusé ;
 *   D02  Premium, Premium Duo, essai actif : TCO chiffré (inchangé) ;
 *   D03  lecture seule (essai échu / impayé) : comme Standard ;
 *   D04  Q3 / Q4 (dépenses d'entretien d'un bien, dépenses de l'année) :
 *        ouvertes à tous, chiffrées en Standard comme en Premium.
 *
 * Modèle SIMULÉ (aucun réseau).
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander, useTargetState } from '../chain';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
const MONTANT = /\d[\d\s ]*,\d{2}\s?€|\d[\d\s ]* €/;

scenario('L112C-TCO', 'Lot 112C reprise — coût de possession réservé Premium / Duo / essai dans T2', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  const calls: string[] = [];
  let J = '';
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider({
      name: 'simule', isConfigured: () => true,
      async call(input: { task?: string }) {
        calls.push(String(input.task));
        if (input.task === 'UNDERSTAND') return { rawText: JSON.stringify({ mode: 'UNDERSTAND', confidence: 'low', intent: 'UNKNOWN', requestedTopics: [], filters: {}, entityHints: [], requestedFacts: [], reason: 's' }), inputTokens: 1, outputTokens: 1 };
        return { rawText: JSON.stringify({ mode: 'ANSWER', format: 'claims', status: 'answered', claims: [] }), inputTokens: 1, outputTokens: 1 };
      },
    } as never);
    J = (await import('@/services/verebona-assistant/core/query-period')).aujourdhuiParis();
  });

  /** Compte avec un véhicule « Cupra » : prix d'achat, deux factures d'entretien (dont une de l'année). */
  const preparer = async (offre: 'standard' | 'premium' | 'premium_duo' | 'trial' | 'readonly'): Promise<Compte> => {
    const a = await make.account({ plan: offre === 'trial' || offre === 'readonly' ? null : offre });
    if (offre === 'trial') {
      await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_ends_at) VALUES (${a.id}, 'premium', 'trialing', now() + interval '5 days')`;
    } else if (offre === 'readonly') {
      await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_ends_at) VALUES (${a.id}, 'premium', 'trialing', now() - interval '1 day')`;
    }
    const c = { id: a.id, ownerUserId: a.ownerUserId };
    const bien = await make.asset(a as never, { name: 'Cupra', category: 'VEHICULE', keyCharacteristics: { acquisitionPrice: 25000, acquisitionDate: '2023-01-15' } });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${bien.id}`;
    for (const [cents, date] of [[32000, J], [11000, '2024-03-01']] as const) {
      const f = await make.assetFile(a as never, { assetId: bien.id });
      await sql`UPDATE asset_files SET document_type_code = 'MAINTENANCE_INVOICE', amount_cents = ${cents}, supplier = 'Garage Martin',
                document_date = ${date}, retained_title = ${`Facture entretien ${date}`}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    }
    return c;
  };
  /** Question posée comme par POST /api/verebona/messages : offre dérivée des DROITS du compte. */
  const poser = async (c: Compte, message: string) => {
    const { getEntitlements } = await import('@/services/entitlements.service');
    const { assistantPlanFromEntitlements, assistantPlanLimit } = await import('@/services/verebona-assistant/core/plan-eligibility');
    const { assistantAiAccessFromEntitlements } = await import('@/services/verebona-assistant/core/ai-access');
    const ent = await getEntitlements(c.id);
    const planType = assistantPlanFromEntitlements(ent);
    const limite = assistantPlanLimit(ent);
    calls.length = 0;
    // Lot 113AE (#728) : comme la route — accès IA RÉEL (Standard actif : T2 complet, sans TCO).
    const r = await demander(c, message, {
      planType, planLimit: limite === 'NO_ACCESS' ? null : limite, aiAccess: assistantAiAccessFromEntitlements(ent),
      pageContext: { route: '/accueil', platform: 'web' },
    });
    return { r, answer: String(r.answer ?? ''), planType };
  };
  const QUESTIONS_TCO = ['Quel est le coût de possession de Cupra ?', 'Quel est le coût total de possession de Cupra ?', 'Quel est le TCO de Cupra ?'];

  it('L112C-TCO-D01 — Standard : aucune valeur, explication de la réservation Premium', async () => {
    const c = await preparer('standard');
    for (const q of QUESTIONS_TCO) {
      const { r, answer, planType } = await poser(c, q);
      expect(planType).toBe('STANDARD');
      expect(r.cascade?.strategy, q).toBe('structured.ownership_cost');
      expect(answer, q).toMatch(/Premium et Premium Duo/);
      expect(answer, q).not.toMatch(MONTANT);
      expect(answer, q).not.toMatch(/25 ?430|430|25 ?000/);
      expect(JSON.stringify(r.sources ?? []), q).not.toMatch(/cumulativeCostCents|25430|43000/);
      expect(calls, q).toEqual([]);
    }
  });

  it('L112C-TCO-D02 — Premium, Premium Duo, essai actif : coût de possession chiffré (inchangé)', async () => {
    for (const offre of ['premium', 'premium_duo', 'trial'] as const) {
      const c = await preparer(offre);
      const { r, answer } = await poser(c, QUESTIONS_TCO[0]);
      expect(r.cascade?.strategy, offre).toBe('structured.ownership_cost');
      expect(answer, offre).toMatch(/Coût de possession de Cupra : coût cumulé documenté 25[\s\u202f\u00a0]430,00/);
      expect(answer, offre).not.toMatch(/réservé|disponible avec Premium/);
    }
  });

  it('L112C-TCO-D03 — lecture seule (essai échu) : comme Standard, aucune valeur', async () => {
    const c = await preparer('readonly');
    const { answer, planType } = await poser(c, QUESTIONS_TCO[0]);
    expect(planType).toBe('STANDARD');
    expect(answer).toMatch(/Premium et Premium Duo/);
    expect(answer).not.toMatch(MONTANT);
  });

  it('L112C-TCO-D04 — dépenses d’entretien d’un bien et dépenses de l’année : ouvertes à tous (Standard chiffré)', async () => {
    for (const offre of ['standard', 'premium'] as const) {
      const c = await preparer(offre);
      const ent = await poser(c, 'Combien ai-je dépensé en entretien pour Cupra ?');
      expect(ent.r.cascade?.strategy, offre).toBe('structured.sum_qualified');
      expect(ent.answer, offre).toMatch(/430,00/);
      const an = await poser(c, `Combien ai-je dépensé en ${J.slice(0, 4)} ?`);
      expect(an.r.cascade?.strategy, offre).toBe('structured.sum_qualified');
      expect(an.answer, offre).toMatch(/320,00/);
    }
  });
});
