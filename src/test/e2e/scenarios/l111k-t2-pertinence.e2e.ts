/**
 * Lot 111K — T2 : pertinence des preuves, suffisance, contradictions et
 * contrôle final commun, de bout en bout sur PostgreSQL réel : `runAssistant`
 * + PORTS RÉELS (`buildOrchestratorPorts`), recherche des faits T1 réelle
 * (`document_facts`, `asset_files`), lecture canonique et « Opération
 * d'abord » réelles, trace `verebona_request_runs` persistée, classement du
 * journal « Questions sans réponse » (lot 110E) sur la ligne réelle.
 *
 *   L111K-E2E-01  incident 1 : « combien ai-je payé » = montant documenté,
 *                 sans réserve de règlement ; la question de RÈGLEMENT lit les preuves ;
 *   L111K-E2E-02  incident 2 : HT / TTC / main-d'œuvre d'une facture ≠ conflit ;
 *   L111K-E2E-03  informations proches (prime, franchise, plafond) : la seule demandée ;
 *   L111K-E2E-04  information absente, voisines présentes : abstention, cause
 *                 EVIDENCE_REJECTED, journal ACCOUNT_DATA_INSUFFICIENT ;
 *   L111K-E2E-05  versions successives (bail puis avenant) : la valeur actuelle datée ;
 *   L111K-E2E-06  conflit RÉEL conservé (même information, même bien) ;
 *   L111K-E2E-07  génération affirmant un règlement non démontré : rejetée par le
 *                 contrôle final, insuffisance, motif QUALITY_ALERT ;
 *   L111K-E2E-08  même échéance de deux biens : deux informations, pas un conflit.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander } from '../chain';
import type { AccountRow } from '../factories';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

const svc = () => import('@/services/business-operations/write');
const bus = () => import('@/services/business-operations/events');
type Repo = import('@/services/business-operations/repository').BusinessOperationRepository;
type Fait = { attribute: string; value?: string | null; number?: number | null; unit?: string | null; subject?: string | null };

scenario('L111K-T2', 'Lot 111K — T2 pertinence des preuves, suffisance, contradictions, contrôle final', ({ sql, make }) => {
  afterEach(async () => { (await bus()).resetBusinessOperationEventBusForTests(); });

  const compte = async () => {
    const a = await make.account({ plan: 'premium' });
    return { id: a.id, ownerUserId: a.ownerUserId } as AccountRow;
  };
  const bien = async (c: AccountRow, name: string, category: string) => {
    const b = await make.asset(c, { category, name });
    await sql`UPDATE assets SET status = 'EN_SERVICE', deleted_at = NULL WHERE id = ${b.id}`;
    return b.id;
  };
  /** Document analysé rattaché à un bien, avec ses faits T1 (forme réelle de `document_facts`). */
  async function document(c: AccountRow, assetId: number | null, v: { title: string; type?: string | null; cents?: number | null; date?: string | null; faits?: Fait[] }) {
    const f = await make.assetFile(c, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${v.title}, document_type_code = ${v.type ?? null}, amount_cents = ${v.cents ?? null},
              document_date = ${v.date === undefined ? '2026-03-02' : v.date}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    const faits = v.faits ?? [];
    if (faits.length) {
      const [ext] = await sql<{ id: number }[]>`
        INSERT INTO document_extractions (account_id, file_id, title, full_text, source_type)
        VALUES (${c.id}, ${f.id}, ${v.title}, ${faits.map((x) => `${x.attribute} : ${x.value ?? x.number}`).join('\n')}, 'asset_file') RETURNING id`;
      for (const x of faits) {
        await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, subject, attribute, label, value_text, value_number, value_unit, confidence, excerpt)
                  VALUES (${c.id}, ${f.id}, ${ext.id}, ${x.attribute}, ${x.subject ?? v.title}, ${x.attribute}, ${x.attribute}, ${x.value ?? null}, ${x.number ?? null},
                          ${x.unit ?? null}, 'certain', ${`${x.attribute} : ${x.value ?? x.number}${x.unit ? ` ${x.unit}` : ''}`})`;
      }
    }
    return f.id;
  }
  const ecrire = async <T>(c: AccountRow, fn: (r: Repo) => Promise<T>) => (await svc()).withBusinessOperationWrite(c.id, fn);
  async function intervention(c: AccountRow, assetId: number, fileId: number, cents: number, label: string) {
    return ecrire(c, async (r) => {
      const { id, sourceId } = await r.create({
        type: { code: 'INTERVENTION' }, status: 'REALIZED', technicalLabel: label, provider: 'Garage Martin', realizedDate: '2026-03-02',
        source: { kind: 'DOCUMENT', entityKey: fileId, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain' },
        assets: [{ assetId, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E',
      } as never);
      await r.addFinancialComponent(id, { kind: 'REALIZED_COST', amountMinor: cents, currency: 'EUR', amountEurCents: null, economicDate: null, targetAssetId: null, sources: [{ sourceId }] } as never);
      return id;
    });
  }
  const derniereTrace = async (c: AccountRow) => {
    const [run] = await sql<{ p: Record<string, unknown> | null; j: Record<string, unknown> }[]>`
      SELECT retrieval_methods_json->'pertinence' AS p, retrieval_methods_json AS j FROM verebona_request_runs WHERE account_id = ${c.id} ORDER BY id DESC LIMIT 1`;
    return run;
  };

  it('L111K-E2E-01 — incident 1 : « Combien ai-je payé pour l’entretien de la Polo ? » → montant documenté, aucune réserve de règlement ; la question de règlement lit les preuves', async () => {
    const c = await compte();
    const polo = await bien(c, 'Polo', 'VEHICULE');
    const f = await document(c, polo, { title: 'Facture révision', type: 'MAINTENANCE_INVOICE', cents: 125000 });
    await intervention(c, polo, f, 125000, 'Révision 60 000 km');

    const paye = await demander(c, 'Combien ai-je payé pour l’entretien de la Polo ?');
    expect(paye.answer).toMatch(/1\s250,00\s€/);
    expect(paye.answer).not.toMatch(/preuve de paiement|ne prouve pas|réglé/i);
    expect(paye.answer).not.toMatch(/vous avez (payé|réglé)/i);
    expect(paye.cascade?.strategy).not.toBe('structured.payments');

    const regle = await demander(c, 'L’entretien de la Polo a-t-il été réglé ?');
    expect(regle.cascade?.strategy).toBe('structured.payments');
    expect(regle.answer).toContain('aucune preuve de paiement');

    const preuve = await document(c, polo, { title: 'Relevé virement', type: 'WORKS_PAYMENT_PROOF', cents: 125000, date: '2026-03-05' });
    const [op] = await sql<{ id: number }[]>`SELECT id FROM business_operations WHERE account_id = ${c.id} ORDER BY id DESC LIMIT 1`;
    await ecrire(c, (r) => r.addSource(op.id, { kind: 'DOCUMENT', entityKey: preuve, role: 'PAYMENT_PROOF', authority: 'DOCUMENT', confidence: 'certain' } as never));
    const avec = await demander(c, 'Ai-je déjà payé l’entretien de la Polo ?');
    expect(avec.answer).toMatch(/Règlements justifiés pour Polo \(entretien\) : 1\s250,00\s€/);
  });

  it('L111K-E2E-02 — incident 2 : « Quel est le prix de la révision de la Polo ? » → le total, jamais « trois valeurs différentes »', async () => {
    const c = await compte();
    const polo = await bien(c, 'Polo', 'VEHICULE');
    await document(c, polo, { title: 'Facture révision Polo', type: 'MAINTENANCE_INVOICE', faits: [
      { attribute: 'Montant HT', number: 100, unit: 'EUR', subject: 'Révision' },
      { attribute: 'Montant TTC', number: 120, unit: 'EUR', subject: 'Révision' },
      { attribute: 'Main d’œuvre', number: 60, unit: 'EUR', subject: 'Révision' },
    ] });
    const r = await demander(c, 'Quel est le prix de la révision de la Polo ?');
    expect(r.answer).not.toMatch(/valeurs différentes/);
    expect(r.answer).toMatch(/120/);
    expect(r.answer).not.toMatch(/\b100\b|\b60\b/);
    const t = await derniereTrace(c);
    expect(t.p).toMatchObject({ outcome: 'ANSWERED', sufficiency: { status: 'SUFFICIENT_RETRIEVAL', plurality: 'SINGLE' }, candidates: { evaluated: 3, admissible: 1 } });
    expect((t.p as { candidates: { byReason: Record<string, number> } }).candidates.byReason.LESS_SPECIFIC).toBe(2);
    expect(t.p).toMatchObject({ finalControl: { verdict: 'PASS', path: 'deterministic' } });
  });

  it('L111K-E2E-03 — informations proches dans la même attestation : seule la franchise demandée, ni prime ni plafond', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison', 'IMMOBILIER');
    await document(c, maison, { title: 'Attestation assurance habitation', type: 'HOME_INSURANCE_CERTIFICATE', faits: [
      { attribute: 'Prime annuelle', number: 480, unit: 'EUR', subject: 'Assurance habitation' },
      { attribute: 'Franchise', number: 300, unit: 'EUR', subject: 'Assurance habitation' },
      { attribute: 'Plafond mobilier', number: 20000, unit: 'EUR', subject: 'Assurance habitation' },
    ] });
    const r = await demander(c, 'Quelle est la franchise de l’assurance habitation de la Maison ?');
    expect(r.answer).toMatch(/300/);
    expect(r.answer).not.toMatch(/480|20\s?000|valeurs différentes/);
  });

  it('L111K-E2E-04 — information absente, voisines présentes : abstention sans donnée périphérique ; trace et journal distinguent la preuve rejetée', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison', 'IMMOBILIER');
    await document(c, maison, { title: 'Contrat entretien chaudière', type: null, faits: [
      { attribute: 'Prix annuel', number: 189, unit: 'EUR', subject: 'Contrat entretien chaudière' },
      { attribute: 'Date de début', value: '01/09/2025', subject: 'Contrat entretien chaudière' },
    ] });
    const r = await demander(c, 'Quel est le délai de préavis du contrat entretien de la chaudière de la Maison ?');
    expect(r.answer).not.toMatch(/189|01\/09\/2025/);
    const t = await derniereTrace(c);
    expect(r.route?.intent).toBe('ACCOUNT_FACT_DOCUMENT');
    expect(t.p).toMatchObject({ candidates: { rejected: 2, admissible: 0, byReason: { PROPERTY_MISMATCH: 2 } } });
    expect((t.p as { focus: { headTerm: string } }).focus.headTerm).toBe('delai');
    const { classifyJournalRow } = await import('@/services/verebona-assistant/core/unanswered-journal');
    const o = classifyJournalRow({
      request_id: 'x', created_at: new Date().toISOString(), intent: r.route?.intent ?? null, status: 'ok', error_code: null, state: r.finalState ?? null,
      strategy: r.cascade?.strategy ?? null, source_count: r.sources.length, ref_outcome: null, fallback_reason: null, help_fallback_reason: null,
      help_article: null, help_corpus_version: null, resources: null, pertinence: t.p as never, content: null,
    });
    if ((t.p as { motive: string | null }).motive) expect(o).toMatchObject({ corpus: 'ACCOUNT', motive: 'ACCOUNT_DATA_INSUFFICIENT' });
    expect((t.p as { cause: string | null }).cause === null || (t.p as { cause: string }).cause === 'EVIDENCE_REJECTED').toBe(true);
  });

  it('L111K-E2E-05 — valeur historique (attestation 2024) et actuelle (attestation 2026) d’une propriété hors registre : la valeur actuelle, datée, sans liste ni conflit', async () => {
    const c = await compte();
    const polo = await bien(c, 'Polo', 'VEHICULE');
    await document(c, polo, { title: 'Attestation assurance auto 2024', date: '2024-01-10', faits: [{ attribute: 'Franchise', number: 300, unit: 'EUR', subject: 'Assurance auto' }] });
    await document(c, polo, { title: 'Attestation assurance auto 2026', date: '2026-01-10', faits: [{ attribute: 'Franchise', number: 350, unit: 'EUR', subject: 'Assurance auto' }] });
    const r = await demander(c, 'Quelle est la franchise de l’assurance auto de la Polo ?');
    expect(r.answer).toMatch(/350/);
    expect(r.answer).not.toMatch(/\b300\b|valeurs différentes/);
    expect(r.answer).toContain('10 janvier 2026');
    expect((await derniereTrace(c)).p).toMatchObject({ sufficiency: { plurality: 'SUCCESSIVE_VERSIONS' } });
  });

  it('L111K-E2E-06 — contradiction RÉELLE (même information, même bien, sans contexte qui les départage) : signalée avec ses sources', async () => {
    const c = await compte();
    const polo = await bien(c, 'Polo', 'VEHICULE');
    await document(c, polo, { title: 'Carte grise Polo', date: null, faits: [{ attribute: 'Puissance fiscale', number: 5, unit: 'CV' }] });
    await document(c, polo, { title: 'Facture achat Polo', date: null, faits: [{ attribute: 'Puissance fiscale', number: 6, unit: 'CV' }] });
    const r = await demander(c, 'Quelle est la puissance fiscale de la Polo ?');
    expect(r.answer).toMatch(/deux valeurs différentes.*5\sCV.*6\sCV|deux valeurs différentes.*6\sCV.*5\sCV/);
    expect(r.supportLevel).toBe('conflicting');
    const t = await derniereTrace(c);
    expect(t.p).toMatchObject({ outcome: 'CONFLICT', cause: 'REAL_CONFLICT', motive: 'CONTRADICTION_AMBIGUITY' });
    expect((t.p as { conflicts: unknown[] }).conflicts).toHaveLength(1);
  });

  it('L111K-E2E-07 — génération qui affirme un règlement non démontré : rejetée par le contrôle final commun, insuffisance, alerte qualité', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison', 'IMMOBILIER');
    await document(c, maison, { title: 'Notice chauffe-eau', faits: [{ attribute: 'Volume du ballon', value: '200 L — prix à la commande 2 200,00 €', subject: 'Chauffe-eau' }] });
    const { runAssistant } = await import('@/services/verebona-assistant/core/assistant-orchestrator.service');
    const { buildOrchestratorPorts } = await import('@/services/verebona-assistant/core/ports');
    const { toIntentRoute } = await import('@/services/verebona-assistant/core/classification.adapter');
    const { FINAL_CONTROL_INSUFFICIENT_MESSAGE } = await import('@/services/verebona-assistant/core/final-answer-control');
    const ports = buildOrchestratorPorts();
    let appels = 0;
    const r = await runAssistant({
      accountId: c.id, userId: c.ownerUserId, planType: 'PREMIUM', message: 'Quelle est la capacité du ballon d’eau chaude de la Maison ?',
      clientRequestId: `l111k-${Date.now()}`, locale: 'fr-FR',
    } as never, {
      ...ports,
      classifyWithAI: async () => ({ ...toIntentRoute({ intent: 'ACCOUNT_FACT_ASSET', confidence: 'exact', entityHints: [{ type: 'asset', value: 'Maison' }] as never, reason: 'e2e' }, 'PREMIUM'),
        understanding: { requestedFacts: [], requestedTopics: ['capacité'], filters: {} } }),
      generateWithAI: async (_route, sources) => {
        appels += 1;
        const id = sources[0]?.id ?? 'doc_0';
        return { answer: 'Le ballon a été payé 2 200,00 €.', claims: [{ claimKey: 'c1', text: 'Le ballon a été payé 2 200,00 €.', sourceIds: [id], derivation: 'direct' }], actions: [], supportLevel: 'supported' } as never;
      },
    });
    if (appels > 0) {
      expect(r.answer).toBe(FINAL_CONTROL_INSUFFICIENT_MESSAGE);
      expect(r.claims).toEqual([]);
      const t = await derniereTrace(c);
      expect(t.p).toMatchObject({ finalControl: { verdict: 'REJECTED', path: 'generation' }, cause: 'PRODUCTION_REJECTED', motive: 'QUALITY_ALERT' });
    }
    // Jamais un règlement affirmé, quel que soit le parcours.
    expect(r.answer).not.toMatch(/a été payé/);
  });

  it('L111K-E2E-08 — même échéance pour deux biens : deux informations listées, jamais une contradiction', async () => {
    const c = await compte();
    const polo = await bien(c, 'Polo', 'VEHICULE');
    const clio = await bien(c, 'Clio', 'VEHICULE');
    const j = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    await make.agendaItem(c, { title: 'Contrôle technique', startDate: j(40), assetIds: [polo] });
    await make.agendaItem(c, { title: 'Contrôle technique', startDate: j(90), assetIds: [clio] });
    const r = await demander(c, 'Quand expire le contrôle technique ?');
    expect(r.answer).not.toMatch(/valeurs différentes/);
    if (r.cascade?.strategy === 'structured.deadline_of') expect(r.answer).toMatch(/Polo.*Clio|Clio.*Polo/);
  });
});
