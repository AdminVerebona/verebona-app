/**
 * Lot 113B (#690) — bloc TCO verrouillé (Standard) + CTA « Découvrir les
 * offres Premium » — droits de bout en bout sur PostgreSQL 16 réel.
 *
 * Chemins de PRODUCTION : droits réels (`getEntitlements`), persistance T1 et
 * consolidation T3 réelles, service TCO réel, route HTTP réelle de la fiche
 * (`GET /api/assets/[id]/tco`) qui pilote l'affichage du bloc verrouillé
 * (`TcoSection` : bloc seulement sur `PREMIUM_REQUIRED`). Seule la session est
 * simulée. Aucun appel IA.
 *
 *   L113B-E2E-01  Standard : 403 PREMIUM_REQUIRED, AUCUNE donnée ni calcul TCO dans la réponse (bloc verrouillé + CTA)
 *   L113B-E2E-02  Premium, Premium Duo (titulaire et membre), essai actif : TCO complet, inchangé (aucun bloc promotionnel)
 *   L113B-E2E-03  lecture seule (essai échu) : même verrou que Standard, aucune donnée
 *   L113B-E2E-04  passage Standard → Premium : TCO rendu sans rien avoir perdu (verrou de lecture seulement)
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 }));
const TODAY = '2026-11-06';
type Json = Record<string, any>;
type Offre = 'standard' | 'premium' | 'premium_duo' | 'trial' | 'readonly';

/** Toute trace d'un calcul ou d'une donnée TCO dans une réponse refusée. */
const FUITE = /tco|summary|cumulative|indicators|lines|annual|usage|acquisition|financing|Cents|30000|7490|37490/i;

scenario('L113B', 'TCO Standard — bloc verrouillé et CTA vers Offres (droits inchangés)', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  let NextRequest: typeof import('next/server').NextRequest;
  beforeAll(async () => {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }) as never);
    ({ NextRequest } = await import('next/server'));
  });

  const fiche = async (compte: AccountRow, assetId: number, userId = compte.ownerUserId) => {
    session.currentAccountId = compte.id; session.userId = userId;
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/tco`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: (await res.json()) as Json };
  };

  /** Vélo 300 € + réparation 74,90 € consolidée (T1 + T3 réels). */
  const preparer = async (offre: Offre): Promise<{ compte: AccountRow; bien: AssetRow }> => {
    const compte = await make.account({ plan: offre === 'trial' || offre === 'readonly' ? null : offre });
    if (offre === 'trial') {
      await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_ends_at) VALUES (${compte.id}, 'premium', 'trialing', now() + interval '5 days')`;
    } else if (offre === 'readonly') {
      await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_ends_at) VALUES (${compte.id}, 'premium', 'trialing', now() - interval '1 day')`;
    }
    const bien = await make.asset(compte, { category: 'OBJET', name: 'Vélo', purchasePriceCents: 30_000, keyCharacteristics: { acquisitionDate: '2024-03-01' } });
    await k.document(compte, bien.id, [cand({
      summary: 'Réparation vélo', provider: 'Atelier', targetHints: [cible(bien.id)], businessReferences: [ref('INVOICE', `L113B-${compte.id}`)],
      temporalHints: { realizedDate: '2026-04-02' }, financialHints: [fh('REALIZED_COST', 7_490)],
    })], { type: 'REPAIR_INVOICE', title: 'Facture réparation', amountCents: 7_490, date: '2026-04-02' });
    await k.passer(compte, { today: TODAY });
    return { compte, bien };
  };

  const verrouille = (r: { status: number; body: Json }, offre: string) => {
    expect(r.status, offre).toBe(403);
    expect(r.body, offre).toEqual({ error: 'PREMIUM_REQUIRED', code: 'PREMIUM_REQUIRED', message: expect.any(String), locked: true });
    // Le message serveur n'est pas affiché par la fiche (bloc 113B) ; il ne porte aucun montant.
    expect(r.body.message, offre).not.toMatch(/\d/);
    const { message: _m, ...reste } = r.body;
    expect(JSON.stringify(reste), offre).not.toMatch(FUITE);
  };

  it('L113B-E2E-01 — Standard : 403 PREMIUM_REQUIRED, aucune donnée ni calcul TCO', async () => {
    const { compte, bien } = await preparer('standard');
    verrouille(await fiche(compte, bien.id), 'standard');
    // Pages / années demandées explicitement : toujours rien.
    session.currentAccountId = compte.id; session.userId = compte.ownerUserId;
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${bien.id}/tco?linesYear=2026&linesLimit=1000`), { params: Promise.resolve({ id: String(bien.id) }) });
    verrouille({ status: res.status, body: await res.json() }, 'standard ?linesYear');
  });

  it('L113B-E2E-02 — Premium, Premium Duo (titulaire et membre), essai actif : TCO complet inchangé', async () => {
    for (const offre of ['premium', 'premium_duo', 'trial'] as const) {
      const { compte, bien } = await preparer(offre);
      const r = await fiche(compte, bien.id);
      expect(r.status, offre).toBe(200);
      expect(r.body.locked, offre).toBeUndefined();
      expect(r.body.tco.summary.cumulativeCostCents, offre).toBe(37_490);
      expect(r.body.canEdit, offre).toBe(true);
      if (offre === 'premium_duo') {
        const membre = await make.user();
        await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${compte.id}, ${membre.id}, 'member', 'active')`;
        const m = await fiche(compte, bien.id, membre.id);
        expect(m.status).toBe(200);
        expect(m.body.tco.summary.cumulativeCostCents).toBe(37_490);
      }
    }
  });

  it('L113B-E2E-03 — lecture seule (essai échu) : même verrou que Standard', async () => {
    const { compte, bien } = await preparer('readonly');
    verrouille(await fiche(compte, bien.id), 'readonly');
  });

  it('L113B-E2E-04 — Standard → Premium : TCO rendu, rien perdu', async () => {
    const { compte, bien } = await preparer('standard');
    verrouille(await fiche(compte, bien.id), 'standard');
    await sql`UPDATE account_subscriptions SET plan_code = 'premium' WHERE account_id = ${compte.id}`;
    const r = await fiche(compte, bien.id);
    expect(r.status).toBe(200);
    expect(r.body.tco.summary.cumulativeCostCents).toBe(37_490);
  });
});
