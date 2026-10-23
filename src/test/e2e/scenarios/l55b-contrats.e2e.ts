/**
 * Lot 55B — T3 / Opérations : rattacher automatiquement toutes les factures
 * d'un même contrat (cas réel « factures d'alarme »). Base PostgreSQL réelle,
 * passerelle IA réelle, MODÈLE SIMULÉ (répondeur déterministe, aucun réseau).
 *
 * Démonstration avant / après : sur la base `lot54`, ces scénarios sont ROUGES
 * (opérations séparées selon la qualification T1, coûts de même montant
 * fusionnés, aucune reprise des documents historiques, `last_reconciled_at`
 * vide) ; avec le lot 55B ils sont verts.
 *
 * Le modèle simulé (`modeleSimule`) répond comme un modèle « bien élevé » à
 * partir des SEULES variables transmises (Objet à rattacher / Candidats) :
 * même prestataire + même bien + preuves périodiques des deux côtés → même
 * réalité ; installation ponctuelle face à un abonnement → distincte ;
 * références de contrat différentes → distincte ; « ambigu » → AMBIGUOUS.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import { setDefaultResponder } from '../replay-gateway';
import type { ProviderCallInput } from '@/services/ai/gateway/providers/provider.port';

const consolidator = () => import('@/services/business-operations/consolidation/consolidator');
const bus = () => import('@/services/business-operations/events');
const AUJOURDHUI = '2026-10-14';
const PRESTATAIRE = 'Télésurveillance Alpha';

type Hint = AnchoredOperationCandidate['financialHints'][number];
const mois = (m: number) => String(m).padStart(2, '0');
const fin = (m: number) => (m === 2 ? '28' : [4, 6, 9, 11].includes(m) ? '30' : '31');

function cand(over: Partial<AnchoredOperationCandidate> = {}): AnchoredOperationCandidate {
  return {
    candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'INTERVENTION', statusHint: 'REALIZED',
    summary: 'Abonnement télésurveillance alarme', sourceRoleHint: 'INVOICE', provider: PRESTATAIRE,
    targetHints: [], businessReferences: [], temporalHints: {}, financialHints: [], evidenceFactRefs: ['f1'],
    visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [], ...over,
  };
}
const cible = (entityId: number) => ({ type: 'ASSET' as const, entityId, rawLabel: null, confidence: 'certain' as const });

/** Mensualité d'alarme (période facturée, échéance, montant) : qualification T1 au choix. */
function mensualite(assetId: number, m: number, o: {
  typeHint?: string | null; ref?: string | null; montant?: number; contrat?: string; date?: boolean; periode?: boolean; summary?: string;
} = {}): AnchoredOperationCandidate {
  const periode = o.periode !== false;
  const h: Hint = {
    role: 'REALIZED_COST', amountMinor: o.montant ?? 3990, currency: 'EUR', amountScope: 'INSTALLMENT',
    economicDate: o.date === false ? null : `2026-${mois(m)}-05`,
    periodStart: periode ? `2026-${mois(m)}-01` : null, periodEnd: periode ? `2026-${mois(m)}-${fin(m)}` : null, factRef: 'f1',
  } as Hint;
  const refs = [
    ...(o.ref === null ? [] : [{ kind: 'INVOICE' as const, value: o.ref ?? `FA-2026-${mois(m)}` }]),
    ...(o.contrat ? [{ kind: 'CONTRACT' as const, value: o.contrat }] : []),
  ];
  return cand({
    typeHint: (o.typeHint === undefined ? 'INTERVENTION' : o.typeHint) as AnchoredOperationCandidate['typeHint'],
    summary: o.summary ?? `Abonnement télésurveillance alarme — ${mois(m)}/2026`,
    targetHints: [cible(assetId)], businessReferences: refs,
    temporalHints: periode ? { startDate: `2026-${mois(m)}-01`, endDate: `2026-${mois(m)}-${fin(m)}` } : {},
    financialHints: [h],
  });
}

// ── Modèle simulé (OPERATION_MATCH) ─────────────────────────────────────────

