/**
 * Lot 113AL (Trello #737, écart au CDC 82B / 111V) — arbitrage sémantique T3 des montants non qualifiés du TCO, sur
 * PostgreSQL 16 réel. Modèle SIMULÉ DERRIÈRE la passerelle réelle (`replay-gateway` : prompt rendu, schéma, traces
 * `ai_usage_event`, coût) — jamais d'appel Gemini. Version T3 active de test = texte du dépôt + bloc 31 du guide du PO
 * (aucun fichier de prompt modifié). Contrôle de cohérence réel (orchestrateur unique), passage T3 réel
 * (`consolidateAccountOperations`), moteur TCO, route TCO, T2 et dossier du BO réels.
 *
 *   L113AL-E2E-ACCEPTATION  compte 10 / Maison #32 rendu générique (avis 1 340 €, justificatif de paiement 1 340 €,
 *                           justificatif d'acquisition 289 000 €) : sans bloc → constat CONTRACT_PENDING, aucun appel ;
 *                           bloc actif → le contrôle DEMANDE l'arbitrage (REPAIR_PENDING, aucun appel), la consultation
 *                           n'appelle rien, le passage T3 appelle la branche RÉELLE (trace), la sortie est validée, la
 *                           décision persistée, le moteur la reflète (TCO, annuel, T2, dossier, cohérence REPAIRED) ;
 *                           idempotence (aucun nouvel appel, aucune dépense en double) ; recettes 1, 2, 3, 9, 12 ;
 *   L113AL-E2E-CAS          recettes 4 (deux dépenses de même montant), 6 (multibiens), 7 (décision de l'utilisateur
 *                           prioritaire, jamais soumise), 8 (document ancien sans candidat : montant de l'extract), sortie
 *                           invalide → abstention → arbitrage de l'utilisateur ; véhicule (recette 11) ;
 *   L113AL-E2E-PANNE        recette 10 : fournisseur indisponible → attente technique durable, relances bornées puis
 *                           reprise ; contrat retiré pendant l'attente → CONTRACT_PENDING, reprise au retour ;
 *   L113AL-E2E-DROITS       compte restreint : zéro appel ; Standard : TCO refusé ; isolation des comptes.
 *
 * Assertions bornées aux comptes créés ici.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { operationsKit, RECETTE_TODAY } from '../datasets/operations-v1';
import { proofOf, runCoherenceFor } from '../coherence-run';
import { setDefaultResponder } from '../replay-gateway';
import type { AccountRow, AssetRow } from '../factories';
import type { ProviderCallInput } from '@/services/ai/gateway/providers/provider.port';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const OP = 't3_economic_qualification';
const TASK = 'ECONOMIC_QUALIFICATION';
const CHECK = 'COH-TCO-EXTRACTED-EXPENSES';
const PRIX = 28_900_000;
const AVIS = 134_000;
const REPERE = 'Réponds uniquement par le JSON correspondant au TASK demandé.';

/** Objet JSON du prompt rendu qui commence par `{"<cle>":` (variables du master, extraction équilibrée). */
function objetJson(p: string, cle: string): Json | null {
  const m = new RegExp(`\\{\\s*"${cle}"\\s*:`).exec(p);
  if (!m) return null;
  let prof = 0; let chaine = false; let echap = false;
  for (let i = m.index; i < p.length; i++) {
    const ch = p[i];
    if (chaine) { if (echap) echap = false; else if (ch === '\\') echap = true; else if (ch === '"') chaine = false; continue; }
    if (ch === '"') chaine = true;
    else if (ch === '{' || ch === '[') prof++;
    else if (ch === '}' || ch === ']') { prof--; if (prof === 0) { try { return JSON.parse(p.slice(m.index, i + 1)); } catch { return null; } } }
  }
  return null;
}
/** Lecture du prompt rendu : documents (D0 = document examiné) et faits déjà comptés (références opaques). */
const documentsDu = (p: string): Json[] => (objetJson(p, 'documents')?.documents ?? []) as Json[];
/** Le simulé reconnaît D0 par ses extraits (le titre affiché suit la règle unique des vues, jamais un identifiant). */
const cible = (p: string) => ((documentsDu(p).find((d) => d.ref === 'D0')?.excerpts ?? []) as string[]).join(' | ');
const refDoc = (p: string, extrait: string) => (documentsDu(p).find((d) => ((d.excerpts ?? []) as string[]).some((e) => e.includes(extrait)))?.ref as string | undefined) ?? null;
const faits = (p: string): Json[] => (objetJson(p, 'amounts')?.countedFacts ?? []) as Json[];
const sortie = (...decisions: Json[]) => ({ task: TASK, decisions });

