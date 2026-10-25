/**
 * Lot 88B — ticket P1 « Contrôle de cohérence — Détecter et réparer les
 * propriétés métier manquantes à partir de l'ensemble des preuves », sur
 * PostgreSQL 16 réel : orchestrateur de cohérence (campagnes à blanc puis
 * corrective), collecte transversale réelle, passerelle IA réelle avec T3
 * KNOWLEDGE_QUERY SIMULÉ (fournisseur rejoué), writer canonique réel,
 * preuves `field_evidence`, journal 0770.
 *
 * Le prompt T3 actif est une version BO DE TEST (texte du dépôt + section
 * de test) : sans le marqueur du contrat d'entrée `t3-knowledge-query-v2`,
 * la capacité est absente, comme en préproduction tant que l'équipe IA n'a
 * pas livré le texte (aucun fichier de prompt modifié).
 *
 * AUCUNE logique propre à une propriété, à un montant ou à un type de
 * document : la propriété de référence est PRISE DANS LE REGISTRE (premier
 * champ monétaire soumissible de la famille), les montants et intitulés des
 * fixtures sont neutres, et le T3 simulé ne fait que citer les éléments
 * RÉELLEMENT transmis qui portent la valeur neutre du test.
 *
 *  L88B-E2E-01  cas de référence « Maison » : plusieurs sources convergentes (documents, Opération) — à blanc sans écriture ; correctif : T3 sollicité sur le contexte transversal, valeur écrite par le writer canonique (+ miroirs), preuves, provenance, décision ; idempotence après passage de convergence
 *  L88B-E2E-02  les 8 cas du ticket : une preuve forte ; plusieurs concordantes ; contradictoires ; seulement dans une Opération ; répartie document + Opération ; déjà renseignée ; corrigée manuellement (valeur effacée, document détaché) ; aucune preuve
 *  L88B-E2E-03  prompt actif sans le contrat : constat, aucun appel, aucune écriture ; puis contrat livré → écriture ; équipement (catalogue ÉQUIPEMENT)
 *  L88B-E2E-04  budget partagé épuisé et panne IA : aucune écriture, abstention / nouvelle tentative tracées
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { setDefaultResponder } from '../replay-gateway';
import { useTargetState } from '../chain';
import { runCoherenceFor, proofOf } from '../coherence-run';
import { operationsKit, cand, fh, cible, type OperationsKit } from '../datasets/operations-v1';
import type { AccountRow } from '../factories';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
type Preuve = { ref: string; document: string; layer: string; label: string | null; value: string | null; text: string | null };
type Candidat = { role: string; key: string };

const AUJ = '2026-10-25';
const CHECK = 'COH-MISSING-PROPERTIES';
const CHECK_EQ = 'COH-MISSING-PROPERTIES-EQUIPMENT';
/** Montants NEUTRES du test, sous plusieurs écritures (aucune constante métier). */
const V = { ecrit: '123 456,00', fait: '123456,00', composante: '123456.00', minor: 12_345_600, valeur: 123456 };
const W = { ecrit: '98 765,00', minor: 9_876_500, valeur: 98765 };
const MARQUEUR = 'Objet désigné : le bien du dossier 17';

const ligne = (prompt: string, etiquette: string): unknown => {
  const m = new RegExp(`^${etiquette} : (.*)$`, 'm').exec(prompt);
  return m ? JSON.parse(m[1]) : null;
};
const nombre = (s: string) => Number(s.replace(/\s/g, '').replace(',', '.'));
const texteDe = (p: Preuve) => [p.label, p.value, p.text].filter(Boolean).join(' \n ');

/**
 * T3 simulé GÉNÉRIQUE : cite les éléments transmis qui contiennent l'une des
 * écritures neutres du test pour la propriété de référence (si elle est
 * demandée) ; deux valeurs différentes → CONTRADICTION ; aucune → NOT_FOUND.
 * `lier` : élément d'un document cité avec la valeur (connaissance répartie).
 */
