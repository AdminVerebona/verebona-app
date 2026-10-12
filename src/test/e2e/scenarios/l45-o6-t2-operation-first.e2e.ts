/**
 * Lot 45 — O6 : T2 (assistant) « Opération d'abord », non exclusive
 * (CDC Opérations V1 ch. 16, 1.3, P12, P13, P16, B15, C10, C12, C15, C15.1,
 * C15.2, C21.1, C22 ; recette F-126 à F-137) — base PostgreSQL réelle.
 *
 * Opérations écrites par l'API d'écriture de production
 * (`withBusinessOperationWrite`) ; questions posées à la cascade T2 réelle
 * (`answerFromData` + `accountDataRepository`), et de bout en bout
 * (`runAssistant`, offre Standard : règles déterministes du serveur, sans
 * modèle). Aucun appel IA.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander } from '../chain';
import type { AccountRow, Factories } from '../factories';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));

const svc = () => import('@/services/business-operations/write');
const bus = () => import('@/services/business-operations/events');
type Repo = import('@/services/business-operations/repository').BusinessOperationRepository;

scenario('L45-O6', 'T2 Opération d’abord : coûts consolidés, mode mixte, payé/coûté, historique, sinistre, cache', ({ sql, make }) => {
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });

  const ask = async (accountId: number, message: string) => {
    const [{ answerFromData }, { accountDataRepository }, { DEFAULT_THRESHOLDS }] = await Promise.all([
      import('@/services/verebona-assistant/core/data-answer.service'),
      import('@/services/verebona-assistant/core/account-data.repository'),
      import('@/services/verebona-assistant/core/sufficiency'),
    ]);
    return answerFromData({ port: accountDataRepository, accountId, message, thresholds: DEFAULT_THRESHOLDS });
  };
  const can = () => import('@/services/verebona-assistant/canonical');

  /** Document analysé, rattaché à un bien (colonne historique). */
  async function doc(m: Factories, c: AccountRow, assetId: number | null, v: { title: string; type: string | null; cents: number | null; date?: string | null }) {
    const f = await m.assetFile(c, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${v.title}, document_type_code = ${v.type}, amount_cents = ${v.cents},
              document_date = ${v.date === undefined ? '2026-03-02' : v.date}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    return f.id;
  }
  const ecrire = async <T>(c: AccountRow, fn: (r: Repo) => Promise<T>) => (await svc()).withBusinessOperationWrite(c.id, fn);

  /** Intervention consolidée : sources documentaires, composantes. */
  async function intervention(c: AccountRow, assetIds: number[], v: {
    docs: Array<{ fileId: number; role: string }>;
    comps: Array<{ kind: string; cents: number; currency?: string; eur?: number | null; target?: number | null; date?: string | null }>;
    label?: string; type?: string | null; status?: string; realized?: string | null; parent?: number | null;
  }) {
    return ecrire(c, async (r) => {
      const [premier, ...autres] = v.docs;
      const { id, sourceId } = await r.create({
        type: v.type === null ? null : { code: v.type ?? 'INTERVENTION' }, status: v.status ?? 'REALIZED', technicalLabel: v.label ?? 'Remplacement embrayage',
        provider: 'Garage Martin', realizedDate: v.realized === undefined ? '2026-03-02' : v.realized, parentOperationId: v.parent ?? null,
        source: { kind: 'DOCUMENT', entityKey: premier.fileId, role: premier.role, authority: 'DOCUMENT', confidence: 'certain' },
        assets: assetIds.map((a, i) => ({ assetId: a, role: i === 0 ? 'PRIMARY' : 'CONCERNED', authority: 'DOCUMENT' })),
        reasonCode: 'E2E',
      } as never);
      const sources = [sourceId];
      for (const d of autres) sources.push(await r.addSource(id, { kind: 'DOCUMENT', entityKey: d.fileId, role: d.role, authority: 'DOCUMENT', confidence: 'certain' } as never));
      for (const k of v.comps) {
        await r.addFinancialComponent(id, {
          kind: k.kind, amountMinor: k.cents, currency: k.currency ?? 'EUR', amountEurCents: k.eur ?? null, economicDate: k.date ?? null,
          targetAssetId: k.target ?? null, sources: [{ sourceId: sources[0] }],
        } as never);
      }
      return id;
    });
  }

  async function polo(m: Factories) {
    const compte = await m.account({ plan: 'premium' });
    const bien = await m.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    return { compte, bien };
  }

  it('F-127 / F-129 / F-135 / O6-E01 — devis + acompte + solde + avoir + preuve de paiement + vieille facture : aucun double comptage', async () => {
    const { compte, bien } = await polo(make);
    const devis = await doc(make, compte, bien.id, { title: 'Devis embrayage', type: 'REPAIR_QUOTE', cents: 120000, date: '2026-01-10' });
    const acompte = await doc(make, compte, bien.id, { title: 'Facture d’acompte', type: 'REPAIR_INVOICE', cents: 30000, date: '2026-02-01' });
    const solde = await doc(make, compte, bien.id, { title: 'Facture de solde embrayage', type: 'REPAIR_INVOICE', cents: 90000 });
    const avoir = await doc(make, compte, bien.id, { title: 'Avoir n°12', type: 'REPAIR_INVOICE', cents: 10000, date: '2026-03-10' });
    const virement = await doc(make, compte, bien.id, { title: 'Virement Garage Martin', type: 'WORKS_PAYMENT_PROOF', cents: 110000, date: '2026-03-12' });
    await intervention(compte, [bien.id], {
      docs: [{ fileId: solde, role: 'INVOICE' }, { fileId: devis, role: 'QUOTE' }, { fileId: acompte, role: 'DEPOSIT_INVOICE' }, { fileId: avoir, role: 'CREDIT_NOTE' }, { fileId: virement, role: 'PAYMENT_PROOF' }],
      comps: [{ kind: 'FORECAST_COST', cents: 120000 }, { kind: 'REALIZED_COST', cents: 30000 }, { kind: 'REALIZED_COST', cents: 90000 }, { kind: 'REDUCTION', cents: 10000 }],
    });
    const revision = await doc(make, compte, bien.id, { title: 'Facture révision', type: 'MAINTENANCE_INVOICE', cents: 18000, date: '2026-05-02' });
    await intervention(compte, [bien.id], { docs: [{ fileId: revision, role: 'INVOICE' }], comps: [{ kind: 'REALIZED_COST', cents: 18000 }], label: 'Révision' });
    // Vieille facture hors Opération (pas de backfill, P19) : comptée en repli.
    const vieille = await doc(make, compte, bien.id, { title: 'Révision 2019', type: 'MAINTENANCE_INVOICE', cents: 15000, date: '2019-04-01' });

    const q = await (await can()).sumQualifiedExpenses(compte.id, { assetIds: [bien.id] });
    expect(q.qualifiedSumCents).toBe(110000 + 18000 + 15000);
    expect(q.complete).toBe(true);
    expect(q.operations).toMatchObject({ count: 2, sumCents: 128000, forecast: { count: 0 } });
    expect(q.documents).toMatchObject({ count: 1, sumCents: 15000, represented: { count: 6 } });
    expect(q.byTheme.find((t) => t.theme === 'maintenance')).toMatchObject({ sumCents: 33000, operationCount: 1, documentCount: 1, fileIds: [vieille] });

    const r = await ask(compte.id, 'Combien ai-je dépensé pour la Polo ?');
    expect(r.strategy).toBe('structured.sum_qualified');
    expect(r.answer).toMatch(/Total des dépenses qualifiées : 1\s430,00\s€/);
    expect(r.answer).toMatch(/Dont 1\s280,00\s€ consolidés \(2 interventions\) et 150,00\s€ lus sur 1 document/);
    expect(r.answer).toContain('6 documents déjà pris en compte');
    expect(r.answer).not.toMatch(/op[ée]ration/i);
    // Sources : total vérifiable + factures des interventions (ouvrables), jamais une « Opération ».
    const ids = r.sources.map((s) => s.id);
    expect(ids[0]).toBe(`expenses:all:${bien.id}`);
    expect(ids).toEqual(expect.arrayContaining([`doc_${solde}`, `doc_${revision}`]));
    expect(ids.some((i) => /operation/i.test(i))).toBe(false);

    const ent = await ask(compte.id, 'Combien ai-je dépensé en entretien pour la Polo ?');
    expect(ent.answer).toMatch(/Dépenses de entretien documentées pour Polo : 330,00\s€ \(1 intervention et 1 document\)/);
  });

  it('C10 / F-115 / F-114 / O6-E02 — facture multi-biens : jamais comptée entière pour chaque bien ; composante ciblée attribuée à son bien', async () => {
    const { compte, bien } = await polo(make);
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const f = await doc(make, compte, bien.id, { title: 'Facture pneus deux véhicules', type: 'REPAIR_INVOICE', cents: 60000 });
    // Lien N-N vers la Clio (le lien vers la Polo suit la colonne historique).
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, status)
              VALUES (${compte.id}, ${f}, ${clio.id}, 'SECONDARY', 'AI', 'ACTIVE') ON CONFLICT DO NOTHING`;
    const c = await can();
    const seul = await c.sumQualifiedExpenses(compte.id, { assetIds: [bien.id] });
    expect(seul.qualifiedSumCents).toBe(0);
    expect(seul.documents?.unattributed).toMatchObject({ count: 1, sumCents: 60000 });
    expect(seul.complete).toBe(false);
    expect((await c.sumQualifiedExpenses(compte.id, { assetIds: [bien.id, clio.id] })).qualifiedSumCents).toBe(60000);
    expect((await c.sumQualifiedExpenses(compte.id, {})).qualifiedSumCents).toBe(60000);
    const r = await ask(compte.id, 'Combien ai-je dépensé pour la Polo ?');
    expect(r.answer).toMatch(/1 dépense commune à plusieurs biens \(600,00\s€\) n’est pas répartie : non comptée pour Polo/);

    // Consolidée ensuite, ventilée par bien : chaque bien reçoit SA part.
    await intervention(compte, [bien.id, clio.id], {
      docs: [{ fileId: f, role: 'INVOICE' }],
      comps: [{ kind: 'REALIZED_COST', cents: 35000, target: bien.id }, { kind: 'REALIZED_COST', cents: 25000, target: clio.id }],
    });
    const apres = await c.sumQualifiedExpenses(compte.id, { assetIds: [bien.id] });
    expect(apres).toMatchObject({ qualifiedSumCents: 35000, complete: true });
    expect((await c.sumQualifiedExpenses(compte.id, { assetIds: [clio.id] })).qualifiedSumCents).toBe(25000);
    expect((await c.sumQualifiedExpenses(compte.id, {})).qualifiedSumCents).toBe(60000);
  });

  it('16.2 / F-128 / O6-E03 — repli sans Opération : documents comptés comme avant (dont document non consolidé)', async () => {
    const { compte, bien } = await polo(make);
    await doc(make, compte, bien.id, { title: 'Révision', type: 'MAINTENANCE_INVOICE', cents: 20000 });
    await doc(make, compte, bien.id, { title: 'Révision bis', type: 'MAINTENANCE_INVOICE', cents: 25000 });
    await doc(make, compte, bien.id, { title: 'Devis', type: 'REPAIR_QUOTE', cents: 90000 });
    const r = await ask(compte.id, 'Combien ai-je dépensé en entretien pour la Polo ?');
    expect(r.strategy).toBe('structured.sum_qualified');
    expect(r.answer).toMatch(/450,00\s€ \(2 documents\)\.?/);
    expect(r.answer).toContain('Les devis et documents sans valeur de dépense (1) ne sont pas comptés.');
    expect(r.answer).not.toMatch(/consolidé|intervention/);
    // Historique sans Opération : la branche « Opération » s'efface (lectures existantes).
    const h = await ask(compte.id, 'Qu’est-ce qui a été fait sur la Polo ?');
    expect(h.strategy).not.toBe('structured.operation_history');
  });

  it('C12.3 / O6-E04 — devise étrangère sans contre-valeur : présentée à part, non additionnée', async () => {
    const { compte, bien } = await polo(make);
    const f = await doc(make, compte, bien.id, { title: 'Rechnung Garage Zürich', type: 'REPAIR_INVOICE', cents: 30000 });
    await intervention(compte, [bien.id], { docs: [{ fileId: f, role: 'INVOICE' }], comps: [{ kind: 'REALIZED_COST', cents: 30000, currency: 'CHF' }] });
    const r = await ask(compte.id, 'Combien ai-je dépensé pour la Polo ?');
    expect(r.answer).toMatch(/300,00\sCHF/);
    expect(r.answer).toContain('non converti');
    expect(r.answer).not.toMatch(/300,00\s€/);
  });

  it('F-132 / F-133 / O6-E05 — « payé » vs « coûté » : sans preuve, pas de règlement affirmé ; avec preuve, règlement justifié', async () => {
    const { compte, bien } = await polo(make);
    const f = await doc(make, compte, bien.id, { title: 'Facture révision', type: 'MAINTENANCE_INVOICE', cents: 125000 });
    const opId = await intervention(compte, [bien.id], { docs: [{ fileId: f, role: 'INVOICE' }], comps: [{ kind: 'REALIZED_COST', cents: 125000 }], label: 'Révision 60 000 km' });

    const paye = await ask(compte.id, 'Combien ai-je payé pour l’entretien de la Polo ?');
    expect(paye.strategy).toBe('structured.payments');
    expect(paye.answer).toContain('aucune preuve de paiement');
    expect(paye.answer).toMatch(/coût documenté pour Polo \(entretien\) est de 1\s250,00\s€ : ce montant ne prouve pas/);

    const coute = await ask(compte.id, 'Combien m’a coûté la Polo ?');
    expect(coute.strategy).toBe('structured.sum_qualified');
    expect(coute.answer).toMatch(/1\s250,00\s€/);

    const preuve = await doc(make, compte, bien.id, { title: 'Relevé virement', type: 'WORKS_PAYMENT_PROOF', cents: 125000, date: '2026-03-05' });
    await ecrire(compte, (r) => r.addSource(opId, { kind: 'DOCUMENT', entityKey: preuve, role: 'PAYMENT_PROOF', authority: 'DOCUMENT', confidence: 'certain' } as never));
    const regle = await ask(compte.id, 'Combien ai-je payé pour l’entretien de la Polo ?');
    expect(regle.answer).toMatch(/Règlements justifiés pour Polo \(entretien\) : 1\s250,00\s€ \(1 preuve de paiement : « Relevé virement »\)/);
    expect(regle.sources[0].id).toBe(`doc_${preuve}`);
    // La preuve de paiement n'ajoute aucun coût (P16).
    expect((await (await can()).sumQualifiedExpenses(compte.id, { assetIds: [bien.id] })).qualifiedSumCents).toBe(125000);
  });

  it('F-134 / O6-E06 — historique d’un bien : interventions consolidées + documents non représentés, sans doublon', async () => {
    const { compte, bien } = await polo(make);
    const f = await doc(make, compte, bien.id, { title: 'Facture embrayage', type: 'REPAIR_INVOICE', cents: 125000 });
    await intervention(compte, [bien.id], { docs: [{ fileId: f, role: 'INVOICE' }], comps: [{ kind: 'REALIZED_COST', cents: 125000 }] });
    const vieille = await doc(make, compte, bien.id, { title: 'Révision 2021', type: 'MAINTENANCE_INVOICE', cents: 18000, date: '2021-05-01' });
    const r = await ask(compte.id, 'Qu’est-ce qui a été fait sur la Polo ?');
    expect(r.strategy).toBe('structured.operation_history');
    expect(r.answer).toMatch(/2 mars 2026 : intervention « Remplacement embrayage » \(Garage Martin\) — 1\s250,00\s€/);
    expect(r.answer).toMatch(/1 mai 2021 : document « Révision 2021 »/);
    expect(r.answer).not.toContain('Facture embrayage');
    expect(r.sources.map((s) => s.id)).toEqual([`doc_${f}`, `doc_${vieille}`]);
    // Filtre de thème : « quelles réparations ».
    const rep = await ask(compte.id, 'Quelles réparations sur la Polo ?');
    expect(rep.answer).toContain('Remplacement embrayage');
    expect(rep.answer).not.toContain('Révision 2021');
    // Chronologie (planificateur) : l'intervention remplace son document.
    const { defaultDeps } = await import('@/services/verebona-assistant/core/synthesis-planner');
    const ev = await defaultDeps.timelineRows(compte.id, [bien.id], 50);
    expect(ev.find((e) => e.kind === 'operation')).toMatchObject({ ref: `doc_${f}`, date: '2026-03-02' });
    expect(ev.some((e) => e.ref === `doc_${f}` && e.kind === 'document')).toBe(false);
    expect(ev.some((e) => e.ref === `doc_${vieille}`)).toBe(true);
  });

  it('C15 / O6-E07 — « où en est mon sinistre ? » : statut, indemnité, net (Q4) ; source = section Sinistres du bien ; de bout en bout (Standard)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const claimId = await ecrire(compte, async (r) => {
      const { id, sourceId } = await r.create({
        type: { code: 'CLAIM' }, status: 'REALIZED', realizedDate: '2026-03-01', technicalLabel: 'Dégât des eaux · 01/03/2026',
        source: { kind: 'CLAIM_FORM', entityKey: maison.id, authority: 'USER' },
        assets: [{ assetId: maison.id, role: 'PRIMARY', authority: 'USER' }], reasonCode: 'E2E',
      } as never);
      await r.upsertClaimDetails(id, { claimType: 'DEGAT_DES_EAUX', declaredOn: '2026-03-02', status: 'EN_ATTENTE_INDEMNISATION', insurerClaimRef: 'S-2026-1' });
      await r.addFinancialComponent(id, { kind: 'INDEMNITY', amountMinor: 80000, currency: 'EUR', sources: [{ sourceId }] } as never);
      return id;
    });
    const f = await doc(make, compte, maison.id, { title: 'Facture plombier', type: 'REPAIR_INVOICE', cents: 125000 });
    await intervention(compte, [maison.id], { docs: [{ fileId: f, role: 'INVOICE' }], comps: [{ kind: 'REALIZED_COST', cents: 125000 }], parent: claimId, label: 'Réparation fuite' });

    const r = await ask(compte.id, 'Où en est mon sinistre ?');
    expect(r.strategy).toBe('structured.claim_status');
    expect(r.answer).toMatch(/Sinistre « Dégât des eaux » du 1 mars 2026 \(Maison\) : statut « En attente d'indemnisation », déclaré le 2 mars 2026, référence assureur S-2026-1/);
    expect(r.answer).toMatch(/indemnité reçue : 800,00\s€ ; coût des réparations : 1\s250,00\s€ ; net après indemnité : 450,00\s€/);
    expect(r.sources[0].id).toBe(`claim:${maison.id}:${claimId}`);
    const { hrefSource } = await import('@/services/verebona-assistant/core/entity-ref');
    expect(hrefSource(r.sources[0].id)).toBe(`/assets/${maison.id}?tab=details&highlight=claims&claim=${claimId}`);

    // Coût du bien : réparation comptée une fois, indemnité dans le net seulement.
    const cout = await ask(compte.id, 'Combien ai-je dépensé pour la Maison ?');
    expect(cout.answer).toMatch(/Total des dépenses qualifiées : 1\s250,00\s€/);
    expect(cout.answer).toMatch(/Indemnités reçues : 800,00\s€ — coût net après indemnités : 450,00\s€/);

    // De bout en bout, offre Standard (aucun modèle) : même réponse, source ouvrable.
    const bout = await demander(compte, 'Où en est mon sinistre ?', { planType: 'STANDARD' });
    expect(bout.answer).toContain('En attente d\'indemnisation');
    expect(bout.sources.map((s) => s.id)).toContain(`claim:${maison.id}:${claimId}`);
    expect(bout.sources.find((s) => s.id.startsWith('claim:'))?.openAction?.href).toBe(`/assets/${maison.id}?tab=details&highlight=claims&claim=${claimId}`);
  });

  it('C15.2 / O6-E08 — « J’ai payé combien pour la Polo ? » : prix d’achat d’abord, cumul depuis l’achat à part, jamais additionnés', async () => {
    const { compte, bien } = await polo(make);
    await ecrire(compte, async (r) => {
      const { id, sourceId } = await r.create({
        type: { code: 'ACQUISITION' }, status: 'REALIZED', realizedDate: '2023-05-10',
        source: { kind: 'ASSET_DATA', entityKey: bien.id, authority: 'USER', locator: { field: 'acquisitionPrice' } },
        assets: [{ assetId: bien.id, role: 'PRIMARY', authority: 'USER' }], reasonCode: 'E2E',
      } as never);
      await r.addFinancialComponent(id, { kind: 'REALIZED_COST', amountMinor: 1850000, currency: 'EUR', sources: [{ sourceId }] } as never);
    });
    const f = await doc(make, compte, bien.id, { title: 'Facture révision', type: 'MAINTENANCE_INVOICE', cents: 125000 });
    await intervention(compte, [bien.id], { docs: [{ fileId: f, role: 'INVOICE' }], comps: [{ kind: 'REALIZED_COST', cents: 125000 }], label: 'Révision' });
    const r = await ask(compte.id, 'J’ai payé combien pour la Polo ?');
    expect(r.strategy).toBe('structured.acquisition_price');
    expect(r.answer).toMatch(/Prix d’achat de Polo : 18\s500,00\s€ \(achat du 10 mai 2023\)/);
    expect(r.answer).toMatch(/dépenses depuis l’achat \(hors prix d’achat\) : 1\s250,00\s€/);
    expect(r.answer).not.toMatch(/19\s750/);
    expect(r.sources[0].id).toBe(`asset_field:${bien.id}:acquisitionPrice`);
  });

  it('F-136 / F-137 / O6-E09 — Opération sans bien : exclue d’une question sur un bien, mentionnée pour le compte', async () => {
    const { compte, bien } = await polo(make);
    const f = await doc(make, compte, bien.id, { title: 'Facture carrosserie', type: 'REPAIR_INVOICE', cents: 40000 });
    await intervention(compte, [], { docs: [{ fileId: f, role: 'INVOICE' }], comps: [{ kind: 'REALIZED_COST', cents: 40000 }] });
    const c = await can();
    const surBien = await c.sumQualifiedExpenses(compte.id, { assetIds: [bien.id] });
    expect(surBien).toMatchObject({ qualifiedSumCents: 0, complete: false, documents: { representedElsewhere: { count: 1 } } });
    const r = await ask(compte.id, 'Combien ai-je dépensé pour la Polo ?');
    expect(r.answer).toContain('rattaché à une dépense dont le bien n’est pas confirmé');
    const compteGlobal = await c.sumQualifiedExpenses(compte.id, {});
    expect(compteGlobal).toMatchObject({ qualifiedSumCents: 40000, operations: { untargeted: { count: 1, sumCents: 40000 } } });
  });

  it('B15 / F-130 / O6-E11 — contrat (prestataire, n°, période, document du contrat) ; « retrouve la facture de… » par la source', async () => {
    const { compte, bien } = await polo(make);
    const police = await doc(make, compte, bien.id, { title: 'Conditions particulières', type: 'INSURANCE_POLICY', cents: null, date: '2026-01-01' });
    await ecrire(compte, async (r) => {
      const { id, sourceId } = await r.create({
        type: { code: 'CONTRACT' }, status: 'REALIZED', technicalLabel: 'Assurance auto', provider: 'MAAF', startDate: '2026-01-01',
        source: { kind: 'DOCUMENT', entityKey: police, role: 'CONTRACT_DOCUMENT', authority: 'DOCUMENT', confidence: 'certain' },
        assets: [{ assetId: bien.id, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E',
      } as never);
      await r.upsertContractDetails(id, { contractReference: 'C-42', periodicity: 'ANNUAL', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' });
      await r.addFinancialComponent(id, { kind: 'FORECAST_COST', amountMinor: 60000, currency: 'EUR', sources: [{ sourceId }] } as never);
    });
    const r = await ask(compte.id, 'Quel est mon contrat d’assurance pour la Polo ?');
    expect(r.strategy).toBe('structured.contracts');
    expect(r.answer).toMatch(/Contrat « Assurance auto » chez MAAF \(n° C-42\), du 1 janvier 2026 au 31 décembre 2026 — tarif annoncé : 600,00\s€ \(prévisionnel\)/);
    expect(r.sources[0].id).toBe(`doc_${police}`);
    // L'échéance reste à l'Agenda (C15) : la branche contrat ne la prend pas.
    expect((await ask(compte.id, 'Quand expire mon contrat d’assurance de la Polo ?')).strategy).not.toBe('structured.contracts');

    // Pont : le titre du document ne dit pas « embrayage », l'intervention si.
    const f = await doc(make, compte, bien.id, { title: 'Facture 2026-118', type: 'REPAIR_INVOICE', cents: 125000 });
    const sans = await ask(compte.id, 'Retrouve la facture de l’embrayage de la Polo');
    expect(sans.sources.map((s) => s.id)).not.toContain(`doc_${f}`);
    await intervention(compte, [bien.id], { docs: [{ fileId: f, role: 'INVOICE' }], comps: [{ kind: 'REALIZED_COST', cents: 125000 }] });
    const avec = await ask(compte.id, 'Retrouve la facture de l’embrayage de la Polo');
    expect(avec.strategy).toBe('retrieval.document');
    expect(avec.sources[0].id).toBe(`doc_${f}`);
    expect(avec.answer).toContain('Facture 2026-118');
  });

  it('F-127 / F-128 / O6-E12 — coût d’une intervention précise : composante consolidée ; sans Opération, repli documentaire', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const f = await doc(make, compte, maison.id, { title: 'Facture couverture', type: 'WORKS_INVOICE', cents: 240000 });
    // Sans Opération (F-128) : pas de réponse « consolidée », la recherche habituelle suit.
    const avant = await ask(compte.id, 'Combien a coûté la réfection du toit ?');
    expect(avant.strategy).not.toBe('structured.operation_cost');
    await intervention(compte, [maison.id], {
      docs: [{ fileId: f, role: 'INVOICE' }], label: 'Réfection toiture',
      comps: [{ kind: 'REALIZED_COST', cents: 250000 }, { kind: 'REDUCTION', cents: 10000 }],
    });
    const r = await ask(compte.id, 'Combien a coûté la réfection du toit ?');
    expect(r.strategy).toBe('structured.operation_cost');
    expect(r.answer).toMatch(/^Coût de l’intervention « Réfection toiture » \(Garage Martin, 2 mars 2026\) : 2\s400,00\s€\.$/);
    expect(r.sources[0].id).toBe(`doc_${f}`);
    // Sur le bien, même réponse ; le total du bien reste l'agrégat.
    expect((await ask(compte.id, 'Combien a coûté la réfection du toit de la Maison ?')).answer).toMatch(/2\s400,00\s€/);
    expect((await ask(compte.id, 'Combien ai-je dépensé pour la Maison ?')).strategy).toBe('structured.sum_qualified');
  });

  it('F-126 / F-131 — identité et valeur : canonique, jamais une Opération', async () => {
    const { compte, bien } = await polo(make);
    await sql`UPDATE assets SET key_characteristics = ${JSON.stringify({ registrationNumber: 'AB-123-CD' })} WHERE id = ${bien.id}`;
    const f = await doc(make, compte, bien.id, { title: 'Facture', type: 'REPAIR_INVOICE', cents: 1000 });
    await intervention(compte, [bien.id], { docs: [{ fileId: f, role: 'INVOICE' }], comps: [{ kind: 'REALIZED_COST', cents: 1000 }] });
    const r = await ask(compte.id, 'Quelle est l’immatriculation de la Polo ?');
    expect(r.strategy).toBe('structured.asset_field');
    expect(r.answer).toContain('AB-123-CD');
  });

  it('C21.1 / Q10 / O6-E10 — cache de l’assistant invalidé par un événement Opération, catalogue fermé inchangé', async () => {
    const { compte, bien } = await polo(make);
    const { registerAssistantBusinessEventHandlers } = await import('@/services/verebona-assistant/events/handlers');
    registerAssistantBusinessEventHandlers();
    const version = async () => (await sql<{ version: number; last_reason: string | null }[]>`
      SELECT version::int AS version, last_reason FROM verebona_cache_versions WHERE scope = ${`account:${compte.id}`}`)[0] ?? { version: 0, last_reason: null };
    const avant = await version();
    const f = await doc(make, compte, bien.id, { title: 'Facture', type: 'REPAIR_INVOICE', cents: 1000 });
    const id = await intervention(compte, [bien.id], { docs: [{ fileId: f, role: 'INVOICE' }], comps: [] });
    const apres = await version();
    expect(apres.version).toBeGreaterThan(avant.version);
    expect(apres.last_reason).toBe('BUSINESS_OPERATION_CREATED');
    await ecrire(compte, (r) => r.invalidate(id, 'E2E'));
    const fin = await version();
    expect(fin.version).toBeGreaterThan(apres.version);
    expect(fin.last_reason).toBe('BUSINESS_OPERATION_INVALIDATED');
    const { ASSISTANT_BUSINESS_EVENTS } = await import('@/services/verebona-assistant/events/business-events');
    expect(ASSISTANT_BUSINESS_EVENTS).toHaveLength(14);
  });
});