const json = (prompt: string, label: string): any => {
  const i = prompt.indexOf(`${label} : `);
  if (i < 0) return null;
  return JSON.parse(prompt.slice(i + label.length + 3).split('\n')[0]);
};
const contrats = (refs: string[] = []) => refs.filter((r) => r.startsWith('CONTRACT:')).map((r) => r.slice(9).toUpperCase());
const periodique = (texte: string) => /abonnement|mensualit|t[ée]l[ée]surveillance/i.test(texte);
export function modeleSimule(input: ProviderCallInput): unknown {
  const sujet = json(input.prompt, 'Objet à rattacher');
  const candidats = json(input.prompt, 'Candidats') as any[];
  const base = { task: 'OPERATION_MATCH', concordantSignals: ['même prestataire', 'même bien', 'factures périodiques'], contradictions: [] as string[] };
  if (!sujet || !Array.isArray(candidats)) return { ...base, decision: 'AMBIGUOUS', matchedCandidateId: null, confidence: 'probable', reason: 'contexte illisible' };
  const s = sujet.candidate;
  if (/ambigu/i.test(s.summary)) return { ...base, decision: 'AMBIGUOUS', matchedCandidateId: null, confidence: 'probable', reason: 'éléments insuffisants' };
  const sPeriodique = periodique(s.summary) || (Array.isArray(s.periods) && s.periods.length > 0);
  const memes = candidats.filter((c) => {
    if ((c.provider ?? '').toLowerCase() !== (s.provider ?? '').toLowerCase()) return false;
    if (!c.assets.some((a: string) => s.assets.includes(a))) return false;
    const cs = contrats(s.references); const cc = contrats(c.references);
    if (cs.length && cc.length && !cs.some((x) => cc.includes(x))) return false;
    const cPeriodique = c.type === 'CONTRACT' || (Array.isArray(c.periods) && c.periods.length > 0)
      || c.documents.some((d: any) => periodique(`${d.title} ${d.summary ?? ''}`));
    return sPeriodique && cPeriodique;
  });
  if (memes.length === 1) return { ...base, decision: 'SAME_OPERATION', matchedCandidateId: memes[0].candidateId, confidence: 'certain', reason: 'échéance du même abonnement' };
  if (memes.length > 1) return { ...base, decision: 'AMBIGUOUS', matchedCandidateId: null, confidence: 'probable', reason: 'plusieurs contrats compatibles' };
  return { ...base, decision: 'DISTINCT_OPERATION', matchedCandidateId: null, confidence: 'certain', reason: 'autre prestation' };
}