const modele = {
  appels: [] as Array<{ preuves: Preuve[]; candidats: Candidat[]; champ: Json }>,
  ecritures: [] as string[],
  lier: null as string | null,
  confiance: 'certain' as 'certain' | 'probable',
  panne: false,
  cle: '',
};
function repondre(input: { prompt: string }): unknown {
  const preuves = (ligne(input.prompt, 'Preuves candidates') ?? []) as Preuve[];
  const candidats = (ligne(input.prompt, 'Candidats') ?? []) as Candidat[];
  const champ = (ligne(input.prompt, 'Champ') ?? {}) as Json;
  modele.appels.push({ preuves, candidats, champ });
  if (modele.panne) throw new Error('fournisseur indisponible (simulé)');
  const vide = { task: 'KNOWLEDGE_QUERY', outcome: 'NOT_FOUND', findings: [], reason: 'simulé' };
  if (!candidats.some((c) => c.key === modele.cle)) return vide;
  const hits: Array<{ ref: string; ecrit: string }> = [];
  for (const p of preuves) for (const e of modele.ecritures) if (texteDe(p).includes(e)) { hits.push({ ref: p.ref, ecrit: e }); break; }
  if (!hits.length) return vide;
  const valeurs = [...new Set(hits.map((h) => nombre(h.ecrit)))];
  const constat = (refs: string[], ecrit: string, excerpt = ecrit) =>
    ({ target: modele.cle, rawValue: ecrit, evidenceRefs: refs, excerpt, confidence: modele.confiance, meaning: 'simulé (e2e)' });
  if (valeurs.length > 1) {
    const un = valeurs.map((v) => hits.find((h) => nombre(h.ecrit) === v)!);
    return { task: 'KNOWLEDGE_QUERY', outcome: 'CONTRADICTION', findings: un.map((h) => constat([h.ref], h.ecrit)), reason: 'simulé' };
  }
  const lie = modele.lier ? preuves.find((p) => texteDe(p).includes(modele.lier!)) : null;
  const findings = lie
    ? [constat([lie.ref, hits[0].ref], hits[0].ecrit, `${modele.lier} [...] ${hits[0].ecrit}`)]
    : hits.slice(0, 5).map((h) => constat([h.ref], h.ecrit));
  return { task: 'KNOWLEDGE_QUERY', outcome: 'CONSTITUENTS', findings, reason: 'simulé' };
}

