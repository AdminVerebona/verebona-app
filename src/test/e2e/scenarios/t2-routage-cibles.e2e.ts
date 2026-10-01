/**
 * Lot 15 (Y) — recherche, ciblage et routage de l'assistant, de bout en bout
 * sur PostgreSQL réel (`runAssistant` + ports réels), CDC 15 §9 :
 *
 *  · E2E-T2-10 : page document + « Quel est le montant ? » → CE document
 *    (lecture canonique), et non le compte entier ;
 *  · E2E-T2-11 : « Retrouve la facture Leroy » puis « Et son montant ? »
 *    dans le même fil → le document cité ;
 *  · E2E-T2-09 : bien courant (page) puis échéances → aucune échéance d'un
 *    autre bien (`agenda_asset_links`) ; legacy : les deux ;
 *  · E2E-T2-07 : « Quels documents ne sont rattachés à aucun bien ? » →
 *    filtre exact (lien N-N et colonnes vides) ;
 *  · T2-13 : « Retrouve un devis » → filtre de type, pas un bonus ;
 *  · T2-37 : « Indique-moi la date d'achat… » n'est jamais une commande.
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

vi.mock('@/services/verebona-assistant/events/business-events', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

scenario('T2-L15-ROUTAGE', 'Recherche, ciblage et routage de l’assistant', ({ sql, make }) => {
  const env = { ...process.env };
  let orch: typeof import('@/services/verebona-assistant/core/assistant-orchestrator.service');
  let ports: typeof import('@/services/verebona-assistant/core/ports');
  let ret: typeof import('@/services/verebona-assistant/core/retrieval.service');
  let router: typeof import('@/services/verebona-assistant/core/intent-router.service');
  beforeAll(async () => {
    (await import('@/services/verebona-assistant/registries')).registerAllRetrievalAdapters();
    orch = await import('@/services/verebona-assistant/core/assistant-orchestrator.service');
    ports = await import('@/services/verebona-assistant/core/ports');
    ret = await import('@/services/verebona-assistant/core/retrieval.service');
    router = await import('@/services/verebona-assistant/core/intent-router.service');
  });
  afterEach(() => {
    for (const k of ['ASSISTANT_CANONICAL_READ', 'VEREBONA_ASSISTANT_WRITE_COMMANDS']) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  });

  let n = 0;
  const ask = (compte: { id: number; owner: { id: number } }, message: string, extra: Record<string, unknown> = {}) =>
    orch.runAssistant({
      accountId: compte.id, userId: compte.owner.id, planType: 'PREMIUM', message,
      clientRequestId: `e2e-y-${++n}`, locale: 'fr-FR', ...extra,
    } as never, ports.buildOrchestratorPorts());

  const doc = async (compte: { id: number }, v: { assetId?: number | null; title: string; type?: string | null; amount?: number | null; date?: string; supplier?: string | null; state?: string | null }) => {
    const f = await make.assetFile(compte as never, { assetId: v.assetId ?? null });
    await sql`UPDATE asset_files SET retained_title = ${v.title}, document_type_code = ${v.type ?? null}, document_type = NULL,
              amount_cents = ${v.amount ?? null}, document_date = ${v.date ?? '2026-03-02'}, supplier = ${v.supplier ?? null},
              analysis_state = ${v.state ?? 'ANALYZED'} WHERE id = ${f.id}`;
    return f;
  };

  it('E2E-T2-10 (enabled) : page document + « Quel est le montant ? » → le document de la page', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { name: 'Maison' });
    const ticket = await doc(compte, { assetId: maison.id, title: 'Ticket Leroy Merlin', type: 'SUBSCRIPTION_INVOICE', amount: 4590, supplier: 'Leroy Merlin' });
    await doc(compte, { assetId: maison.id, title: 'Facture EDF', type: 'SUBSCRIPTION_INVOICE', amount: 12000 });

    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    const r = await ask(compte, 'Quel est le montant ?', { pageContext: { documentId: String(ticket.id) } });
    expect(r.answer).toMatch(/Ticket Leroy Merlin.*45,90/);
    expect(r.cascade?.strategy).toBe('target.document_amount');
    expect(r.sources.map((s) => s.id)).toEqual([`doc_${ticket.id}`]);

    // Cas limite : la question nomme un autre document → pas de lecture ciblée.
    const autre = await ask(compte, 'Quel est le montant de la facture EDF ?', { pageContext: { documentId: String(ticket.id) } });
    expect(autre.cascade?.strategy).not.toBe('target.document_amount');

    // Autre compte : aucune lecture du document.
    const intrus = await make.account();
    const x = await ask(intrus, 'Quel est le montant ?', { pageContext: { documentId: String(ticket.id) } });
    expect(x.answer).not.toContain('45,90');
  });

  it('E2E-T2-11 (enabled) : « Retrouve la facture Leroy » puis « Et son montant ? » dans le même fil', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { name: 'Maison' });
    const ticket = await doc(compte, { assetId: maison.id, title: 'Facture Leroy Merlin', type: 'SUBSCRIPTION_INVOICE', amount: 4590 });
    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    const r1 = await ask(compte, 'Retrouve la facture Leroy Merlin');
    expect(r1.sources.map((s) => s.id)).toContain(`doc_${ticket.id}`);
    expect(r1.conversationId).toBeTruthy();
    const r2 = await ask(compte, 'Et son montant ?', { conversationId: r1.conversationId });
    expect(r2.answer).toMatch(/Facture Leroy Merlin.*45,90/);
    expect(r2.cascade?.reference?.entity).toEqual({ type: 'document', id: ticket.id });
  });

  it('E2E-T2-09 (enabled ; legacy) : bien courant (page) puis échéances → aucune échéance d’un autre bien ; legacy : les deux', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { name: 'Clio', category: 'VEHICULE' });
    const polo = await make.asset(compte, { name: 'Polo', category: 'VEHICULE' });
    const ctClio = await make.agendaItem(compte, { title: 'Contrôle technique', startDate: '2027-02-01', assetIds: [clio.id] });
    const ctPolo = await make.agendaItem(compte, { title: 'Contrôle technique', startDate: '2027-03-01', assetIds: [polo.id] });
    const input = {
      accountId: compte.id, userId: compte.owner.id, planType: 'PREMIUM', message: 'Retrouve le contrôle technique',
      clientRequestId: 'r', pageContext: { assetId: String(clio.id) },
    } as never;
    const route = router.routeForIntent('ACCOUNT_SEARCH_AGENDA', 'PREMIUM', 'e2e');

    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    const on = await ret.retrieve(route, input);
    expect(on.map((s) => s.id)).toEqual([`agenda_${ctClio.id}`]);
    // Contrat de l'intention (T2-07) : que des échéances.
    expect(new Set(on.map((s) => s.type))).toEqual(new Set(['agenda_item']));

    const bout = await ask(compte, 'Retrouve le contrôle technique', { pageContext: { assetId: String(clio.id) } });
    expect(bout.sources.map((s) => s.id)).not.toContain(`agenda_${ctPolo.id}`);

    process.env.ASSISTANT_CANONICAL_READ = 'legacy';
    const off = await ret.retrieve(route, input);
    expect(off.map((s) => s.id)).toEqual(expect.arrayContaining([`agenda_${ctClio.id}`, `agenda_${ctPolo.id}`]));
  });

  it('E2E-T2-07 (enabled) : documents non rattachés — filtre exact (lien N-N et colonnes)', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { name: 'Maison' });
    const lie = await doc(compte, { assetId: maison.id, title: 'Facture chaudière' });
    const orphelin = await doc(compte, { assetId: null, title: 'Scan sans bien' });
    const nn = await doc(compte, { assetId: null, title: 'Attestation partagée' });
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, status)
              VALUES (${compte.id}, ${nn.id}, ${maison.id}, 'PRIMARY', 'USER', 'ACTIVE') ON CONFLICT DO NOTHING`;

    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    const r = await ask(compte, 'Quels documents ne sont rattachés à aucun bien ?');
    expect(r.route?.intent).toBe('ACCOUNT_SEARCH_DOCUMENT');
    expect(r.sources.map((s) => s.id)).toEqual([`doc_${orphelin.id}`]);
    expect(r.sources.map((s) => s.id)).not.toContain(`doc_${lie.id}`);
  });

  it('T2-13 : « Retrouve un devis » → documents de type devis seulement (pas la facture qui dit « devis »)', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { name: 'Maison' });
    const devis = await doc(compte, { assetId: maison.id, title: 'Proposition toiture', type: 'WORKS_QUOTE' });
    const facture = await doc(compte, { assetId: maison.id, title: 'Facture suite au devis toiture', type: 'WORKS_INVOICE' });
    const route = router.routeForIntent('ACCOUNT_SEARCH_DOCUMENT', 'PREMIUM', 'e2e');
    const input = { accountId: compte.id, userId: compte.owner.id, planType: 'PREMIUM', message: 'Retrouve un devis', clientRequestId: 'd' } as never;

    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    expect((await ret.retrieve(route, input)).map((s) => s.id)).toEqual([`doc_${devis.id}`]);
    process.env.ASSISTANT_CANONICAL_READ = 'legacy';
    expect((await ret.retrieve(route, input)).map((s) => s.id)).toContain(`doc_${facture.id}`);
  });

  it('T2-17 : « À traiter » du bien courant — bien, équipement, document et échéance de CE bien seulement', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { name: 'Clio', category: 'VEHICULE' });
    const polo = await make.asset(compte, { name: 'Polo', category: 'VEHICULE' });
    const docClio = await doc(compte, { assetId: clio.id, title: 'Facture Clio' });
    const ctClio = await make.agendaItem(compte, { title: 'CT Clio', startDate: '2027-02-01', assetIds: [clio.id] });
    const action = async (targetType: string, targetId: number, question: string) => {
      const [{ id }] = await sql<{ id: number }[]>`
        INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, priority, question)
        VALUES (${compte.id}, ${targetType}, ${targetId}, 'x', 'COMPLETE', 'E2E', 'DO_NEXT', ${question}) RETURNING id`;
      return Number(id);
    };
    const a1 = await action('ASSET', clio.id, 'Compléter la Clio');
    const a2 = await action('DOCUMENT', docClio.id, 'Vérifier la facture');
    const a3 = await action('AGENDA_ITEM', ctClio.id, 'Confirmer le CT');
    const b1 = await action('ASSET', polo.id, 'Compléter la Polo');
    const route = router.routeForIntent('ACCOUNT_TO_PROCESS', 'PREMIUM', 'e2e');
    const input = { accountId: compte.id, userId: compte.owner.id, planType: 'PREMIUM', message: 'Que dois-je traiter ?', clientRequestId: 't', pageContext: { assetId: String(clio.id) } } as never;

    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    expect((await ret.retrieve(route, input)).map((s) => s.id).sort()).toEqual([`todo_${a1}`, `todo_${a2}`, `todo_${a3}`].sort());
    process.env.ASSISTANT_CANONICAL_READ = 'legacy';
    expect((await ret.retrieve(route, input)).map((s) => s.id)).toContain(`todo_${b1}`);
  });

  it('E2E-T2-20 (enabled) + T2-37 : « Indique-moi la date d’achat de la Polo » est une lecture, jamais une commande', async () => {
    const compte = await make.account();
    await make.asset(compte, { name: 'Polo', category: 'VEHICULE', keyCharacteristics: { acquisitionDate: '2021-05-25', acquisitionDate__origin: 'USER' } });
    process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS = 'true';
    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    const r = await ask(compte, 'Indique-moi la date d’achat de la Polo');
    expect(r.commandPlan ?? null).toBeNull();
    expect(r.cascade?.intent).not.toBe('WRITE_COMMAND');
    expect(r.answer).toContain('25 mai 2021');
  });
});
