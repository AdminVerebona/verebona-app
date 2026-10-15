/**
 * Lot 56A — Documents → Opérations : supprimer les arbitrages inutiles grâce
 * à l'IA (issues RATTACHER / ARBITRER / DISTINCT), réexaminer les questions
 * ouvertes, libellé « Oui ». Base PostgreSQL réelle, passerelle IA réelle,
 * MODÈLE SIMULÉ (aucun réseau).
 *
 * Le modèle simulé lit SEULEMENT les variables transmises (Objet à rattacher /
 * Candidats) :
 *   · prompt SANS l'issue explicite (version BO antérieure au lot 56A), ou
 *     mode « prudent » forcé : il répond comme observé en préproduction —
 *     SAME_OPERATION mais seulement « probable » (aucune preuve formelle du
 *     contrat) — ce qui produisait la carte « même contrat ? » ;
 *   · prompt du lot 56A : il décide ATTACH / ARBITRATE / DISTINCT selon les
 *     éléments POSITIFS fournis (prestataire, bien, échéances, numéro d'abonné
 *     lu dans les extraits T1) et ce qui les contredit.
 * Aucune donnée « Homiris » : le cas est rejoué avec un prestataire fictif.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import { setDefaultResponder } from '../replay-gateway';
import type { ProviderCallInput } from '@/services/ai/gateway/providers/provider.port';

const consolidator = () => import('@/services/business-operations/consolidation/consolidator');
const bus = () => import('@/services/business-operations/events');
const AUJOURDHUI = '2026-10-14';

type Hint = AnchoredOperationCandidate['financialHints'][number];
const mois = (m: number) => String(m).padStart(2, '0');
const fin = (m: number) => (m === 2 ? '28' : [4, 6, 9, 11].includes(m) ? '30' : '31');
const cible = (entityId: number) => ({ type: 'ASSET' as const, entityId, rawLabel: null, confidence: 'certain' as const });

/** Échéance mensuelle d'un abonnement (T1 la qualifie souvent « intervention »). */
function echeance(assetId: number | null, m: number, o: {
  prestataire?: string; montant?: number; typeHint?: string | null; summary?: string; ref?: string;
} = {}): AnchoredOperationCandidate {
  const h: Hint = {
    role: 'REALIZED_COST', amountMinor: o.montant ?? 3990, currency: 'EUR', amountScope: 'INSTALLMENT',
    economicDate: `2026-${mois(m)}-05`, periodStart: `2026-${mois(m)}-01`, periodEnd: `2026-${mois(m)}-${fin(m)}`, factRef: 'f1',
  } as Hint;
  return {
    candidateKey: 'op1', established: true, confidence: 'certain',
    typeHint: (o.typeHint === undefined ? 'INTERVENTION' : o.typeHint) as AnchoredOperationCandidate['typeHint'], statusHint: 'REALIZED',
    summary: o.summary ?? `Abonnement télésurveillance — ${mois(m)}/2026`, sourceRoleHint: 'INVOICE', provider: o.prestataire ?? 'Sécurité Gamma',
    targetHints: assetId === null ? [] : [cible(assetId)], businessReferences: [{ kind: 'INVOICE', value: o.ref ?? `FA-2026-${mois(m)}-${assetId ?? 0}` }],
    temporalHints: { startDate: `2026-${mois(m)}-01`, endDate: `2026-${mois(m)}-${fin(m)}` }, financialHints: [h], evidenceFactRefs: ['f1'],
    visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [],
  } as AnchoredOperationCandidate;
}

// ── Modèle simulé ───────────────────────────────────────────────────────────