scenario('L55B', 'T3 — toutes les factures d’un même contrat rattachées (factures d’alarme)', ({ sql, make, replay }) => {
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
    setDefaultResponder('t3_operation_match', 'OPERATION_MATCH', modeleSimule);
  });
  afterAll(() => { setDefaultResponder('t3_operation_match', 'OPERATION_MATCH', null); });
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
    (await consolidator()).setT3FaultHookForTests(null);
  });

  async function document(compte: AccountRow, assetId: number, candidats: AnchoredOperationCandidate[], titre?: string) {
    const f = await make.assetFile(compte, { assetId });
    if (titre) await sql`UPDATE asset_files SET retained_title = ${titre} WHERE id = ${f.id}`;
    const [x] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id) VALUES (${compte.id}, ${f.id}) RETURNING id`;
    const { replaceOperationCandidates } = await import('@/services/ai/source-analysis/operation-candidates/persist');
    const { pgClient } = await import('@/db');
    await pgClient.begin(async (tx) => {
      await replaceOperationCandidates(tx as never, { accountId: compte.id, fileId: f.id, extractionId: x.id, analysisRunId: null, reanalysis: false, candidates: candidats, facts: new Map() });
    });
    return f.id;
  }
  const passer = async (compte: AccountRow) => (await consolidator()).consolidateAccountOperations(compte.id, { today: AUJOURDHUI });
  /** Passages T3 successifs (balayage horaire) jusqu'à stabilité : aucun changement, aucun M3 dû. */
  async function stabiliser(compte: AccountRow, max = 8) {
    let n = 0;
    for (let i = 0; i < max; i++) {
      const r = await passer(compte);
      n++;
      if (r.changes === 0 && !(r.m3?.calls) && !r.remaining) {
        const [p] = await sql`SELECT 1 FROM document_operation_candidates WHERE account_id = ${compte.id} AND t3_pending LIMIT 1`;
        if (!p) break;
      }
    }
    return n;
  }
  const actives = (compte: AccountRow) => sql<{ id: number; type_code: string | null; start_date: string | null; end_date: string | null; last_reconciled_at: Date | null }[]>`
    SELECT id::int AS id, type_code, start_date::text AS start_date, end_date::text AS end_date, last_reconciled_at
      FROM business_operations WHERE account_id = ${compte.id} AND invalidated_at IS NULL AND merged_into_operation_id IS NULL ORDER BY id`;
  const sources = (opId: number) => sql<{ file: number }[]>`
    SELECT source_entity_key::int AS file FROM business_operation_sources WHERE operation_id = ${opId} AND active AND source_kind = 'DOCUMENT' ORDER BY 1`;
  const couts = (opId: number) => sql<{ kind: string; amount_minor: number; period_start: string | null }[]>`
    SELECT kind, amount_minor::int AS amount_minor, period_start::text AS period_start FROM business_operation_financial_components
     WHERE operation_id = ${opId} AND active ORDER BY period_start NULLS LAST, id`;
  const candidat = async (fileId: number) => (await sql<{ t3_outcome: string; t3_reason: string; t3_operation_id: number | null; t3_detail: Record<string, any>; t3_pending: boolean }[]>`
    SELECT t3_outcome, t3_reason, t3_operation_id::int AS t3_operation_id, t3_detail, t3_pending FROM document_operation_candidates WHERE file_id = ${fileId} AND status = 'ACTIVE'`)[0];
  const historique = (compte: AccountRow) => sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_history WHERE account_id = ${compte.id}`;
  /** Forme comparable d'un compte (indépendante des identifiants). */
  async function forme(compte: AccountRow) {
    const out = [];
    for (const o of await actives(compte)) {
      out.push({ type: o.type_code, debut: o.start_date, fin: o.end_date, sources: (await sources(o.id)).length, couts: (await couts(o.id)).map((c) => `${c.kind}:${c.amount_minor}:${c.period_start}`) });
    }
    return out.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  const maisonDe = async (compte: AccountRow) => make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });

  it('L55B-01 / F-111 / F-059 — trois mensualités d’alarme (qualifiées CONTRACT / INTERVENTION / sans type par T1) : UNE opération CONTRACT, 3 sources, 3 coûts', async () => {
    const compte = await make.account();
    const maison = await maisonDe(compte);
    const f1 = await document(compte, maison.id, [mensualite(maison.id, 1, { typeHint: 'CONTRACT' })], 'Facture alarme janvier');
    const f2 = await document(compte, maison.id, [mensualite(maison.id, 2, { typeHint: 'INTERVENTION' })], 'Facture alarme février');
    const f3 = await document(compte, maison.id, [mensualite(maison.id, 3, { typeHint: null })], 'Facture alarme mars');
    await stabiliser(compte);
    const ops = await actives(compte);
    expect(ops.map((o) => o.type_code)).toEqual(['CONTRACT']);
    expect((await sources(ops[0].id)).map((s) => s.file)).toEqual([f1, f2, f3]);
    expect(await couts(ops[0].id)).toEqual([
      { kind: 'REALIZED_COST', amount_minor: 3990, period_start: '2026-01-01' },
      { kind: 'REALIZED_COST', amount_minor: 3990, period_start: '2026-02-01' },
      { kind: 'REALIZED_COST', amount_minor: 3990, period_start: '2026-03-01' },
    ]);
    for (const f of [f2, f3]) expect(await candidat(f)).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_operation_id: ops[0].id });
    // Le contexte transmis au modèle porte les périodes facturées (enrichissement, prompt inchangé).
    const appel = replay.calls.find((c) => c.operationCode === 't3_operation_match');
    expect(appel?.prompt).toContain('"periods"');
    expect(appel?.prompt).toContain('2026-02-01');
  });

  it('L55B-02 / F-111 — même montant mensuel, sans numéro de facture : aucune fusion des mensualités (dates / périodes distinctes)', async () => {
    const compte = await make.account();
    const maison = await maisonDe(compte);
    for (const m of [4, 5, 6]) await document(compte, maison.id, [mensualite(maison.id, m, { ref: null, typeHint: 'CONTRACT' })]);
    await stabiliser(compte);
    const [op, ...autres] = await actives(compte);
    expect(autres).toEqual([]);
    expect((await couts(op.id)).map((c) => c.amount_minor)).toEqual([3990, 3990, 3990]);
    // Ni référence, ni date, ni période : aucun coût additionné d'office, aucun coût effacé — montant tenu hors total.
    const c2 = await make.account();
    const m2 = await maisonDe(c2);
    await document(c2, m2.id, [mensualite(m2.id, 7, { ref: null, date: false, periode: false, typeHint: 'CONTRACT', contrat: 'ALR-77' })]);
    await document(c2, m2.id, [mensualite(m2.id, 8, { ref: null, date: false, periode: false, typeHint: 'CONTRACT', contrat: 'ALR-77' })]);
    await stabiliser(c2);
    const [o2, ...x2] = await actives(c2);
    expect(x2).toEqual([]);
    expect((await couts(o2.id)).map((c) => c.amount_minor)).toEqual([3990]);
    const cote = await sql<{ nature: string; amount_minor: number }[]>`SELECT nature, amount_minor::int AS amount_minor FROM business_operation_side_amounts WHERE operation_id = ${o2.id}`;
    expect(cote).toEqual([{ nature: 'UNCERTAIN_DUPLICATE', amount_minor: 3990 }]);
  });

  it('L55B-03 / F-032 — doublon documentaire : deux copies de la même facture → deux sources, UN coût (même si une copie n’a pas son numéro lu)', async () => {
    const compte = await make.account();
    const maison = await maisonDe(compte);
    await document(compte, maison.id, [mensualite(maison.id, 1, { typeHint: 'CONTRACT' })], 'Facture alarme janvier');
    await document(compte, maison.id, [mensualite(maison.id, 1, { typeHint: 'CONTRACT' })], 'Facture alarme janvier (copie)');
    await document(compte, maison.id, [mensualite(maison.id, 1, { typeHint: 'CONTRACT', ref: null })], 'Scan facture janvier');
    await stabiliser(compte);
    const [op, ...autres] = await actives(compte);
    expect(autres).toEqual([]);
    expect(await sources(op.id)).toHaveLength(3);
    expect((await couts(op.id)).map((c) => c.amount_minor)).toEqual([3990]);
  });

  it('L55B-04 — contrat absent : des factures d’abonnement qualifiées « intervention » constituent et enrichissent UNE opération CONTRACT', async () => {
    const compte = await make.account();
    const maison = await maisonDe(compte);
    for (const m of [1, 2, 3]) await document(compte, maison.id, [mensualite(maison.id, m, { typeHint: 'INTERVENTION', contrat: 'ALR-2026-55' })]);
    await stabiliser(compte);
    const ops = await actives(compte);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type_code: 'CONTRACT', start_date: '2026-01-01', end_date: '2026-03-31' });
    const [d] = await sql`SELECT contract_reference, effective_from::text AS effective_from FROM business_operation_contract_details WHERE operation_id = ${ops[0].id}`;
    expect(d).toMatchObject({ contract_reference: 'ALR-2026-55', effective_from: '2026-01-01' });
    const [h] = await sql`SELECT reason_code FROM business_operation_history WHERE operation_id = ${ops[0].id} AND event_type = 'TYPE_CHANGED'`;
    expect(h?.reason_code).toBe('T3_TYPE_RECURRING_CONTRACT');
  });

  it('L55B-05 — import désordonné : même résultat quel que soit l’ordre d’importation', async () => {
    const ordres = [[1, 2, 3], [3, 1, 2], [2, 3, 1]];
    const formes = [];
    for (const ordre of ordres) {
      const compte = await make.account();
      const maison = await maisonDe(compte);
      const types: Record<number, string | null> = { 1: 'CONTRACT', 2: 'INTERVENTION', 3: null };
      for (const m of ordre) await document(compte, maison.id, [mensualite(maison.id, m, { typeHint: types[m] })]);
      await stabiliser(compte);
      formes.push(await forme(compte));
    }
    expect(formes[0]).toHaveLength(1);
    expect(formes[1]).toEqual(formes[0]);
    expect(formes[2]).toEqual(formes[0]);
  });

  it('L55B-06 / F-050 / F-175 / INV-041 — documents historiques : les factures déjà analysées (opérations séparées du lot 54) sont reprises rétroactivement par le rattrapage initial (migration 0398 + balayage)', async () => {
    const compte = await make.account();
    const maison = await maisonDe(compte);
    // État laissé par le lot 54 : une opération par facture, candidats déjà traités (CREATE_NEW).
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    const fichiers: number[] = [];
    const types: Record<number, 'CONTRACT' | 'INTERVENTION'> = { 1: 'CONTRACT', 2: 'INTERVENTION', 3: 'INTERVENTION' };
    for (const m of [1, 2, 3]) {
      const f = await document(compte, maison.id, [mensualite(maison.id, m, { typeHint: types[m] })]);
      fichiers.push(f);
      const [c] = await sql<{ id: number; version: string }[]>`
        SELECT c.id, ('c' || c.id || '|a' || COALESCE(f.asset_id, f.linked_asset_id, 0) || '|t' || COALESCE(f.document_type_code, '')) AS version
          FROM document_operation_candidates c JOIN asset_files f ON f.id = c.file_id WHERE c.file_id = ${f}`;
      const op = await withBusinessOperationWrite(compte.id, (repo) => repo.create({
        type: { code: types[m] }, status: 'REALIZED', startDate: `2026-${mois(m)}-01`, provider: PRESTATAIRE, technicalLabel: 'Abonnement télésurveillance alarme',
        source: { kind: 'DOCUMENT', entityKey: f, version: c.version, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain', locator: { candidateKey: 'op1' }, matchMethod: null, matchReason: 'NO_MATCH_ESTABLISHED' },
        assets: [{ assetId: maison.id, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'T3_CREATE_NEW',
      }));
      await sql`UPDATE document_operation_candidates SET t3_pending = false, t3_outcome = 'CREATE_NEW', t3_reason = 'NO_MATCH_ESTABLISHED', t3_operation_id = ${op.id}, t3_detail = '{}'::jsonb WHERE id = ${c.id}`;
    }
    expect(await actives(compte)).toHaveLength(3);
    // Rien de « sale » : sans rattrapage, le balayage ne reprendrait rien.
    // Rattrapage initial automatique : migration livrée (idempotente) puis balayage horaire.
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0398_operations_t3_contract_retro.sql'), 'utf8');
    await sql.unsafe(migration);
    await sql.unsafe(migration);
    const marques = await sql`SELECT 1 FROM document_operation_candidates WHERE account_id = ${compte.id} AND t3_pending`;
    expect(marques.length).toBeGreaterThanOrEqual(2);
    await stabiliser(compte);
    const ops = await actives(compte);
    expect(ops.map((o) => o.type_code)).toEqual(['CONTRACT']);
    expect((await sources(ops[0].id)).map((s) => s.file)).toEqual(fichiers);
    expect((await couts(ops[0].id)).map((c) => c.amount_minor)).toEqual([3990, 3990, 3990]);
    // Historique conservé : opérations absorbées redirigées (MERGED), jamais supprimées.
    const fusions = await sql`SELECT 1 FROM business_operations WHERE account_id = ${compte.id} AND merged_into_operation_id = ${ops[0].id}`;
    expect(fusions).toHaveLength(2);
    for (const f of fichiers) expect((await candidat(f)).t3_operation_id).toBe(ops[0].id);
    // Reprise terminée : plus de marque de réexamen, un nouveau passage ne fait rien.
    expect(await sql`SELECT 1 FROM document_operation_candidates WHERE account_id = ${compte.id} AND (t3_pending OR t3_detail ? 'retroRequested')`).toHaveLength(0);
  });

  it('L55B-07 — deux contrats du même fournisseur (références différentes, ou modèle « distinct ») : aucune fusion injustifiée', async () => {
    const compte = await make.account();
    const maison = await maisonDe(compte);
    for (const m of [1, 2]) await document(compte, maison.id, [mensualite(maison.id, m, { typeHint: 'CONTRACT', contrat: 'ALR-100' })]);
    for (const m of [1, 2]) await document(compte, maison.id, [mensualite(maison.id, m, { typeHint: 'CONTRACT', contrat: 'ALR-200', ref: `FB-2026-${mois(m)}`, montant: 1290, summary: `Abonnement télésurveillance garage — ${mois(m)}/2026` })]);
    await stabiliser(compte);
    const ops = await actives(compte);
    expect(ops.map((o) => o.type_code)).toEqual(['CONTRACT', 'CONTRACT']);
    for (const o of ops) expect(await sources(o.id)).toHaveLength(2);
    expect((await sql`SELECT 1 FROM business_operation_history WHERE account_id = ${compte.id} AND event_type = 'MERGED'`)).toHaveLength(0);
  });

  it('L55B-08 / F-033 — installation puis abonnement : deux réalités distinctes (intervention ponctuelle + contrat)', async () => {
    const compte = await make.account();
    const maison = await maisonDe(compte);
    await document(compte, maison.id, [cand({
      typeHint: 'INTERVENTION', summary: 'Installation du système d’alarme', targetHints: [cible(maison.id)],
      businessReferences: [{ kind: 'INVOICE', value: 'FA-2025-12' }], temporalHints: { realizedDate: '2025-12-15' },
      financialHints: [{ role: 'REALIZED_COST', amountMinor: 45000, currency: 'EUR', amountScope: 'TOTAL', economicDate: '2025-12-15', periodStart: null, periodEnd: null, factRef: 'f1' } as Hint],
    })], 'Facture installation alarme');
    for (const m of [1, 2]) await document(compte, maison.id, [mensualite(maison.id, m, { typeHint: 'INTERVENTION' })]);
    await stabiliser(compte);
    const ops = await actives(compte);
    expect(ops.map((o) => o.type_code).sort()).toEqual(['CONTRACT', 'INTERVENTION']);
    const inter = ops.find((o) => o.type_code === 'INTERVENTION')!;
    const contrat = ops.find((o) => o.type_code === 'CONTRACT')!;
    expect((await couts(inter.id)).map((c) => c.amount_minor)).toEqual([45000]);
    expect((await couts(contrat.id)).map((c) => c.amount_minor)).toEqual([3990, 3990]);
  });

  it('L55B-09 / F-058 / INV-FINAL-005 — ambiguïté (deux contrats compatibles) : aucune association financière arbitraire, arbitrage utilisateur', async () => {
    const compte = await make.account();
    const maison = await maisonDe(compte);
    await document(compte, maison.id, [mensualite(maison.id, 1, { typeHint: 'CONTRACT', contrat: 'ALR-1' })]);
    await document(compte, maison.id, [mensualite(maison.id, 1, { typeHint: 'CONTRACT', contrat: 'ALR-2', ref: 'FB-1', montant: 2590 })]);
    await stabiliser(compte);
    expect(await actives(compte)).toHaveLength(2);
    const avant = await sql`SELECT id FROM business_operation_financial_components WHERE account_id = ${compte.id} AND active ORDER BY id`;
    const f = await document(compte, maison.id, [mensualite(maison.id, 2, { typeHint: null, ref: 'FX-9', montant: 1990, summary: 'Abonnement alarme (ambigu)' })]);
    await stabiliser(compte);
    expect(await candidat(f)).toMatchObject({ t3_outcome: 'ARBITRATION_REQUIRED', t3_reason: 'M3_AMBIGUOUS', t3_operation_id: null });
    expect(await sql`SELECT id FROM business_operation_financial_components WHERE account_id = ${compte.id} AND active ORDER BY id`).toEqual(avant);
    const cartes = await sql`SELECT target_id FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'OPERATION-MATCH' AND resolved_at IS NULL`;
    expect(cartes.map((c) => Number(c.target_id))).toEqual([f]);
  });

  it('L55B-10 / INV-039 — nouvelle exécution T3 (balayage + reconsolidation complète BO) : aucune duplication, last_reconciled_at alimenté sans historique artificiel', async () => {
    const compte = await make.account();
    const maison = await maisonDe(compte);
    for (const m of [1, 2, 3]) await document(compte, maison.id, [mensualite(maison.id, m, { typeHint: 'CONTRACT' })]);
    await stabiliser(compte);
    const avant = await forme(compte);
    const [op] = await actives(compte);
    expect(op.last_reconciled_at).not.toBeNull();
    const h0 = (await historique(compte))[0].n;
    const appels = replay.calls.length;
    const r = await passer(compte);
    expect(r.changes).toBe(0);
    const { reconsolidateAllActiveOperations } = await import('@/services/business-operations/consolidation/queue');
    const t0 = op.last_reconciled_at!;
    expect((await reconsolidateAllActiveOperations(compte.id, { today: AUJOURDHUI })).changes).toBe(0);
    expect(await forme(compte)).toEqual(avant);
    expect((await historique(compte))[0].n).toBe(h0);
    expect(replay.calls.length).toBe(appels);
    const [apres] = await actives(compte);
    expect(new Date(apres.last_reconciled_at!).getTime()).toBeGreaterThanOrEqual(new Date(t0).getTime());
  });

  it('L55B-11 — échec d’exécution : reprise automatique, et le BO ne présente jamais un résultat partiel comme définitif', async () => {
    const compte = await make.account();
    const maison = await maisonDe(compte);
    await document(compte, maison.id, [mensualite(maison.id, 1, { typeHint: 'CONTRACT' })]);
    await stabiliser(compte);
    const [op] = await actives(compte);
    const f2 = await document(compte, maison.id, [mensualite(maison.id, 2, { typeHint: 'INTERVENTION' })]);
    const { setT3FaultHookForTests } = await consolidator();
    const { BusinessOperationIntegrityError } = await import('@/services/business-operations/errors');
    setT3FaultHookForTests((stage, ctx) => { if (stage === 'document' && ctx.fileId === f2) throw new BusinessOperationIntegrityError('INVALID_DETAILS', 'panne simulée'); });
    await passer(compte);
    expect(await candidat(f2)).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'TECHNICAL_ERROR:INVALID_DETAILS' });
    const { OperationDiagnosticsService } = await import('@/services/business-operations/diagnostics/service');
    const exec = async <T>(fn: (q: (t: string, p?: unknown[]) => Promise<any[]>) => Promise<T>) => fn((t, p) => sql.unsafe(t, (p ?? []) as never[]) as never);
    const svc = new OperationDiagnosticsService(exec as never);
    // Le document en échec n'est rattaché à rien : l'opération du compte n'est pas « à jour ».
    const d1 = await svc.detail(op.id);
    expect(d1!.reconciliation.state).not.toBe('A_JOUR');
    expect(d1!.reconciliation.blocked).toBeGreaterThanOrEqual(1);
    setT3FaultHookForTests(null);
    await sql`UPDATE document_operation_candidates SET t3_retry_at = now() - interval '1 minute' WHERE file_id = ${f2}`;
    await stabiliser(compte);
    expect(await candidat(f2)).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_operation_id: op.id });
    const d2 = await svc.detail(op.id);
    expect(d2!.reconciliation.state).toBe('A_JOUR');
    expect(d2!.operation.activeSourceCount).toBe(2);
    expect(d2!.operation.componentCount).toBe(2);
    expect(d2!.operation.lastReconciledAt).not.toBeNull();
    expect(d2!.candidates.every((c: Record<string, unknown>) => typeof c.ai_label === 'string')).toBe(true);
    // Branche IA nécessaire présente dans la configuration active (prompt livré).
    expect(d2!.operationMatchBranch).toMatchObject({ available: true });
  });

  it('L55B-12 — deux comptes différents : aucun rapprochement, aucune fusion ni marque de reprise inter-comptes', async () => {
    const a = await make.account();
    const b = await make.account();
    const ma = await maisonDe(a);
    const mb = await maisonDe(b);
    await document(a, ma.id, [mensualite(ma.id, 1, { typeHint: 'CONTRACT' })]);
    await stabiliser(a);
    const [opA] = await actives(a);
    await document(b, mb.id, [mensualite(mb.id, 2, { typeHint: 'INTERVENTION' })]);
    await document(b, mb.id, [mensualite(mb.id, 3, { typeHint: null })]);
    await stabiliser(b);
    const opsB = await actives(b);
    expect(opsB).toHaveLength(1);
    expect(opsB[0].id).not.toBe(opA.id);
    expect(await sources(opA.id)).toHaveLength(1);
    // Aucun lien vers une opération de l'autre compte (candidats, sources, contexte IA).
    const croises = await sql`
      SELECT 1 FROM document_operation_candidates c JOIN business_operations o ON o.id = c.t3_operation_id
       WHERE c.account_id <> o.account_id AND c.account_id IN (${a.id}, ${b.id})`;
    expect(croises).toHaveLength(0);
    for (const call of replay.calls.filter((c) => c.operationCode === 't3_operation_match')) {
      const cands = json(call.prompt, 'Candidats') as Array<{ candidateId: number }>;
      const ids = cands.map((c) => c.candidateId);
      const comptes = await sql`SELECT DISTINCT account_id FROM business_operations WHERE id = ANY(${ids}::bigint[])`;
      expect(comptes.length).toBeLessThanOrEqual(1);
    }
  });
});