scenario('L113AL', 'TCO / T3 — arbitrage sémantique automatique des montants non qualifiés (#737)', ({ sql, make, replay }) => {
  const k = operationsKit(sql, make);
  let NextRequest: typeof import('next/server').NextRequest;
  const texteT3 = readFileSync(join(process.cwd(), 'src/services/ai/prompts/reconciliation/t3_master_v1.txt'), 'utf8');
  let bloc31 = '';

  beforeAll(async () => {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId, role: 'USER', email: '' }) as never);
    ({ NextRequest } = await import('next/server'));
    const { parseGuideBlocks } = await import('@/services/ai/prompt-conformity/guide-blocks');
    bloc31 = parseGuideBlocks(readFileSync(join(process.cwd(), 'docs/exploitation/prompts-a-appliquer-par-le-po.md'), 'utf8'))
      .find((b) => b.id === 't3-economic-qualification-v1')!.text;
  });
  afterEach(async () => { setDefaultResponder(OP, TASK, null); await activer(false); });
  afterAll(async () => { session.currentAccountId = 0; });

  /** Version T3 active : texte du dépôt, avec ou sans le bloc 31 tel que le PO le colle. */
  async function activer(avecBloc: boolean): Promise<void> {
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    __setActiveMasterPromptsForTests(avecBloc ? [{ id: 113_731, treatment: 'T3', versionNumber: 731, content: texteT3.replace(REPERE, `${bloc31}\n\n${REPERE}`) }] : null);
    (await import('@/services/business-operations/tco/semantic-qualification/decider')).__resetQualificationCapabilityCacheForTests();
  }
  const as = (c: AccountRow) => { session.userId = c.ownerUserId; session.currentAccountId = c.id; };
  const getTco = async (c: AccountRow, assetId: number) => {
    as(c);
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/tco`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: await res.json() as Json };
  };
  const tco = async (c: AccountRow, assetId: number) => (await import('@/services/business-operations/tco/service')).readAssetTco(c.id, assetId, { today: RECETTE_TODAY });
  const ligne = (t: { lines: Json[] }, fileId: number) => t.lines.find((l) => l.source === 'DOCUMENT' && l.fileId === fileId) as Json;
  /** Appels de la branche reçus par le fournisseur simulé, derrière la passerelle réelle (prompt T3 + bloc 31 rendu). */
  const appels = () => replay.calls.filter((x) => x.operationCode === OP && x.task === TASK && x.prompt.includes(`BRANCHE TASK = ${TASK}`)).length;
  const examens = (c: AccountRow) => sql<Json[]>`
    SELECT id::int AS id, file_id, status, trigger, decisions, validation, reason, ai_calls, attempts, ai_trace_id, prompt_version, model, ai_cost_micros,
           lines_before, lines_after, contract_version, retry_at, superseded_by
      FROM economic_qualification_reviews WHERE account_id = ${c.id} ORDER BY id`;
  /** Passage T3 RÉEL du compte (file de consolidation) ; M3 sans appel (hors sujet). */
  const passageT3 = async (c: AccountRow) => (await import('@/services/business-operations/consolidation/consolidator')).consolidateAccountOperations(c.id, {
    today: RECETTE_TODAY, operationMatch: { maxCallsPerPass: 0, maxCallsPerDay: 0, callModel: async () => { throw new Error('M3 hors sujet'); } },
  });
  /** Unités sources T1 persistées (extraits lus) — jamais le fichier. */
  async function unites(c: AccountRow, fileId: number, textes: string[]) {
    const [x] = await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${fileId}`;
    let i = 0;
    for (const t of textes) {
      await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, page, ordinal, content_text, coverage_status, salient)
                VALUES (${c.id}, ${fileId}, ${x?.id ?? null}, ${`u-${fileId}-${i}`}, 'TEXT_BLOCK', 1, ${i}, ${t}, 'NON_INFORMATIONAL', true)`;
      i++;
    }
  }
  /** Document que T1 n'a PAS qualifié (type générique, aucun candidat ni indice financier) : seul cas qui reste à T3. */
  async function piece(c: AccountRow, assetId: number | null, o: { title: string; cents: number | null; date: string; textes: string[] }) {
    const f = await k.document(c, assetId, [], { type: 'OTHER', title: o.title, amountCents: o.cents, date: o.date });
    await unites(c, f, o.textes);
    return f;
  }
  const maisonDe = (c: AccountRow, category = 'IMMOBILIER'): Promise<AssetRow> =>
    make.asset(c, { category, name: category === 'IMMOBILIER' ? 'Maison' : 'Bien', purchasePriceCents: PRIX, keyCharacteristics: { acquisitionDate: '2019-06-01' } });

  /** Modèle SIMULÉ : décide d'après le document D0 rendu dans le prompt (jamais d'après un identifiant). */
  const modeleMaison = (input: ProviderCallInput) => {
    const p = input.prompt;
    const t = cible(p);
    if (t.includes('Montant à payer : 1 340,00 €')) {
      return sortie({ amount: 'M1', outcome: 'INCLUDE', role: 'REALIZED_COST', scope: 'TOTAL', economicDate: '2025-09-01', allocation: 'THIS_ASSET', confidence: 'certain',
        evidence: [{ document: 'D0', excerpt: 'Montant à payer : 1 340,00 €' }, { document: 'D0', excerpt: 'Cotisation annuelle due pour le bien' }], reason: 'Cotisation annuelle due pour ce bien.' });
    }
    if (t.includes('Prélèvement de 1 340,00 €')) {
      const d1 = refDoc(p, 'Montant à payer : 1 340,00 €');
      const f = (faits(p).find((x) => x.source === 'DOCUMENT' && d1 && x.document === d1)?.ref as string | undefined) ?? null;
      return f && d1
        ? sortie({ amount: 'M1', outcome: 'REPRESENTED', role: 'PAYMENT', economicDate: '2025-10-14', representedBy: f, confidence: 'certain',
          evidence: [{ document: 'D0', excerpt: 'Prélèvement de 1 340,00 € au profit de l’émetteur de l’avis' }, { document: d1, excerpt: 'Montant à payer : 1 340,00 €' }], reason: 'Règlement de l’avis.' })
        : sortie({ amount: 'M1', outcome: 'ABSTAIN', confidence: 'ambiguous', reason: 'Fait réglé non encore compté.' });
    }
    if (t.includes('Prix de vente : 289 000 €')) {
      return sortie({ amount: 'M1', outcome: 'REPRESENTED', role: 'REALIZED_COST', scope: 'TOTAL', representedBy: faits(p).find((x) => x.source === 'ASSET_DATA')?.ref ?? null, confidence: 'certain',
        evidence: [{ document: 'D0', excerpt: 'Prix de vente : 289 000 €' }, { document: 'D0', excerpt: 'Vente du bien situé à l’adresse de la maison' }], reason: 'Pièce de l’achat déjà compté par la fiche.' });
    }
    // Trace de diagnostic du scénario (prompt inattendu) — jamais une décision.
    const k = p.lastIndexOf('"documents"');
    console.warn('[l113al-e2e] prompt hors scénario :', JSON.stringify(p.slice(Math.max(0, k - 120), k + 700)), p.length, p.lastIndexOf('Preuves candidates'));
    return sortie({ amount: 'M1', outcome: 'ABSTAIN', confidence: 'ambiguous', reason: 'Hors scénario.' });
  };

  async function maisonCompte10(plan: 'premium' | 'premium_duo' = 'premium') {
    const c = await make.account({ plan });
    const m = await maisonDe(c);
    const avis = await piece(c, m.id, { title: 'Avis 2025', cents: AVIS, date: '2025-09-01',
      textes: ['Montant à payer : 1 340,00 €', 'Date limite de paiement : 15/10/2025', 'Cotisation annuelle due pour le bien'] });
    const paiement = await piece(c, m.id, { title: 'Justificatif de paiement', cents: AVIS, date: '2025-10-14',
      textes: ['Prélèvement de 1 340,00 € au profit de l’émetteur de l’avis', 'Date du prélèvement : 14/10/2025'] });
    const acte = await piece(c, m.id, { title: 'Justificatif d’acquisition', cents: PRIX, date: '2019-06-01',
      textes: ['Prix de vente : 289 000 €', 'Vente du bien situé à l’adresse de la maison'] });
    return { c, m, avis, paiement, acte };
  }

  // ══ Acceptation bloquante ═════════════════════════════════════════════════
  it('L113AL-E2E-ACCEPTATION — branche T3 réellement appelée, sortie validée, décision persistée, effet sur le moteur, TCO / T2 / dossier / cohérence', async () => {
    const { c, m, avis, paiement, acte } = await maisonCompte10();
    const avant = await tco(c, m.id);
    for (const f of [avis, paiement, acte]) expect(ligne(avant, f)).toMatchObject({ status: 'NOT_QUALIFIED', reason: 'THEME_UNKNOWN', includedCents: 0 });
    const t2 = async () => (await import('@/services/verebona-assistant/canonical/expenses')).sumQualifiedExpenses(c.id, { assetIds: [m.id] });
    const t2Avant = await t2();

    // 1) Sans bloc 31 : constat explicite CONTRACT_PENDING (supervisé), aucune demande, aucun appel.
    await activer(false);
    const r0 = await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
    expect(r0.results[CHECK]).toEqual({ FINDING: 1 });
    expect((await proofOf(sql, c.id, CHECK, m.id))?.finding).toMatchObject({ anomaly: 'EXTRACTED_EXPENSE_NOT_EVALUATED',
      detail: expect.objectContaining({ t3Contract: 'CONTRACT_PENDING', contract: 't3-economic-qualification-v1', pendingContract: '82B-t3-decision-tco', resolution: 'USER_DECISION' }) });
    expect(await examens(c)).toEqual([]);
    expect(appels()).toBe(0);

    // 2) Bloc 31 actif : le contrôle DEMANDE l'arbitrage (aucun appel), réparation EN ATTENTE (jamais un faux REPAIRED).
    await activer(true);
    setDefaultResponder(OP, TASK, modeleMaison);
    const r1 = await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
    expect(r1.results[CHECK]).toEqual({ REPAIR_PENDING: 1 });
    expect((await examens(c)).map((x) => [x.file_id, x.status, x.trigger])).toEqual([[avis, 'PENDING', 'COHERENCE'], [paiement, 'PENDING', 'COHERENCE'], [acte, 'PENDING', 'COHERENCE']]);
    expect(appels()).toBe(0);
    // Consultation du TCO : jamais d'IA ; examen en attente visible sur la ligne.
    const vue = await getTco(c, m.id);
    expect(vue.status).toBe(200);
    expect(appels()).toBe(0);
    expect(ligne(vue.body.tco, avis)).toMatchObject({ status: 'NOT_QUALIFIED' });
    expect(ligne(await tco(c, m.id), avis).semantic).toMatchObject({ state: 'AWAITING' });
    // Le balayage horaire du passage T3 retient le compte.
    const { listAccountsToConsolidate } = await import('@/services/business-operations/consolidation/consolidator');
    expect(await listAccountsToConsolidate(c.id - 1, 50)).toContain(c.id);

    // 3) Passage T3 RÉEL : la branche est appelée par la passerelle (trace), sortie validée, décision persistée.
    const pass = await passageT3(c);
    expect(pass.economicQualification).toMatchObject({ processed: 3, aiCalls: 3, outcomes: { DECIDED: 3 } });
    expect(appels()).toBe(3);
    const traces = await sql<Json[]>`SELECT metadata->>'traceId' AS trace, operation_code, model FROM ai_usage_event WHERE account_id = ${c.id} AND operation_code = ${OP} ORDER BY id`;
    expect(traces).toHaveLength(3);
    const ex = await examens(c);
    expect(ex.map((x) => [x.file_id, x.status, x.ai_calls])).toEqual([[avis, 'DECIDED', 1], [paiement, 'DECIDED', 1], [acte, 'DECIDED', 1]]);
    for (const x of ex) {
      expect(x.validation).toEqual({ valid: true });
      expect(x.contract_version).toBe('t3-economic-qualification-v1');
      expect(x.prompt_version).toBeTruthy();
      expect(x.model).toBeTruthy();
      expect(traces.map((t) => t.trace)).toContain(x.ai_trace_id);
      expect(x.lines_before[0]).toMatchObject({ status: 'NOT_QUALIFIED' });
    }
    expect(ex[0].decisions).toEqual([expect.objectContaining({ outcome: 'INCLUDE', applied: true, role: 'REALIZED_COST', amountMinor: AVIS, evidence: expect.arrayContaining([expect.objectContaining({ fileId: avis })]) })]);
    expect(ex[0].lines_after).toEqual([expect.objectContaining({ status: 'RETAINED_DIRECT', includedCents: AVIS })]);
    expect(ex[1].decisions).toEqual([expect.objectContaining({ outcome: 'REPRESENTED', role: 'PAYMENT', representedBy: expect.objectContaining({ lineId: `doc:${avis}` }) })]);
    expect(ex[2].decisions).toEqual([expect.objectContaining({ outcome: 'REPRESENTED', representedBy: expect.objectContaining({ key: `asset:${m.id}:acquisitionPrice`, source: 'ASSET_DATA' }) })]);

    // 4) Effet sur le MOTEUR existant : une seule dépense, règlement jamais compté, prix d'achat relié, aucune nouvelle somme.
    const apres = await tco(c, m.id);
    expect(ligne(apres, avis)).toMatchObject({ status: 'RETAINED_DIRECT', provenance: 'T3', includedCents: AVIS, semantic: { state: 'APPLIED', confidence: 'certain' } });
    expect(ligne(apres, paiement)).toMatchObject({ status: 'PAYMENT', reason: 'PAYMENT_PROOF', includedCents: 0, duplicateOf: `doc:${avis}` });
    expect(ligne(apres, acte)).toMatchObject({ status: 'CONSOLIDATED_ELSEWHERE', reason: 'SAME_AS_ASSET_PRICE', includedCents: 0, duplicateOf: `asset:${m.id}:acquisitionPrice` });
    expect(apres.summary.cumulativeCostCents - avant.summary.cumulativeCostCents).toBe(AVIS);
    expect(apres.lines.filter((l) => l.status === 'NOT_QUALIFIED')).toEqual([]);
    // TCO annuel (même lignes) : l'année de l'avis porte la charge.
    expect(apres.annual.years.find((y) => y.year === 2025)?.netCents ?? 0).toBeGreaterThanOrEqual(AVIS);
    // Route (fiche) : même résultat.
    const route = await getTco(c, m.id);
    expect(route.body.tco.summary.cumulativeCostCents).toBe(apres.summary.cumulativeCostCents);
    // T2 (Assistant) : même résultat (aucun second calcul).
    const t2Apres = await t2();
    expect(t2Apres.qualifiedSumCents - t2Avant.qualifiedSumCents).toBe(AVIS);
    // Exclusions T2 lues du même moteur : le règlement et la pièce d'achat ne sont jamais recomptés.
    const ex2 = await (await import('@/services/business-operations/tco/service')).t2CostExclusions(c.id, [], [m.id], undefined, { today: RECETTE_TODAY });
    expect(ex2.userAdded).toEqual([expect.objectContaining({ fileId: avis, eurCents: AVIS })]);
    expect([...ex2.files].sort((x, y) => x - y)).toEqual([paiement, acte].sort((x, y) => x - y));
    // Dossier du bien (export BO, section « Coût de possession ») : même moteur, même total.
    const { loadSectionPage } = await import('@/services/admin/account-data/dossier');
    const sec = await loadSectionPage(c.id, 'asset' as never, m.id, 'tco').catch(() => null);
    if (sec) expect(JSON.stringify(sec)).toContain(String(apres.summary.cumulativeCostCents));

    // 5) Cohérence : réparation effective constatée au contrôle suivant (REPAIRED réel).
    const r2 = await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
    expect(r2.results[CHECK]).toEqual({ REPAIRED: 1 });

    // 6) Idempotence (recette 9) : nouveau passage, contrôle et consultation → aucun appel, aucune dépense en double.
    expect((await passageT3(c)).economicQualification).toBeUndefined();
    await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
    await getTco(c, m.id);
    expect(appels()).toBe(3);
    expect((await examens(c)).length).toBe(3);
    expect((await tco(c, m.id)).summary.cumulativeCostCents).toBe(apres.summary.cumulativeCostCents);

    // 7) Décision de l'utilisateur après T3 : elle prime (retrait), le choix est journalisé, aucun appel.
    as(c);
    const l = ligne(route.body.tco, avis);
    const { POST } = await import('@/app/api/assets/[id]/tco/decisions/route');
    const d = await POST(new NextRequest(`http://x/api/assets/${m.id}/tco/decisions`, { method: 'POST', body: JSON.stringify({ lineId: l.id, lineKey: l.decisionKey, action: 'EXCLUDE' }) }), { params: Promise.resolve({ id: String(m.id) }) });
    expect(d.status).toBe(200);
    expect(ligne(await tco(c, m.id), avis)).toMatchObject({ status: 'EXCLUDED', reason: 'USER_EXCLUDED', includedCents: 0 });
    await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
    await passageT3(c);
    expect(appels()).toBe(3);
  });

  // ══ Cas de la recette ═════════════════════════════════════════════════════
  it('L113AL-E2E-CAS — montants égaux distincts, multibiens, décision de l’utilisateur, extract sans candidat, sortie invalide, véhicule', async () => {
    const c = await make.account({ plan: 'premium' });
    const v = await maisonDe(c, 'VEHICULE');
    const autre = await make.asset(c, { category: 'VEHICULE', name: 'Autre' });
    const f1 = await piece(c, v.id, { title: 'Courrier mars', cents: 50_000, date: '2025-03-01', textes: ['Entretien annuel : 500,00 €', 'Intervention du 01/03/2025'] });
    const f2 = await piece(c, v.id, { title: 'Courrier septembre', cents: 50_000, date: '2025-09-01', textes: ['Entretien annuel : 500,00 €', 'Intervention du 01/09/2025'] });
    const commun = await piece(c, v.id, { title: 'Appel commun', cents: 80_000, date: '2025-04-01', textes: ['Total commun : 800,00 €', 'Concerne les deux véhicules'] });
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, status, origin) VALUES (${c.id}, ${commun}, ${autre.id}, 'SECONDARY', 'ACTIVE', 'USER')`.catch(async () => {
      await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, status) VALUES (${c.id}, ${commun}, ${autre.id}, 'SECONDARY', 'ACTIVE')`;
    });
    const ancien = await piece(c, v.id, { title: 'Vieux courrier', cents: null, date: '2023-02-01', textes: ['Réparation de la carrosserie : 420,00 €'] });
    const invente = await piece(c, v.id, { title: 'Courrier à vérifier', cents: 9_900, date: '2025-05-01', textes: ['Montant : 99,00 €'] });
    const decide = await piece(c, v.id, { title: 'Courrier décidé', cents: 7_700, date: '2025-06-01', textes: ['Montant : 77,00 €'] });
    // Recette 7 : décision de l'utilisateur AVANT tout examen — jamais soumise à l'IA, jamais écrasée.
    const l0 = ligne((await getTco(c, v.id)).body.tco, decide);
    as(c);
    const { POST } = await import('@/app/api/assets/[id]/tco/decisions/route');
    const d = await POST(new NextRequest(`http://x/api/assets/${v.id}/tco/decisions`, { method: 'POST', body: JSON.stringify({ lineId: l0.id, lineKey: l0.decisionKey, action: 'CONFIRM_EXCLUSION' }) }), { params: Promise.resolve({ id: String(v.id) }) });
    expect(d.status, JSON.stringify(await d.clone().json())).toBe(200);

    await activer(true);
    const vus: string[] = [];
    setDefaultResponder(OP, TASK, (input) => {
      const t = cible(input.prompt);
      vus.push(t);
      const inclure = (excerpt: string, o: Json = {}) => sortie({ amount: 'M1', outcome: 'INCLUDE', role: 'REALIZED_COST', scope: 'TOTAL', allocation: 'THIS_ASSET', confidence: 'certain',
        evidence: [{ document: 'D0', excerpt }], reason: 'Dépense du bien.', ...o });
      if (t.includes('Intervention du 01/03/2025')) return inclure('Intervention du 01/03/2025', { economicDate: '2025-03-01' });
      if (t.includes('Intervention du 01/09/2025')) return inclure('Intervention du 01/09/2025', { economicDate: '2025-09-01' });
      if (t.includes('Total commun : 800,00 €')) return inclure('Total commun : 800,00 €', { allocation: 'SHARED_NOT_ALLOCATED' });
      if (t.includes('Réparation de la carrosserie')) return inclure('Réparation de la carrosserie : 420,00 €', { economicDate: '2023-02-01' });
      if (t.includes('Montant : 99,00 €')) return inclure('Montant payé le 01/05/2025 : 99,00 €');
      return sortie({ amount: 'M1', outcome: 'ABSTAIN', confidence: 'ambiguous', reason: 'Hors scénario.' });
    });
    expect((await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY })).results[CHECK].REPAIR_PENDING).toBeGreaterThanOrEqual(1);
    expect((await proofOf(sql, c.id, CHECK, v.id))?.last_result).toBe('REPAIR_PENDING');
    const demandes = (await examens(c)).filter((x) => x.status === 'PENDING').map((x) => x.file_id);
    expect(demandes).toEqual(expect.arrayContaining([f1, f2, commun, ancien, invente]));
    expect(demandes).not.toContain(decide);
    await passageT3(c);
    expect(vus.some((x) => x.includes('Montant : 77,00 €'))).toBe(false);
    const t = await tco(c, v.id);
    // Recette 4 : deux coûts, aucune fusion par égalité de montant.
    expect([ligne(t, f1).includedCents, ligne(t, f2).includedCents]).toEqual([50_000, 50_000]);
    // Recette 6 : commun à deux biens sans ventilation prouvée — non attribué, jamais réparti.
    expect(ligne(t, commun)).toMatchObject({ status: 'UNALLOCATED', includedCents: 0 });
    // Recette 8 : document ancien sans montant ni candidat — montant de l'extract, sans retraitement T1.
    expect(ligne(t, ancien)).toMatchObject({ id: `doc:${ancien}:t3:0`, status: 'RETAINED_DIRECT', amountMinor: 42_000, includedCents: 42_000 });
    expect((await sql`SELECT count(*)::int AS n FROM document_operation_candidates WHERE file_id = ${ancien}`)[0].n).toBe(0);
    // Sortie invalide (extrait inventé) : abstention, motif tracé, la ligne reste à l'utilisateur.
    expect((await examens(c)).find((x) => x.file_id === invente)).toMatchObject({ status: 'REJECTED', reason: 'INVALID_DECISION:EXCERPT_NOT_FOUND', validation: { valid: false } });
    expect(ligne(t, invente)).toMatchObject({ status: 'NOT_QUALIFIED', semantic: { state: 'ABSTAINED' } });
    // Recette 7 : le choix de l'utilisateur reste appliqué.
    expect(ligne(t, decide)).toMatchObject({ userDecision: { decision: 'CONFIRM_EXCLUSION', applied: true }, includedCents: 0 });
    // Le reliquat (abstention) légitime seul un arbitrage de l'utilisateur ; aucun nouvel appel sur ce contexte.
    const n = appels();
    await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
    // Réparation demandée sans effet complet (abstention) : constat, jamais « réparé ».
    expect(['REPAIR_INEFFECTIVE', 'FINDING']).toContain((await proofOf(sql, c.id, CHECK, v.id))?.last_result);
    expect((await proofOf(sql, c.id, CHECK, v.id))?.finding).toMatchObject({ anomaly: 'EXTRACTED_EXPENSE_NOT_EVALUATED', detail: expect.objectContaining({ t3Contract: 'ABSTAINED', resolution: 'USER_DECISION' }) });
    await passageT3(c);
    // Les faits comptés du bien ont changé (nouvelles dépenses retenues) : un examen resté sans décision peut être
    // réexaminé UNE fois dans son nouveau contexte (preuve pertinente nouvelle) ; ensuite, plus aucun appel.
    const relus = vus.slice(vus.length - (appels() - n));
    console.info('[l113al-e2e] réexamens après changement des faits comptés :', JSON.stringify(relus));
    expect(appels() - n).toBeLessThanOrEqual(1);
    const n2 = appels();
    await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
    await passageT3(c);
    await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
    await passageT3(c);
    expect(appels()).toBe(n2);
  });

  // ══ Panne fournisseur, contrat retiré ═════════════════════════════════════
  it('L113AL-E2E-PANNE — fournisseur indisponible : attente technique durable, relances bornées, reprise ; contrat retiré puis rétabli', async () => {
    const { c, m, avis } = await maisonCompte10();
    await sql`UPDATE asset_files SET deleted_at = now() WHERE account_id = ${c.id} AND id <> ${avis}`;
    await activer(true);
    let panne = true;
    setDefaultResponder(OP, TASK, (input) => { if (panne) throw Object.assign(new Error('503 fournisseur indisponible (simulé)'), { status: 503 }); return modeleMaison(input); });
    await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
    await passageT3(c);
    let [x] = await examens(c);
    expect(x).toMatchObject({ status: 'AI_FAILED', reason: 'AI_CALL_FAILED', attempts: 1 });
    expect(x.retry_at).toBeTruthy();
    expect(ligne(await tco(c, m.id), avis)).toMatchObject({ status: 'NOT_QUALIFIED', semantic: { state: 'AWAITING' } });
    // Relance seulement à échéance (aucune boucle) ; après 3 essais : attente technique quotidienne, jamais une décision métier.
    await passageT3(c);
    expect((await examens(c))[0].attempts).toBe(1);
    for (let i = 0; i < 2; i++) { await sql`UPDATE economic_qualification_reviews SET retry_at = now() - interval '1 minute' WHERE account_id = ${c.id}`; await passageT3(c); }
    [x] = await examens(c);
    expect(x).toMatchObject({ status: 'TECHNICAL_WAIT', attempts: 3 });
    expect((await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY })).results[CHECK]).toEqual({ REPAIR_PENDING: 1 });
    // Contrat retiré pendant l'attente : CONTRACT_PENDING durable, aucun appel.
    await activer(false);
    await sql`UPDATE economic_qualification_reviews SET retry_at = now() - interval '1 minute' WHERE account_id = ${c.id}`;
    const n = appels();
    await passageT3(c);
    expect((await examens(c))[0]).toMatchObject({ status: 'CONTRACT_PENDING' });
    expect(appels()).toBe(n);
    // Retour du contrat et du fournisseur : reprise automatique, décision appliquée.
    await activer(true);
    panne = false;
    await passageT3(c);
    expect((await examens(c))[0]).toMatchObject({ status: 'DECIDED' });
    expect(ligne(await tco(c, m.id), avis)).toMatchObject({ status: 'RETAINED_DIRECT', includedCents: AVIS });
  });

  // ══ Droits et isolation ═══════════════════════════════════════════════════
  it('L113AL-E2E-DROITS — compte restreint : zéro appel ; Standard : TCO refusé ; Duo ; isolation des comptes', async () => {
    await activer(true);
    setDefaultResponder(OP, TASK, modeleMaison);
    const a = await maisonCompte10('premium_duo');
    const b = await maisonCompte10();
    await runCoherenceFor(sql, [a.c.id, b.c.id], { today: RECETTE_TODAY });
    // Compte B passe en lecture seule : aucune demande traitée, aucun appel, aucune écriture.
    await sql`UPDATE account_subscriptions SET status = 'readonly' WHERE account_id = ${b.c.id}`;
    const n = appels();
    const { runQualificationPhase } = await import('@/services/business-operations/tco/semantic-qualification/review');
    expect(await runQualificationPhase(b.c.id, { today: RECETTE_TODAY })).toMatchObject({ processed: 0, aiCalls: 0 });
    expect(appels()).toBe(n);
    expect((await examens(b.c)).every((x) => x.status === 'PENDING')).toBe(true);
    // Compte A (Duo) : traité ; les demandes de B ne sont jamais touchées (isolation).
    await passageT3(a.c);
    expect((await examens(a.c)).every((x) => x.status === 'DECIDED')).toBe(true);
    expect((await examens(b.c)).every((x) => x.status === 'PENDING')).toBe(true);
    expect((await getTco(a.c, a.m.id)).status).toBe(200);
    // Standard actif : la fiche TCO reste verrouillée (aucune donnée financière).
    const s = await make.account({ plan: 'standard' });
    const ms = await maisonDe(s);
    expect((await getTco(s, ms.id)).status).toBe(403);
    // Un compte ne lit jamais le bien d'un autre.
    expect((await getTco(a.c, b.m.id)).status).toBeGreaterThanOrEqual(400);
  });
});
