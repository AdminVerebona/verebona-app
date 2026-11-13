/**
 * Lot 114A (Trello #753, CDC T2 P0 / D01 / D17 / D18 / D19) — COMPRÉHENSION
 * DE L'ASSISTANT, de bout en bout sur PostgreSQL réel (orchestrateur et ports
 * réels, offre dérivée des DROITS du compte comme POST /api/verebona/messages).
 *
 * Défaut démontré avant correction (P0) : avec deux vélos au compte,
 * « Combien ai-je dépensé pour mon vélo ? » recevait le TOTAL des deux.
 *
 *   E01  deux vélos, question au SINGULIER : question « lequel ? », aucun montant ;
 *   E02  deux vélos, « mes vélos » : l'ensemble demandé est totalisé ;
 *   E03  un seul vélo, Standard, « Combien m'a coûté mon vélo ? » : prix
 *        d'achat + coût de possession réservé, aucun autre montant ;
 *   E04  même question en Premium : prix d'achat ET coût de possession ;
 *   E05  sans fil choisi, une demande n'hérite jamais du dernier fil ; un fil
 *        choisi qui n'est pas à l'utilisateur est refusé.
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
const MONTANT = /\d[\d\s  ]*,\d{2}\s?€/;

scenario('L114A-T2', 'Lot 114A — cardinalité, coût selon l’offre, nouvelle demande par défaut', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider({
      name: 'simule', isConfigured: () => true,
      async call(input: { task?: string }) {
        if (input.task === 'UNDERSTAND') return { rawText: JSON.stringify({ mode: 'UNDERSTAND', confidence: 'ambiguous', intent: 'UNKNOWN', requestedTopics: [], filters: {}, entityHints: [], requestedFacts: [], reason: 's' }), inputTokens: 1, outputTokens: 1 };
        return { rawText: JSON.stringify({ mode: 'ANSWER', format: 'claims', status: 'answered', claims: [] }), inputTokens: 1, outputTokens: 1 };
      },
    } as never);
  });

  /** Compte avec un ou deux vélos, chacun avec un prix d'achat et une facture d'entretien. */
  const preparer = async (offre: 'standard' | 'premium', noms: string[]): Promise<Compte> => {
    const a = await make.account({ plan: offre });
    for (const [i, name] of noms.entries()) {
      const bien = await make.asset(a as never, { name, category: 'VEHICULE', keyCharacteristics: { acquisitionPrice: 2023 + i * 1000, acquisitionDate: '2024-03-02' } });
      await sql`UPDATE assets SET status = 'EN_SERVICE', subtype = 'Vélo' WHERE id = ${bien.id}`;
      const f = await make.assetFile(a as never, { assetId: bien.id });
      await sql`UPDATE asset_files SET document_type_code = 'MAINTENANCE_INVOICE', amount_cents = ${12000 + i * 5000}, supplier = 'Atelier Cycles',
                document_date = '2025-04-10', retained_title = ${`Facture entretien ${name}`}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    }
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const poser = async (c: Compte, message: string) => {
    const { getEntitlements } = await import('@/services/entitlements.service');
    const { assistantPlanFromEntitlements, assistantPlanLimit } = await import('@/services/verebona-assistant/core/plan-eligibility');
    const { assistantAiAccessFromEntitlements } = await import('@/services/verebona-assistant/core/ai-access');
    const ent = await getEntitlements(c.id);
    const limite = assistantPlanLimit(ent);
    // Comme la route : la demande s'inscrit dans un fil (une clarification s'y enregistre).
    const { resolveConversation } = await import('@/services/verebona-assistant/core/conversation.service');
    const conversationId = await resolveConversation(c.id, c.ownerUserId, 'fr-FR', null);
    const r = await demander(c, message, {
      conversationId,
      planType: assistantPlanFromEntitlements(ent), planLimit: limite === 'NO_ACCESS' ? null : limite, aiAccess: assistantAiAccessFromEntitlements(ent),
      pageContext: { route: '/accueil', platform: 'web' },
    });
    return { r, answer: String(r.answer ?? '') };
  };

  it('L114A-T2-E01 — deux vélos, « mon vélo » : question de choix, aucun total', async () => {
    const c = await preparer('standard', ['Vélo cargo', 'Vélo de route']);
    for (const q of ['Combien ai-je dépensé pour mon vélo ?', 'Combien m’a coûté mon vélo ?']) {
      const { r, answer } = await poser(c, q);
      expect(r.clarification, q).toBeTruthy();
      const choix = JSON.stringify(r.clarification);
      expect(choix, q).toMatch(/Vélo cargo/);
      expect(choix, q).toMatch(/Vélo de route/);
      expect(answer, q).not.toMatch(MONTANT);
      // 120 € + 170 € : le total des deux vélos n'apparaît nulle part.
      expect(`${answer} ${JSON.stringify(r.sources ?? [])}`, q).not.toMatch(/290[,.]00|29000/);
    }
  });

  it('L114A-T2-E02 — deux vélos, « mes vélos » : l’ensemble demandé est totalisé', async () => {
    const c = await preparer('standard', ['Vélo cargo', 'Vélo de route']);
    const { r, answer } = await poser(c, 'Combien ai-je dépensé en entretien pour mes vélos ?');
    expect(r.clarification ?? null).toBeNull();
    expect(r.cascade?.strategy).toBe('structured.sum_qualified');
    expect(answer).toMatch(/290,00/);
  });

  it('L114A-T2-E03 — un vélo, Standard : prix d’achat, coût de possession réservé, rien d’autre', async () => {
    const c = await preparer('standard', ['Vélo cargo']);
    const { r, answer } = await poser(c, 'Combien m’a coûté mon vélo ?');
    expect(r.clarification ?? null).toBeNull();
    expect(r.cascade?.strategy).toBe('structured.acquisition_price');
    expect(answer).toMatch(/Prix d’achat de Vélo cargo : 2\s?023/);
    expect(answer).toMatch(/Premium et Premium Duo/);
    // Ni la facture d'entretien, ni un coût de possession reconstitué.
    expect(answer).not.toMatch(/120,00|2[\s  ]?143,00/);
    expect(JSON.stringify(r.sources ?? [])).not.toMatch(/cumulativeCostCents/);
  });

  it('L114A-T2-E04 — un vélo, Premium : prix d’achat ET coût de possession, à part', async () => {
    const c = await preparer('premium', ['Vélo cargo']);
    const { r, answer } = await poser(c, 'Combien m’a coûté mon vélo ?');
    expect(r.cascade?.strategy).toBe('structured.ownership_cost');
    expect(answer).toMatch(/Prix d’achat de Vélo cargo : 2\s?023/);
    expect(answer).toMatch(/Coût de possession de Vélo cargo/);
    expect(answer).not.toMatch(/Premium et Premium Duo/);
  });

  it('L114A-T2-E05 — sans fil choisi : nouvelle demande ; fil d’un autre : refus', async () => {
    const { resolveConversation, createConversation, ConversationNotFoundError } = await import('@/services/verebona-assistant/core/conversation.service');
    const a = await make.account({ plan: 'standard' });
    const b = await make.account({ plan: 'standard' });
    // Un ancien fil qui a déjà servi.
    const ancien = await createConversation(a.id, a.ownerUserId, 'fr-FR');
    await sql`UPDATE verebona_conversations SET last_message_at = now() WHERE id = ${ancien}`;
    const neuf = await resolveConversation(a.id, a.ownerUserId, 'fr-FR', null);
    expect(neuf).not.toBe(ancien);
    // Tant qu'il est vide, ce fil est réutilisé : pas de fils vides en série.
    expect(await resolveConversation(a.id, a.ownerUserId, 'fr-FR', undefined)).toBe(neuf);
    // L'ancien fil reste intact et sélectionnable explicitement.
    expect(await resolveConversation(a.id, a.ownerUserId, 'fr-FR', ancien)).toBe(ancien);
    // Cloisonnement : le fil d'un autre compte est refusé, jamais remplacé.
    await expect(resolveConversation(b.id, b.ownerUserId, 'fr-FR', ancien)).rejects.toBeInstanceOf(ConversationNotFoundError);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM verebona_conversations WHERE account_id = ${a.id}` as unknown as Array<{ n: number }>;
    expect(n).toBe(2);
  });
});