const json = (prompt: string, label: string): any => {
  const i = prompt.indexOf(`${label} : `);
  if (i < 0) return null;
  return JSON.parse(prompt.slice(i + label.length + 3).split('\n')[0]);
};
const abonne = (extraits: string[] | undefined) => (extraits ?? []).map((e) => /abonn[ée]\s*:\s*([\w-]+)/i.exec(e)?.[1]).find(Boolean) ?? null;
let prudent = false;
function modele(input: ProviderCallInput): unknown {
  const sujet = json(input.prompt, 'Objet à rattacher');
  const candidats = (json(input.prompt, 'Candidats') ?? []) as any[];
  const s = sujet.candidate;
  const sAbonne = abonne(sujet.document?.excerpts);
  const evalue = candidats.map((c) => {
    const pour: string[] = [];
    const contre: string[] = [];
    if ((c.provider ?? '').toLowerCase() === (s.provider ?? '').toLowerCase()) pour.push('même prestataire'); else contre.push('autre prestataire');
    if (s.assets.length && c.assets.length) {
      if (c.assets.some((a: string) => s.assets.includes(a))) pour.push('même bien'); else contre.push('autre bien');
    }
    const cAbonne = abonne(c.excerpts);
    if (sAbonne && cAbonne) { if (sAbonne === cAbonne) pour.push('même numéro d’abonné'); else contre.push('autre numéro d’abonné'); }
    if ((s.periods ?? []).length && ((c.periods ?? []).length || c.type === 'CONTRACT')) pour.push('échéances successives');
    return { id: c.candidateId, pour, contre };
  });
  const base = { task: 'OPERATION_MATCH', reason: 'analyse des éléments fournis' };
  const compatibles = evalue.filter((e) => !e.contre.length && e.pour.length >= 2);
  if (prudent || !input.prompt.includes('"resolution"')) {
    // Comportement observé avec le prompt antérieur : jamais « certain » sans preuve formelle du contrat.
    if (compatibles.length === 1) return { ...base, decision: 'SAME_OPERATION', matchedCandidateId: compatibles[0].id, confidence: 'probable', concordantSignals: compatibles[0].pour, contradictions: [] };
    return { ...base, decision: 'AMBIGUOUS', matchedCandidateId: null, confidence: 'probable', concordantSignals: [], contradictions: [] };
  }
  if (/ambigu/i.test(s.summary)) return { ...base, resolution: 'ARBITRATE', decision: 'AMBIGUOUS', matchedCandidateId: null, confidence: 'probable', concordantSignals: [], contradictions: [] };
  // Un seul candidat compatible, désigné par des éléments POSITIFS distinctifs (le seul prestataire ne suffit pas).
  const distinctif = (e: { pour: string[] }) => e.pour.some((p) => p !== 'même prestataire');
  if (compatibles.length === 1 && distinctif(compatibles[0])) {
    return { ...base, resolution: 'ATTACH', decision: 'SAME_OPERATION', matchedCandidateId: compatibles[0].id, confidence: 'probable', concordantSignals: compatibles[0].pour, contradictions: [] };
  }
  if (compatibles.length >= 1) {
    return { ...base, resolution: 'ARBITRATE', decision: 'AMBIGUOUS', matchedCandidateId: null, confidence: 'probable', concordantSignals: ['même prestataire'], contradictions: [] };
  }
  return { ...base, resolution: 'DISTINCT', decision: 'DISTINCT_OPERATION', matchedCandidateId: null, confidence: 'certain', concordantSignals: [], contradictions: evalue.flatMap((e) => e.contre).slice(0, 5) };
}

