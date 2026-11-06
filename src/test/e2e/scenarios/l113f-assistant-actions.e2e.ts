/**
 * Lot 113F (#689) — actions de l'Assistant : une action par élément présenté,
 * ouverture contextuelle, aucune navigation redondante. De bout en bout sur
 * PostgreSQL réel (orchestrateur, ports, vérificateurs d'accès et persistance
 * réels). Aucun appel modèle (réponses déterministes).
 *
 *   A01  « Quelle est ma prochaine échéance ? » (trois échéances à venir) :
 *        un seul bouton « Voir cette échéance », vers le tiroir de la
 *        PREMIÈRE échéance ; même liste persistée ;
 *   A02  plusieurs échéances présentées : une action chacune, liens distincts,
 *        aucune navigation générale en plus ;
 *   A03  aucune échéance : aucune ouverture contextuelle inventée ;
 *   A04  « Ouvre mon agenda » : un seul bouton générique ;
 *   A05  isolation : jamais d'action vers l'échéance d'un autre compte ;
 *   A06  questions « Exploiter » des suggestions (112C) : même règle.
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander, useTargetState } from '../chain';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
type Action = { type: string; label: string; href: string | null };
const contextuelles = (l: Action[]) => l.filter((a) => ['OPEN_AGENDA_ITEM', 'OPEN_DOCUMENT', 'OPEN_ASSET', 'OPEN_SUPPLIER'].includes(a.type));
const navigation = (l: Action[]) => l.filter((a) => a.type.startsWith('OPEN_'));

scenario('L113F', 'Lot 113F — actions de l’Assistant sans redondance, ouverture contextuelle', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  const calls: string[] = [];
  let J = '';
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider({
      name: 'simule', isConfigured: () => true,
      async call(input: { task?: string }) {
        calls.push(String(input.task));
        return { rawText: JSON.stringify({ mode: 'UNDERSTAND', confidence: 'low', intent: 'UNKNOWN', requestedTopics: [], filters: {}, entityHints: [], requestedFacts: [], reason: 's' }), inputTokens: 1, outputTokens: 1 };
      },
    } as never);
    J = (await import('@/services/verebona-assistant/core/query-period')).aujourdhuiParis();
  });

  const jour = (decalage: number) => {
    const d = new Date(`${J}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + decalage);
    return d.toISOString().slice(0, 10);
  };

  /** Compte avec un bien et des échéances à venir (titre, décalage en jours). */
  const preparer = async (echeances: Array<[string, number]>) => {
    const a = await make.account({ plan: 'premium' });
    const c: Compte = { id: a.id, ownerUserId: a.ownerUserId };
    const bien = await make.asset(a as never, { name: 'Cupra', category: 'VEHICULE' });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${bien.id}`;
    const ids: number[] = [];
    for (const [titre, decalage] of echeances) {
      ids.push((await make.agendaItem(a as never, { title: titre, startDate: jour(decalage), assetIds: [bien.id] })).id);
    }
    return { c, ids };
  };
  const poser = (c: Compte, message: string) => demander(c, message, { pageContext: { route: '/accueil', platform: 'web' } });

  it('L113F-A01 — prochaine échéance : un seul « Voir cette échéance » vers son tiroir (et persisté tel quel)', async () => {
    const { c, ids } = await preparer([['Contrôle technique', 10], ['Vidange', 40], ['Assurance', 90]]);
    const r = await poser(c, 'Quelle est ma prochaine échéance ?');
    expect(String(r.answer)).toMatch(/Contrôle technique/);
    const nav = navigation(r.actions as Action[]);
    expect(nav.map((a) => [a.type, a.label, a.href])).toEqual([
      ['OPEN_AGENDA_ITEM', 'Voir cette échéance', `/agenda?tiroir=echeance%3A${ids[0]}`],
    ]);
    if (r.messageId && /^\d+$/.test(String(r.messageId))) {
      const lignes = await sql<{ action_type: string; resolved_href: string | null }[]>`
        SELECT action_type, resolved_href FROM verebona_message_actions WHERE message_id = ${Number(r.messageId)} ORDER BY id`;
      expect(lignes.filter((l) => l.action_type.startsWith('OPEN_')).map((l) => l.resolved_href)).toEqual([`/agenda?tiroir=echeance%3A${ids[0]}`]);
    }
    expect(calls).toEqual([]);
  });

  it('L113F-A02 — plusieurs échéances présentées : une action chacune, liens distincts, sans navigation générale', async () => {
    const { c, ids } = await preparer([['Contrôle technique', 5], ['Vidange', 12]]);
    const r = await poser(c, 'Quelles échéances arrivent bientôt ?');
    const nav = navigation(r.actions as Action[]);
    const hrefs = nav.map((a) => a.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(nav.some((a) => a.type === 'OPEN_AGENDA')).toBe(false);
    expect(contextuelles(nav).map((a) => a.href)).toEqual(ids.map((id) => `/agenda?tiroir=echeance%3A${id}`));
    expect(contextuelles(nav).map((a) => a.label)).toEqual(['Voir « Contrôle technique »', 'Voir « Vidange »']);
  });

  it('L113F-A03 — aucune échéance : aucune ouverture contextuelle inventée', async () => {
    const { c } = await preparer([]);
    const r = await poser(c, 'Quelle est ma prochaine échéance ?');
    expect(contextuelles(r.actions as Action[])).toEqual([]);
    const hrefs = navigation(r.actions as Action[]).map((a) => a.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('L113F-A04 — « Ouvre mon agenda » : un seul bouton « Ouvrir l’agenda »', async () => {
    const { c } = await preparer([['Contrôle technique', 10]]);
    const r = await poser(c, 'Ouvre mon agenda');
    expect(navigation(r.actions as Action[]).map((a) => [a.type, a.label, a.href])).toEqual([['OPEN_AGENDA', "Ouvrir l'agenda", '/agenda']]);
  });

  it('L113F-A05 — isolation : aucune action vers l’échéance d’un autre compte', async () => {
    const autre = await preparer([['Échéance de l’autre compte', 3]]);
    const moi = await preparer([['Vidange', 20]]);
    const r = await poser(moi.c, 'Quelle est ma prochaine échéance ?');
    const hrefs = (r.actions as Action[]).map((a) => a.href ?? '');
    expect(hrefs.some((h) => h.includes(`echeance%3A${autre.ids[0]}`))).toBe(false);
    expect(contextuelles(r.actions as Action[]).map((a) => a.href)).toEqual([`/agenda?tiroir=echeance%3A${moi.ids[0]}`]);
    // Vérificateur réel : l'échéance d'un autre compte est refusée même désignée explicitement.
    const { resolveActions } = await import('@/services/verebona-assistant/core/action-resolver.service');
    const { buildAccessChecker } = await import('@/services/verebona-assistant/core/ports');
    const forge = await resolveActions({
      accountId: moi.c.id, intent: 'ACCOUNT_SEARCH_AGENDA', access: buildAccessChecker(),
      actionIntents: [{ type: 'OPEN_AGENDA_ITEM', targetId: `agenda_${autre.ids[0]}` }],
    });
    expect(forge).toEqual([]);
  });

  it('L113F-A06 — questions « Exploiter » des suggestions (112C) : même règle, aucune destination en double', async () => {
    const { c } = await preparer([['Contrôle technique', 10]]);
    const annee = J.slice(0, 4);
    const avant = calls.length;
    for (const q of [`Combien ai-je dépensé en ${annee} ?`, 'Quelle est la date du dernier entretien de Cupra ?']) {
      const nav = navigation((await poser(c, q)).actions as Action[]);
      const hrefs = nav.map((a) => a.href);
      expect(new Set(hrefs).size, q).toBe(hrefs.length);
      // Navigation générale jamais en concurrence d'une ouverture contextuelle de sa rubrique.
      if (contextuelles(nav).some((a) => a.type === 'OPEN_AGENDA_ITEM')) expect(nav.some((a) => a.type === 'OPEN_AGENDA'), q).toBe(false);
      if (contextuelles(nav).some((a) => a.type === 'OPEN_DOCUMENT')) expect(nav.some((a) => a.type === 'OPEN_DOCUMENTS_PAGE'), q).toBe(false);
    }
    expect(calls.slice(avant)).toEqual([]);
  });
});