scenario('L88B-PROPRIETES', 'Propriétés métier manquantes reprises à partir de l’ensemble des preuves (lot 88B)', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T4'] });
  const fichierT3 = readFileSync(join(process.cwd(), 'src/services/ai/prompts/reconciliation/t3_master_v1.txt'), 'utf8');
  let k: OperationsKit;
  let PRIX: { key: string };
  let PRIX_EQ: { key: string };
  let enVigueur: Record<string, string | undefined> = {};

  /** Version BO de test du prompt T3 : branche KNOWLEDGE_QUERY, avec ou sans le contrat d'entrée v2. */
  const capacite = async (v2: boolean) => {
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    __setActiveMasterPromptsForTests([{ id: v2 ? 98802 : 98801, treatment: 'T3', versionNumber: v2 ? 882 : 881,
      content: `${fichierT3}\n\nBRANCHE TASK = KNOWLEDGE_QUERY\n\n${v2 ? 'Contrat d’entrée accepté : t3-knowledge-query-v2.\n' : ''}(Section de test e2e : réponse simulée.)\n` }]);
    (await import('@/services/ai/reconciliation/knowledge-query/model')).__resetKnowledgeCapabilityCacheForTests();
  };

  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
    k = operationsKit(sql, make);
    setDefaultResponder('t3_knowledge_query', 'KNOWLEDGE_QUERY', repondre);
    const cat = await import('@/services/ai/reconciliation/missing-properties/catalog');
    const { listFields } = await import('@/services/canonical/registry');
    const sujet = { type: 'ASSET' as const, category: 'IMMOBILIER', subtype: null };
    // Propriété de référence PRISE DANS LE REGISTRE (aucun nom codé dans le test).
    PRIX = listFields('IMMOBILIER').find((d) => d.valueType === 'money_eur' && !cat.exclusionOf(d, sujet))!;
    const eq = { type: 'EQUIPMENT' as const, category: null, subtype: null };
    PRIX_EQ = listFields(undefined, { targetType: 'EQUIPMENT' }).find((d) => d.valueType === 'money_eur' && !cat.exclusionOf(d, eq))!;
    expect(PRIX && PRIX_EQ).toBeTruthy();
  });
  beforeEach(async () => {
    Object.assign(modele, { appels: [], ecritures: [], lier: null, confiance: 'certain', panne: false, cle: PRIX.key });
    enVigueur = { b: process.env.T3_KNOWLEDGE_QUERY_DAILY_MAX, p: process.env.T3_MISSING_PROPERTIES_PER_CALL };
    process.env.T3_MISSING_PROPERTIES_PER_CALL = '40';
    await capacite(true);
  });
  afterAll(async () => {
    setDefaultResponder('t3_knowledge_query', 'KNOWLEDGE_QUERY', null);
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
    (await import('@/services/ai/reconciliation/knowledge-query/model')).__resetKnowledgeCapabilityCacheForTests();
  });
  const restaurerEnv = () => {
    for (const [cle, v] of [['T3_KNOWLEDGE_QUERY_DAILY_MAX', enVigueur.b], ['T3_MISSING_PROPERTIES_PER_CALL', enVigueur.p]] as const) {
      if (v === undefined) delete process.env[cle]; else process.env[cle] = v;
    }
  };

  // ── Outils ────────────────────────────────────────────────────────────────
  const compte = () => make.account({ plan: 'premium' });
  const maison = (c: AccountRow) => make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
  /** Document analysé (connaissance T1 persistée : unités et faits), rattaché ou non. */
  async function documentT1(c: AccountRow, assetId: number | null, p: { title: string; units?: string[]; facts?: Array<{ label: string; value: string }> }) {
    const f = await make.assetFile(c, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${p.title}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    const [{ id: ext }] = await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, title, document_type_code, full_text, full_text_chars)
      VALUES (${c.id}, ${f.id}, ${p.title}, NULL, '', 0) RETURNING id`;
    let n = 0;
    for (const x of p.facts ?? []) {
      n += 1;
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, normalized_value, confidence, excerpt)
                VALUES (${c.id}, ${f.id}, ${ext}, ${`fait_${n}`}, ${x.label}, ${x.value}, ${x.value}, 'certain', ${`${x.label} : ${x.value}`})`;
    }
    let u = 0;
    for (const t of p.units ?? []) {
      u += 1;
      await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, ordinal, content_text, coverage_status)
                VALUES (${c.id}, ${f.id}, ${ext}, ${`u${u}`}, 'TEXT_BLOCK', ${u}, ${t}, 'COVERED')`;
    }
    const { ensureBusinessTitle } = await import('@/services/documents/document-title.service');
    await ensureBusinessTitle({ fileId: f.id, accountId: c.id, origin: 'T1', mode: 'refresh' });
    return f.id;
  }
  /** Opération réelle (persistance T1 du candidat + consolidation T3) portant un montant réalisé, sans aucun fait sur son document. */
  async function operation(c: AccountRow, assetId: number, minor: number, title = 'Pièce comptable') {
    const fileId = await k.document(c, assetId, [cand({ targetHints: [cible(assetId)], financialHints: [fh('REALIZED_COST', minor)] })], { title });
    await k.passer(c);
    const [op] = await sql<{ id: number }[]>`
      SELECT o.id::int AS id FROM business_operations o JOIN business_operation_asset_links l ON l.operation_id = o.id AND l.asset_id = ${assetId} AND l.active
       WHERE o.account_id = ${c.id} AND o.invalidated_at IS NULL ORDER BY o.id DESC LIMIT 1`;
    expect(op).toBeTruthy();
    return { fileId, opId: op.id };
  }
  const valeur = async (c: AccountRow, assetId: number) => {
    const { getCanonicalAssetState } = await import('@/services/canonical/asset-state');
    return (await getCanonicalAssetState(assetId, c.id))!.fields[PRIX.key]?.value ?? null;
  };
  const decisions = (c: AccountRow, objectId?: number) => sql<Json[]>`
    SELECT object_type, object_id, field_key, decision, cause, value_before, value_after, proposed_value, findings, rejected, evidence_ids, provenance, write_outcome
      FROM property_recovery_decisions WHERE account_id = ${c.id} AND (${objectId ?? null}::int IS NULL OR object_id = ${objectId ?? null}) ORDER BY id`;
  const decisionPrix = async (c: AccountRow, objectId: number) => (await decisions(c, objectId)).find((d) => d.field_key === PRIX.key) ?? null;
  const runs = (c: AccountRow) => sql<Json[]>`SELECT object_id, status, calls, attempts, properties, context_summary, retry_at FROM property_recovery_runs WHERE account_id = ${c.id} ORDER BY id`;
  const ecritures = (c: AccountRow) => sql<Json[]>`
    SELECT asset_id, canonical_key, old_value, new_value, origin, source_type, outcome FROM canonical_field_writes
     WHERE account_id = ${c.id} AND source_type = 'coherence_missing_property' ORDER BY id`;
  const preuvesCreees = (c: AccountRow) => sql<Json[]>`
    SELECT asset_id, field_key, source_type, source_id, evidence_excerpt, target_type, target_entity_id, lifecycle_status, status
      FROM field_evidence WHERE account_id = ${c.id} AND projection_rule = 'COH-MISSING-PROPERTIES' ORDER BY id`;
  const appelsAvec = (ref: string) => modele.appels.filter((a) => a.preuves.some((p) => p.ref === ref));
  const campagne = (c: AccountRow, mode: 'DRY_RUN' | 'CORRECTIVE' = 'CORRECTIVE') => runCoherenceFor(sql, [c.id], { mode, today: AUJ });

  // ══ L88B-E2E-01 ═══════════════════════════════════════════════════════════

  it('L88B-E2E-01 — cas de référence « Maison » : sources convergentes → décision T3 explicite, écriture canonique, preuves ; idempotent', async () => {
    const c = await compte();
    const m = await maison(c);
    const d1 = await documentT1(c, m.id, { title: 'Pièce A', units: [`Les parties conviennent d’un montant de ${V.ecrit} euros.`] });
    const d2 = await documentT1(c, m.id, { title: 'Pièce B', facts: [{ label: 'Montant', value: V.fait }] });
    const d3 = await documentT1(c, m.id, { title: 'Pièce C', units: [`Somme portée au dossier : ${V.ecrit} €`] });
    const { opId, fileId: dOp } = await operation(c, m.id, V.minor);
    modele.ecritures = [V.ecrit, V.fait, V.composante];
    expect(await valeur(c, m.id)).toBeNull();

    // À blanc : aucune IA, aucune écriture ; réparation prévue.
    await campagne(c, 'DRY_RUN');
    expect(modele.appels).toHaveLength(0);
    expect((await proofOf(sql, c.id, CHECK, m.id))).toMatchObject({ last_result: 'WOULD_REPAIR' });
    expect(await valeur(c, m.id)).toBeNull();
    expect(await decisions(c)).toEqual([]);

    // Correctif : la propriété manquante est soumise à T3 avec TOUT le contexte (documents, faits, unités, Opération, montant).
    const r1 = await campagne(c);
    expect(r1.status).toBe('COMPLETE');
    const avecPrix = modele.appels.filter((a) => a.candidats.some((x) => x.key === PRIX.key));
    expect(avecPrix).toHaveLength(1);
    const refs = avecPrix[0].preuves.map((p) => p.ref);
    for (const f of [d1, d2, d3]) expect(refs).toContain(`M-${f}`);
    expect(refs).toContain(`O-${opId}`);
    expect(avecPrix[0].preuves.some((p) => p.layer === 'OPERATION_COMPONENT' && (p.value ?? '').includes(V.composante))).toBe(true);
    expect(avecPrix[0].preuves.some((p) => p.layer === 'FACT' && p.value === V.fait)).toBe(true);
    expect(avecPrix[0].champ).toMatchObject({ contractVersion: 't3-knowledge-query-v2', mode: 'MISSING_PROPERTIES' });

    // Écriture par le writer canonique : fiche + miroirs + journal 0216 (avant / après), provenance.
    expect(await valeur(c, m.id)).toBe(V.valeur);
    const { toMirrorValue } = await import('@/services/canonical/registry');
    const miroirs = toMirrorValue(PRIX.key, V.valeur);
    if (Object.keys(miroirs).length) {
      const [row] = await sql.unsafe(`SELECT ${Object.keys(miroirs).join(', ')} FROM assets WHERE id = $1`, [m.id]) as Json[];
      for (const [col, v] of Object.entries(miroirs)) expect(Number(row[col])).toBe(Number(v));
    }
    expect(await ecritures(c)).toEqual([expect.objectContaining({ asset_id: m.id, canonical_key: PRIX.key, old_value: null, new_value: V.valeur, origin: 'RECONCILIATION', outcome: 'written' })]);
    const d = (await decisionPrix(c, m.id))!;
    expect(d).toMatchObject({ object_type: 'ASSET', decision: 'WRITTEN', cause: null, value_before: null, value_after: V.valeur, write_outcome: 'written' });
    expect(d.provenance.treatment).toMatchObject({ operation: 't3_knowledge_query', contractVersion: 't3-knowledge-query-v2' });
    expect(d.provenance.cited.documents).toEqual(expect.arrayContaining([d1, d2, d3]));
    expect(d.provenance.cited.operations).toEqual([opId]);
    expect(d.findings.length).toBeGreaterThanOrEqual(3);
    // Preuves créées : une par source documentaire citée (empreinte : jamais en double), propres au bien.
    const fe = await preuvesCreees(c);
    expect(fe.length).toBe(d.evidence_ids.length);
    expect(fe.every((x) => x.field_key === PRIX.key && x.asset_id === m.id && x.lifecycle_status === 'ACTIVE' && x.target_type === 'ASSET')).toBe(true);
    expect([...new Set(fe.map((x) => x.source_id))].sort((a, b) => a - b)).toEqual([d1, d2, d3, dOp].sort((a, b) => a - b));
    expect(fe.every((x) => x.source_type === 'document' && x.status === 'active')).toBe(true);
    // Les autres propriétés vides : abstention tracée (rien trouvé), jamais une valeur inventée.
    const autres = (await decisions(c, m.id)).filter((x) => x.field_key !== PRIX.key);
    expect(autres.length).toBeGreaterThan(3);
    expect(autres.every((x) => x.decision === 'ABSTAINED' && x.cause === 'NOT_FOUND' && x.value_after === null)).toBe(true);
    // Journal du contrôle : réparation par le service, T3, recontrôle.
    const [rep] = await sql<Json[]>`SELECT service, outcome, recheck_verdict, ai_calls, reevaluation_kind FROM coherence_repairs WHERE account_id = ${c.id} AND check_id = ${CHECK}`;
    expect(rep).toMatchObject({ service: 'recoverMissingProperties', outcome: 'REPAIRED', recheck_verdict: 'CONSISTENT', reevaluation_kind: 'SEMANTIC_REEVALUATION_T3' });
    expect(rep.ai_calls).toBeGreaterThanOrEqual(1);
    expect(await proofOf(sql, c.id, CHECK, m.id)).toMatchObject({ last_result: 'REPAIRED' });

    // Idempotence : passage de convergence, puis mesure — aucun rappel T3, aucune nouvelle écriture ni décision.
    await campagne(c);
    const appels = modele.appels.length;
    const nDecisions = (await decisions(c)).length;
    const nPreuves = (await preuvesCreees(c)).length;
    await campagne(c);
    expect(modele.appels.length).toBe(appels);
    expect((await decisions(c)).length).toBe(nDecisions);
    expect((await preuvesCreees(c)).length).toBe(nPreuves);
    expect(await ecritures(c)).toHaveLength(1);
    expect(await proofOf(sql, c.id, CHECK, m.id)).toMatchObject({ last_result: 'CONSISTENT' });
  });

  // ══ L88B-E2E-02 ═══════════════════════════════════════════════════════════

  it('L88B-E2E-02 — les 8 cas du ticket (génériques)', async () => {
    modele.ecritures = [V.ecrit, V.fait, V.composante, W.ecrit];

    // 1. propriété absente + une preuve forte → écrite.
    const c1 = await compte();
    const a1 = await maison(c1);
    await documentT1(c1, a1.id, { title: 'Pièce', units: [`Montant retenu : ${V.ecrit}`] });
    await campagne(c1);
    expect(await valeur(c1, a1.id)).toBe(V.valeur);
    expect(await decisionPrix(c1, a1.id)).toMatchObject({ decision: 'WRITTEN' });

    // 2. plusieurs preuves concordantes (écritures différentes) → une seule valeur écrite.
    const c2 = await compte();
    const a2 = await maison(c2);
    await documentT1(c2, a2.id, { title: 'Pièce 1', units: [`Total : ${V.ecrit}`] });
    await documentT1(c2, a2.id, { title: 'Pièce 2', facts: [{ label: 'Total', value: V.fait }] });
    await campagne(c2);
    expect(await valeur(c2, a2.id)).toBe(V.valeur);
    expect((await decisionPrix(c2, a2.id))!.findings).toHaveLength(2);

    // 3. preuves contradictoires → abstention CONTRADICTION, champ vide, constat AMBIGUOUS, aucune preuve créée.
    const c3 = await compte();
    const a3 = await maison(c3);
    await documentT1(c3, a3.id, { title: 'Pièce 1', units: [`Total : ${V.ecrit}`] });
    await documentT1(c3, a3.id, { title: 'Pièce 2', units: [`Total : ${W.ecrit}`] });
    await campagne(c3);
    expect(await valeur(c3, a3.id)).toBeNull();
    expect(await decisionPrix(c3, a3.id)).toMatchObject({ decision: 'ABSTAINED', cause: 'CONTRADICTION', value_after: null });
    expect(await proofOf(sql, c3.id, CHECK, a3.id)).toMatchObject({ last_result: 'AMBIGUOUS' });
    expect(await preuvesCreees(c3)).toEqual([]);
    expect(await ecritures(c3)).toEqual([]);

    // 4. donnée présente uniquement dans une Opération (aucun fait, aucune unité) → écrite ; preuve rattachée à la pièce source de l'Opération.
    const c4 = await compte();
    const a4 = await maison(c4);
    const o4 = await operation(c4, a4.id, V.minor);
    await campagne(c4);
    expect(await valeur(c4, a4.id)).toBe(V.valeur);
    const d4 = (await decisionPrix(c4, a4.id))!;
    expect(d4.provenance.cited.layers).toEqual(['OPERATION_COMPONENT']);
    expect(d4.provenance.cited.operations).toEqual([o4.opId]);
    expect((await preuvesCreees(c4)).map((x) => [x.source_type, x.source_id])).toEqual([['document', o4.fileId]]);

    // 5. données réparties entre un document et une Opération → écrite, les deux sources citées.
    const c5 = await compte();
    const a5 = await maison(c5);
    const doc5 = await documentT1(c5, a5.id, { title: 'Pièce descriptive', units: [MARQUEUR] });
    const o5 = await operation(c5, a5.id, V.minor);
    modele.lier = MARQUEUR;
    await campagne(c5);
    modele.lier = null;
    expect(await valeur(c5, a5.id)).toBe(V.valeur);
    const d5 = (await decisionPrix(c5, a5.id))!;
    expect(d5.provenance.cited.documents).toEqual(expect.arrayContaining([doc5, o5.fileId]));
    expect(d5.provenance.cited.layers).toEqual(['OPERATION_COMPONENT', 'SOURCE_UNIT']);

    // 6. propriété déjà renseignée → jamais soumise, jamais modifiée.
    const c6 = await compte();
    const a6 = await maison(c6);
    const canon = await import('@/services/canonical/asset-state');
    await canon.writeCanonicalAssetFields({ assetId: a6.id, accountId: c6.id, origin: 'USER', source: { type: 'e2e' }, writes: [{ key: PRIX.key, value: 777 }] });
    const doc6 = await documentT1(c6, a6.id, { title: 'Pièce', units: [`Total : ${V.ecrit}`] });
    await campagne(c6);
    expect(await valeur(c6, a6.id)).toBe(777);
    expect(appelsAvec(`M-${doc6}`).every((a) => !a.candidats.some((x) => x.key === PRIX.key))).toBe(true);
    expect(await decisionPrix(c6, a6.id)).toBeNull();

    // 7. propriété corrigée manuellement : valeur EFFACÉE par l'utilisateur + document DÉTACHÉ par l'utilisateur → jamais réécrite, jamais lue.
    const c7 = await compte();
    const a7 = await maison(c7);
    await canon.writeCanonicalAssetFields({ assetId: a7.id, accountId: c7.id, origin: 'USER', source: { type: 'e2e' }, writes: [{ key: PRIX.key, value: 555 }] });
    await canon.writeCanonicalAssetFields({ assetId: a7.id, accountId: c7.id, origin: 'USER', source: { type: 'e2e' }, writes: [{ key: PRIX.key, value: null }] });
    const doc7 = await documentT1(c7, a7.id, { title: 'Pièce', units: [`Total : ${V.ecrit}`] });
    const detache = await documentT1(c7, null, { title: 'Pièce détachée', units: [`Total : ${W.ecrit}`] });
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, status, removed_at)
              VALUES (${c7.id}, ${detache}, ${a7.id}, 'PRIMARY', 'USER', 'REMOVED', now())`;
    await campagne(c7);
    expect(await valeur(c7, a7.id)).toBeNull();
    expect(await decisionPrix(c7, a7.id)).toBeNull();
    expect(appelsAvec(`M-${doc7}`).every((a) => !a.candidats.some((x) => x.key === PRIX.key))).toBe(true);
    expect(modele.appels.some((a) => a.preuves.some((p) => p.ref === `M-${detache}`))).toBe(false);
    const { missingPropertiesState } = await import('@/services/ai/reconciliation/missing-properties/service');
    const st7 = (await missingPropertiesState(c7.id, { type: 'ASSET', id: a7.id }))!;
    expect(st7.catalog.protectedKeys).toEqual(expect.arrayContaining([{ key: PRIX.key, reason: 'USER_CLEARED' }]));
    expect(await ecritures(c7)).toEqual([]);

    // 8. absence totale de preuve : document sans rapport → T3 consulté, abstention NOT_FOUND tracée ; bien sans aucune source → hors périmètre.
    const c8 = await compte();
    const a8 = await maison(c8);
    const nu = await maison(c8);
    await documentT1(c8, a8.id, { title: 'Notice', units: ['Consignes générales d’utilisation.'] });
    await campagne(c8);
    expect(await valeur(c8, a8.id)).toBeNull();
    expect(await decisionPrix(c8, a8.id)).toMatchObject({ decision: 'ABSTAINED', cause: 'NOT_FOUND', value_after: null, proposed_value: null });
    expect(await proofOf(sql, c8.id, CHECK, a8.id)).toMatchObject({ last_result: 'REPAIRED' });
    expect(await proofOf(sql, c8.id, CHECK, nu.id)).toBeNull();
    expect(await ecritures(c8)).toEqual([]);
  });

  // ══ L88B-E2E-03 ═══════════════════════════════════════════════════════════

  it('L88B-E2E-03 — prompt actif sans le contrat : constat, aucun appel ; contrat livré : écriture ; équipement', async () => {
    modele.ecritures = [V.ecrit];
    const c = await compte();
    const m = await maison(c);
    await documentT1(c, m.id, { title: 'Pièce', units: [`Total : ${V.ecrit}`] });
    await capacite(false);
    await campagne(c);
    expect(modele.appels).toHaveLength(0);
    const p = (await proofOf(sql, c.id, CHECK, m.id))!;
    expect(p).toMatchObject({ last_result: 'FINDING' });
    expect(p.finding).toMatchObject({ anomaly: 'MISSING_PROPERTY_ARBITRATION_PENDING', detail: expect.objectContaining({ pendingContract: '88B-t3-proprietes-manquantes' }) });
    expect(await valeur(c, m.id)).toBeNull();
    expect(await decisions(c)).toEqual([]);
    // Le prompt actif porte le contrat : arbitrage puis écriture.
    await capacite(true);
    await campagne(c);
    expect(await valeur(c, m.id)).toBe(V.valeur);

    // Équipement : document rattaché à l'équipement seul ; catalogue ÉQUIPEMENT du registre, writer des entités.
    modele.cle = PRIX_EQ.key;
    const ce = await compte();
    const me = await maison(ce);
    const [{ id: eq }] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${me.id}, 'Appareil') RETURNING id`;
    const de = await documentT1(ce, null, { title: 'Pièce de l’appareil', units: [`Total : ${V.ecrit}`] });
    await sql`INSERT INTO document_asset_links (account_id, file_id, equipment_id, link_role, origin, status) VALUES (${ce.id}, ${de}, ${eq}, 'PRIMARY', 'USER', 'ACTIVE')`;
    await campagne(ce);
    const { getCanonicalEntityState, ENTITY_MIRRORS } = await import('@/services/canonical/entity-state');
    const st = (await getCanonicalEntityState({ type: 'EQUIPMENT', id: eq }, ce.id))!;
    expect(st.fields[PRIX_EQ.key]?.value).toBe(V.valeur);
    const miroir = ENTITY_MIRRORS.EQUIPMENT[PRIX_EQ.key];
    if (miroir?.table === 'equipments') {
      const [row] = await sql.unsafe(`SELECT ${miroir.column} AS v FROM equipments WHERE id = $1`, [eq]) as Json[];
      expect(Number(row.v)).toBe(V.minor);
    }
    expect(await proofOf(sql, ce.id, CHECK_EQ, eq)).toMatchObject({ last_result: 'REPAIRED' });
    expect(await proofOf(sql, ce.id, CHECK, me.id)).toBeNull();
    expect((await decisions(ce))[0]).toMatchObject({ object_type: 'EQUIPMENT', object_id: eq });
    const fe = await preuvesCreees(ce);
    expect(fe).toEqual([expect.objectContaining({ asset_id: me.id, target_type: 'EQUIPMENT', target_entity_id: eq, source_id: de })]);
    // La valeur de l'équipement n'est pas celle du bien.
    expect(await valeur(ce, me.id)).toBeNull();
  });

  // ══ L88B-E2E-04 ═══════════════════════════════════════════════════════════

  it('L88B-E2E-04 — budget partagé épuisé, panne IA, confiance insuffisante : aucune écriture, causes tracées', async () => {
    modele.ecritures = [V.ecrit];
    try {
      // Budget du compte épuisé (T3_KNOWLEDGE_QUERY_DAILY_MAX, partagé avec 85F) : aucun appel, analyse tracée.
      process.env.T3_KNOWLEDGE_QUERY_DAILY_MAX = '0';
      const c = await compte();
      const m = await maison(c);
      await documentT1(c, m.id, { title: 'Pièce', units: [`Total : ${V.ecrit}`] });
      await campagne(c);
      expect(modele.appels).toHaveLength(0);
      expect((await runs(c)).map((r) => [r.status, r.calls])).toEqual([['BUDGET_EXHAUSTED', 0]]);
      expect(await valeur(c, m.id)).toBeNull();
      expect(await decisions(c)).toEqual([]);
      restaurerEnv();
      process.env.T3_MISSING_PROPERTIES_PER_CALL = '40';

      // Panne du fournisseur : analyse AI_FAILED avec nouvelle tentative différée ; aucune écriture.
      const c2 = await compte();
      const m2 = await maison(c2);
      await documentT1(c2, m2.id, { title: 'Pièce', units: [`Total : ${V.ecrit}`] });
      modele.panne = true;
      await campagne(c2);
      modele.panne = false;
      const [r] = await runs(c2);
      expect(r).toMatchObject({ status: 'AI_FAILED' });
      expect(r.retry_at).not.toBeNull();
      expect(await valeur(c2, m2.id)).toBeNull();
      expect(await decisions(c2)).toEqual([]);

      // T3 trouve la valeur sans l'établir (confiance probable) : abstention INSUFFICIENT_CONFIDENCE, valeur proposée tracée, rien écrit.
      const c3 = await compte();
      const m3 = await maison(c3);
      await documentT1(c3, m3.id, { title: 'Pièce', units: [`Total : ${V.ecrit}`] });
      modele.confiance = 'probable';
      await campagne(c3);
      expect(await valeur(c3, m3.id)).toBeNull();
      expect(await decisionPrix(c3, m3.id)).toMatchObject({ decision: 'ABSTAINED', cause: 'INSUFFICIENT_CONFIDENCE', proposed_value: V.valeur });
      expect(await proofOf(sql, c3.id, CHECK, m3.id)).toMatchObject({ last_result: 'AMBIGUOUS' });
    } finally {
      restaurerEnv();
    }
  });
});