scenario('L56A', 'Documents → Opérations — arbitrages inutiles supprimés par l’IA, libellé « Oui »', ({ sql, make, replay }) => {
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
    setDefaultResponder('t3_operation_match', 'OPERATION_MATCH', modele);
  });
  afterAll(() => { setDefaultResponder('t3_operation_match', 'OPERATION_MATCH', null); });
  afterEach(async () => {
    prudent = false;
    (await bus()).resetBusinessOperationEventBusForTests();
  });

  async function document(compte: AccountRow, assetId: number | null, candidats: AnchoredOperationCandidate[], o: { titre?: string; abonne?: string } = {}) {
    const f = await make.assetFile(compte, { assetId });
    if (o.titre) await sql`UPDATE asset_files SET retained_title = ${o.titre} WHERE id = ${f.id}`;
    const [x] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id) VALUES (${compte.id}, ${f.id}) RETURNING id`;
    // Couche exhaustive T1 (document_source_units) : ce que T1 a lu sans le structurer.
    if (o.abonne) {
      await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, page, ordinal, label, value_text, coverage_status, salient)
                VALUES (${compte.id}, ${f.id}, ${x.id}, 'u1', 'LABEL_VALUE', 1, 1, 'N° d''abonné', ${o.abonne}, 'COVERED', true),
                       (${compte.id}, ${f.id}, ${x.id}, 'u2', 'TABLE_ROW', 1, 2, NULL, NULL, 'COVERED', false)`;
      await sql`UPDATE document_source_units SET content_text = 'Formule Sérénité — télésurveillance 24/7 — 39,90 €' WHERE file_id = ${f.id} AND source_unit_id = 'u2'`;
    }
    const { replaceOperationCandidates } = await import('@/services/ai/source-analysis/operation-candidates/persist');
    const { pgClient } = await import('@/db');
    await pgClient.begin(async (tx) => {
      await replaceOperationCandidates(tx as never, { accountId: compte.id, fileId: f.id, extractionId: x.id, analysisRunId: null, reanalysis: false, candidates: candidats, facts: new Map() });
    });
    return f.id;
  }
  let version = 'v-depot';
  const passer = async (compte: AccountRow) => (await consolidator()).consolidateAccountOperations(compte.id, {
    today: AUJOURDHUI, reevaluateHolds: true, operationMatch: { promptStatus: async () => ({ available: true, version }) },
  });
  async function stabiliser(compte: AccountRow, max = 8) {
    for (let i = 0; i < max; i++) {
      const r = await passer(compte);
      if (r.changes === 0 && !(r.m3?.calls) && !r.remaining) {
        const [p] = await sql`SELECT 1 FROM document_operation_candidates WHERE account_id = ${compte.id} AND t3_pending LIMIT 1`;
        if (!p) break;
      }
    }
  }
  const actives = (compte: AccountRow) => sql<{ id: number; type_code: string | null }[]>`
    SELECT id::int AS id, type_code FROM business_operations WHERE account_id = ${compte.id} AND invalidated_at IS NULL AND merged_into_operation_id IS NULL ORDER BY id`;
  const sources = (opId: number) => sql<{ file: number; match_method: string | null }[]>`
    SELECT source_entity_key::int AS file, match_method FROM business_operation_sources WHERE operation_id = ${opId} AND active AND source_kind = 'DOCUMENT' ORDER BY 1`;
  const candidat = async (fileId: number) => (await sql<{ t3_outcome: string; t3_reason: string; t3_operation_id: number | null; t3_detail: Record<string, any> }[]>`
    SELECT t3_outcome, t3_reason, t3_operation_id::int AS t3_operation_id, t3_detail FROM document_operation_candidates WHERE file_id = ${fileId} AND status = 'ACTIVE'`)[0];
  const cartes = (compte: AccountRow, ouvertes = true) => sql<{ id: number; public_id: string; target_id: number; question: string; proposals_json: any[]; resolution_reason: string | null }[]>`
    SELECT id, public_id, target_id::int AS target_id, question, proposals_json, resolution_reason FROM to_process_actions
     WHERE account_id = ${compte.id} AND rule_code = 'OPERATION-MATCH' AND (resolved_at IS NULL) = ${ouvertes} ORDER BY id`;
  const appelsM3 = () => replay.calls.filter((c) => c.operationCode === 't3_operation_match').length;
  const maison = (compte: AccountRow, name = 'Maison') => make.asset(compte, { category: 'IMMOBILIER', name });

  it('L56A-01 — cas « factures d’un même abonnement de télésurveillance » (même prestataire, même tarif, périodes successives) : rattachées par l’IA, AUCUNE carte', async () => {
    version = 'v-depot';
    const compte = await make.account();
    const m = await maison(compte);
    const f1 = await document(compte, m.id, [echeance(m.id, 1)], { titre: 'Facture télésurveillance janvier', abonne: '4471-22' });
    const f2 = await document(compte, m.id, [echeance(m.id, 2)], { titre: 'Facture télésurveillance février', abonne: '4471-22' });
    const f3 = await document(compte, m.id, [echeance(m.id, 3, { typeHint: null })], { titre: 'Facture télésurveillance mars', abonne: '4471-22' });
    await stabiliser(compte);
    const ops = await actives(compte);
    expect(ops).toHaveLength(1);
    expect((await sources(ops[0].id)).map((s) => s.file)).toEqual([f1, f2, f3]);
    expect(await cartes(compte)).toEqual([]);
    for (const f of [f2, f3]) {
      const c = await candidat(f);
      expect(c).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_reason: 'MATCH_M3', t3_operation_id: ops[0].id });
      // Décision IA journalisée et explicable.
      expect(c.t3_detail.m3.verdict).toMatchObject({ resolution: 'ATTACH', resolutionOrigin: 'MODEL' });
      expect(c.t3_detail.m3.verdict.concordantSignals.length).toBeGreaterThan(0);
    }
    // T1 → T3 : la couche exhaustive T1 (document_source_units) est transmise au modèle, bornée au compte.
    const appel = replay.calls.find((c) => c.operationCode === 't3_operation_match')!;
    expect(appel.prompt).toContain('"excerpts"');
    expect(appel.prompt).toContain('4471-22');
    expect(appel.prompt).toContain('"periods"');
  });

  it('L56A-02 — diagnostic (comportement antérieur) : un verdict seulement « probable » sans issue explicite produit la carte « même contrat ? » ; libellé désormais « Oui »', async () => {
    version = 'v-ancienne';
    prudent = true;
    const compte = await make.account();
    const m = await maison(compte);
    await document(compte, m.id, [echeance(m.id, 1, { typeHint: 'CONTRACT' })], { titre: 'Facture télésurveillance janvier', abonne: '9001' });
    const f2 = await document(compte, m.id, [echeance(m.id, 2, { typeHint: 'CONTRACT' })], { titre: 'Facture télésurveillance février', abonne: '9001' });
    await stabiliser(compte);
    const c = await candidat(f2);
    expect(c).toMatchObject({ t3_outcome: 'ARBITRATION_REQUIRED', t3_reason: 'M3_AMBIGUOUS' });
    expect(c.t3_detail.m3).toMatchObject({ status: 'DONE', promptVersion: 'v-ancienne', verdict: { decision: 'SAME_OPERATION', confidence: 'probable', resolution: 'ARBITRATE', resolutionOrigin: 'LEGACY' } });
    const [carte] = await cartes(compte);
    expect(carte.target_id).toBe(f2);
    expect(carte.question).toContain('le même contrat');
    expect(carte.proposals_json.map((p: any) => p.label)).toEqual(['Oui', 'Non, c’est un autre contrat']);
    // Sans changement (même contexte, même version du prompt) : aucun rappel du modèle, carte inchangée.
    const avant = appelsM3();
    await passer(compte);
    expect(appelsM3()).toBe(avant);
    expect((await cartes(compte)).map((x) => x.id)).toEqual([carte.id]);
  });

  it('L56A-03 — carte ouverte devenue inutile : au passage T3 suivant (nouvelle version du prompt), l’IA rattache, la carte est fermée avec son motif ; réversible (journal)', async () => {
    version = 'v-ancienne';
    prudent = true;
    const compte = await make.account();
    const m = await maison(compte);
    await document(compte, m.id, [echeance(m.id, 1)], { abonne: '5550' });
    const f2 = await document(compte, m.id, [echeance(m.id, 2)], { abonne: '5550' });
    await stabiliser(compte);
    const [carte] = await cartes(compte);
    expect(carte).toBeDefined();
    // Activation BO de la nouvelle version du prompt maître T3 (lot 56A).
    prudent = false;
    version = 'v-56a';
    await passer(compte);
    const [op] = await actives(compte);
    expect(await candidat(f2)).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_reason: 'MATCH_M3', t3_operation_id: op.id });
    expect(await cartes(compte)).toEqual([]);
    const [fermee] = await cartes(compte, false);
    expect(fermee).toMatchObject({ id: carte.id, resolution_reason: 'OBSOLETE' });
    const [ev] = await sql<{ details: any; actor_user_id: number | null }[]>`
      SELECT details, actor_user_id FROM to_process_action_events WHERE action_id = ${carte.id} AND event = 'OBSOLETE'`;
    expect(ev.actor_user_id).toBeNull();
    expect(ev.details).toMatchObject({ reason: 'RESOLVED_BY_T3', t3Reason: 'MATCH_M3', operationId: op.id, ai: { resolution: 'ATTACH' } });
    expect((await sources(op.id)).find((s) => s.file === f2)?.match_method).toBe('M3');
    // Idempotence : passages suivants sans appel ni changement.
    const avant = appelsM3();
    const r = await passer(compte);
    expect(r.changes).toBe(0);
    expect(appelsM3()).toBe(avant);
  });

  it('L56A-04 — autre fournisseur, autre catégorie (loyers de location longue durée d’un véhicule) : même mécanisme, aucune carte', async () => {
    version = 'v-depot';
    const compte = await make.account();
    const auto = await make.asset(compte, { category: 'VEHICULE', name: 'Utilitaire' });
    const loyer = (m: number) => echeance(auto.id, m, { prestataire: 'Loc Zeta', montant: 28900, summary: `Loyer mensuel location longue durée — ${mois(m)}/2026`, typeHint: 'OTHER' });
    const fs = [];
    for (const m of [4, 5, 6]) fs.push(await document(compte, auto.id, [loyer(m)], { abonne: 'LZ-778' }));
    await stabiliser(compte);
    const ops = await actives(compte);
    expect(ops).toHaveLength(1);
    expect((await sources(ops[0].id)).map((s) => s.file)).toEqual(fs);
    expect(await cartes(compte)).toEqual([]);
  });

  it('L56A-05 — deux contrats très similaires du même fournisseur sur deux biens différents : jamais rattachés l’un à l’autre ; document sans bien → question (ARBITRER), jamais un rattachement', async () => {
    version = 'v-depot';
    const compte = await make.account();
    const a = await maison(compte, 'Maison A');
    const b = await maison(compte, 'Maison B');
    await document(compte, a.id, [echeance(a.id, 1)], { abonne: 'A-100' });
    await document(compte, b.id, [echeance(b.id, 1)], { abonne: 'B-200' });
    const fb2 = await document(compte, b.id, [echeance(b.id, 2)], { abonne: 'B-200' });
    await stabiliser(compte);
    const ops = await actives(compte);
    expect(ops).toHaveLength(2);
    const [opA, opB] = ops;
    expect((await sources(opA.id)).length).toBe(1);
    expect((await sources(opB.id)).map((s) => s.file)).toContain(fb2);
    // Document sans bien ni numéro d'abonné lisible : les deux contrats restent compatibles.
    const fx = await document(compte, null, [echeance(null, 3)]);
    await stabiliser(compte);
    expect(await candidat(fx)).toMatchObject({ t3_outcome: 'ARBITRATION_REQUIRED', t3_reason: 'M3_AMBIGUOUS', t3_operation_id: null });
    const [carte] = await cartes(compte);
    expect(carte.target_id).toBe(fx);
    expect(carte.proposals_json).toHaveLength(3);
    expect((await sources(opA.id)).length).toBe(1);
    expect((await sources(opB.id)).map((s) => s.file)).not.toContain(fx);
  });

  it('L56A-06 — ambiguïté réelle : la question reste posée (libellé « Oui »), stable d’un passage à l’autre', async () => {
    version = 'v-depot';
    const compte = await make.account();
    const m = await maison(compte);
    await document(compte, m.id, [echeance(m.id, 1)], { abonne: '777' });
    const f = await document(compte, m.id, [echeance(m.id, 2, { summary: 'Abonnement (ambigu)' })]);
    await stabiliser(compte);
    expect(await candidat(f)).toMatchObject({ t3_outcome: 'ARBITRATION_REQUIRED', t3_reason: 'M3_AMBIGUOUS' });
    const avant = await cartes(compte);
    expect(avant).toHaveLength(1);
    expect(avant[0].proposals_json[0].label).toBe('Oui');
    const appels = appelsM3();
    await passer(compte);
    expect(appelsM3()).toBe(appels);
    expect((await cartes(compte)).map((c) => c.id)).toEqual(avant.map((c) => c.id));
  });

  it('L56A-07 — décision utilisateur antérieure respectée : « Non, c’est un autre contrat » n’est jamais écrasée par un réexamen IA', async () => {
    version = 'v-ancienne';
    prudent = true;
    const compte = await make.account();
    const m = await maison(compte);
    await document(compte, m.id, [echeance(m.id, 1)], { abonne: '31' });
    const f2 = await document(compte, m.id, [echeance(m.id, 2)], { abonne: '31' });
    await stabiliser(compte);
    const [carte] = await cartes(compte);
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    expect(await resolveArbitration(compte.id, carte.public_id, 'DISTINCT', { userId: compte.ownerUserId })).toMatchObject({ ok: true });
    await stabiliser(compte);
    const [op1] = await actives(compte);
    prudent = false;
    version = 'v-56a';
    await stabiliser(compte);
    const c = await candidat(f2);
    expect(c.t3_operation_id).not.toBe(op1.id);
    expect((await sources(op1.id)).map((s) => s.file)).not.toContain(f2);
    const [rep] = await cartes(compte, false);
    expect(rep).toMatchObject({ id: carte.id, resolution_reason: 'USER_ARBITRATED' });
    expect(await cartes(compte)).toEqual([]);
  });

  it('L56A-08 — deux comptes : aucun candidat, aucun extrait ni rattachement d’un autre compte', async () => {
    version = 'v-depot';
    const a = await make.account();
    const b = await make.account();
    const ma = await maison(a);
    const mb = await maison(b);
    await document(a, ma.id, [echeance(ma.id, 1)], { abonne: 'X-1' });
    await stabiliser(a);
    const [opA] = await actives(a);
    const debut = replay.calls.length;
    await document(b, mb.id, [echeance(mb.id, 2)], { abonne: 'X-1' });
    await stabiliser(b);
    const opsB = await actives(b);
    expect(opsB).toHaveLength(1);
    expect(opsB[0].id).not.toBe(opA.id);
    expect(await sources(opA.id)).toHaveLength(1);
    for (const call of replay.calls.slice(debut).filter((c) => c.operationCode === 't3_operation_match')) {
      const ids = (json(call.prompt, 'Candidats') as Array<{ candidateId: number }>).map((c) => c.candidateId);
      expect(ids).not.toContain(opA.id);
    }
    const croises = await sql`
      SELECT 1 FROM document_operation_candidates c JOIN business_operations o ON o.id = c.t3_operation_id
       WHERE c.account_id <> o.account_id AND c.account_id IN (${a.id}, ${b.id})`;
    expect(croises).toHaveLength(0);
  });

  it('L56A-09 — migration 0401 : libellés des questions ouvertes corrigés, question M3 ouverte réexaminée par le balayage (idempotente)', async () => {
    version = 'v-ancienne';
    prudent = true;
    const compte = await make.account();
    const m = await maison(compte);
    await document(compte, m.id, [echeance(m.id, 1)], { abonne: '64' });
    const f2 = await document(compte, m.id, [echeance(m.id, 2)], { abonne: '64' });
    await stabiliser(compte);
    const [carte] = await cartes(compte);
    // Carte posée avant le lot 56A (ancien libellé).
    await sql`UPDATE to_process_actions SET proposals_json = jsonb_set(proposals_json, '{0,label}', '"Oui, la même"') WHERE id = ${carte.id}`;
    // Verdict obtenu avec le contexte antérieur (m3v1) : empreintes d'avant le lot.
    await sql`UPDATE document_operation_candidates
                 SET t3_detail = jsonb_set(jsonb_set(t3_detail, '{m3,fingerprint}', '"m3v1"'), '{m3Fingerprint}', '"m3v1"')
               WHERE file_id = ${f2} AND status = 'ACTIVE'`;
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0401_operation_match_reexamen.sql'), 'utf8');
    await sql.begin(async (tx) => { await tx.unsafe(migration); });
    await sql.begin(async (tx) => { await tx.unsafe(migration); });
    const [apres] = await cartes(compte);
    expect(apres.proposals_json[0]).toMatchObject({ value: carte.proposals_json[0].value, label: 'Oui' });
    expect(JSON.stringify(apres.proposals_json)).not.toContain('la même');
    const [marque] = await sql<{ t3_pending: boolean }[]>`SELECT t3_pending FROM document_operation_candidates WHERE file_id = ${f2} AND status = 'ACTIVE'`;
    expect(marque.t3_pending).toBe(true);
    // Balayage T3 (version du prompt inchangée, contexte m3v2) : question gardée pendant le réexamen, puis tranchée par l'IA.
    prudent = false;
    // Plafond d'appels atteint pendant ce passage : la question reste posée (même carte), jamais fermée puis rouverte.
    await (await consolidator()).consolidateAccountOperations(compte.id, {
      today: AUJOURDHUI, operationMatch: { promptStatus: async () => ({ available: true, version }), maxCallsPerPass: 0 },
    });
    expect(await candidat(f2)).toMatchObject({ t3_outcome: 'ARBITRATION_REQUIRED', t3_reason: 'M3_AMBIGUOUS' });
    expect((await cartes(compte)).map((c) => c.id)).toEqual([carte.id]);
    await stabiliser(compte);
    expect(await candidat(f2)).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_reason: 'MATCH_M3' });
    expect(await cartes(compte)).toEqual([]);
  });
});
