/**
 * Lot 91B — ticket P1 « Garantir l'exécution de la reprise des propriétés
 * manquantes et supprimer les sorties silencieuses », sur PostgreSQL 16 réel :
 * orchestrateur de cohérence (campagnes manuelles, quotidienne, contrôles
 * ciblés, rattrapage), collecte réelle, passerelle IA réelle avec T3
 * KNOWLEDGE_QUERY SIMULÉ, writer canonique réel, journal 0770 + 0790.
 *
 * REPRODUCTION NEUTRE du cas constaté (compte / bien « Maison ») : propriété
 * monétaire du registre VIDE ; deux documents rattachés portent des faits T1
 * explicites de la valeur, mais SANS clé canonique (connaissance générique
 * requalifiée par une règle de projection, clé brute = clé du registre, clé
 * de fait voisine) et avec la valeur dans la seule colonne NUMÉRIQUE ; un
 * événement de référence porte la composante correspondante ; des campagnes
 * tournent et posent des preuves de contrôle. Avant le lot 91B : aucune ligne
 * `property_recovery_runs` ni `property_recovery_decisions` (prompt T3 actif
 * sans le contrat, ou campagne à blanc : le contrôle ne réparait pas et
 * n'écrivait rien dans son journal).
 *
 * La propriété est PRISE DANS LE REGISTRE ; les montants et intitulés sont
 * neutres ; le T3 simulé cite seulement les éléments transmis qui portent la
 * valeur du test.
 *
 *  L91B-E2E-01  cas de référence : contrat absent → CONTRACT_PENDING persisté (tous les champs), constat non résolu, Supervision
 *               immédiate ; à blanc → DRY_RUN ; contrat livré → WRITTEN (faits sans clé canonique transmis), journal 0216 ; idempotent
 *  L91B-E2E-02  T3 s'abstient → ABSTAINED + cause, aucune écriture ; correction de l'utilisateur protégée (aucune soumission)
 *  L91B-E2E-03  campagne QUOTIDIENNE : objet sélectionné, budget épuisé / panne IA / nouvelle tentative pas encore due / anti-boucle,
 *               chaque issue persistée avec sa cause et sa prochaine tentative
 *  L91B-E2E-04  rattrapage des objets jamais examinés : NOT_SELECTED, contrôle ciblé, décision ; simulation sans écriture ; idempotent
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
type Preuve = { ref: string; document: string; layer: string; kind: string; label: string | null; value: string | null; text: string | null };
type Candidat = { role: string; key: string };

const AUJ = '2026-10-26';
const CHECK = 'COH-MISSING-PROPERTIES';
/** Valeur NEUTRE du test : écrite dans les extraits, numérique dans les faits. */
const V = { ecrit: '246 802,00', nombre: 246802, minor: 24_680_200, composante: '246802.00' };

const ligne = (prompt: string, etiquette: string): unknown => {
  const m = new RegExp(`^${etiquette} : (.*)$`, 'm').exec(prompt);
  return m ? JSON.parse(m[1]) : null;
};
const texteDe = (p: Preuve) => [p.label, p.value, p.text].filter(Boolean).join(' \n ');

/** T3 simulé générique : cite les éléments qui portent la valeur neutre (écrite ou numérique) de la propriété demandée. */
const modele = {
  appels: [] as Array<{ preuves: Preuve[]; candidats: Candidat[] }>,
  cle: '',
  confiance: 'certain' as 'certain' | 'probable',
  panne: false,
};
function repondre(input: { prompt: string }): unknown {
  const preuves = (ligne(input.prompt, 'Preuves candidates') ?? []) as Preuve[];
  const candidats = (ligne(input.prompt, 'Candidats') ?? []) as Candidat[];
  modele.appels.push({ preuves, candidats });
  if (modele.panne) throw new Error('fournisseur indisponible (simulé)');
  const vide = { task: 'KNOWLEDGE_QUERY', outcome: 'NOT_FOUND', findings: [], reason: 'simulé' };
  if (!candidats.some((c) => c.key === modele.cle)) return vide;
  const hits = preuves.filter((p) => texteDe(p).includes(V.ecrit));
  if (!hits.length) return vide;
  return {
    task: 'KNOWLEDGE_QUERY', outcome: 'CONSTITUENTS', reason: 'simulé',
    findings: hits.slice(0, 5).map((h) => ({ target: modele.cle, rawValue: V.ecrit, evidenceRefs: [h.ref], excerpt: V.ecrit, confidence: modele.confiance, meaning: 'simulé (e2e)' })),
  };
}

scenario('L91B-REPRISE-SANS-SILENCE', 'Reprise des propriétés manquantes : toute issue persistée, aucune sortie silencieuse (lot 91B)', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T4'] });
  const fichierT3 = readFileSync(join(process.cwd(), 'src/services/ai/prompts/reconciliation/t3_master_v1.txt'), 'utf8');
  let k: OperationsKit;
  let PRIX: { key: string };
  let enVigueur: Record<string, string | undefined> = {};

  /** Version BO de test du prompt T3 : branche KNOWLEDGE_QUERY, avec ou sans le contrat d'entrée v2. */
  const capacite = async (v2: boolean) => {
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    __setActiveMasterPromptsForTests([{ id: v2 ? 99102 : 99101, treatment: 'T3', versionNumber: v2 ? 912 : 911,
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
    PRIX = listFields('IMMOBILIER').find((d) => d.valueType === 'money_eur' && !cat.exclusionOf(d, sujet))!;
    expect(PRIX).toBeTruthy();
  });
  beforeEach(async () => {
    Object.assign(modele, { appels: [], cle: PRIX.key, confiance: 'certain', panne: false });
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
  /**
   * Document rattaché dont la connaissance T1 porte la valeur SANS clé canonique : fait requalifié en connaissance
   * générique (clé brute = clé du registre, clé de fait voisine), valeur dans la seule colonne numérique.
   */
  async function documentSansCle(c: AccountRow, assetId: number, title: string) {
    const f = await make.assetFile(c, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${title}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    const [{ id: ext }] = await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, title, document_type_code, full_text, full_text_chars)
      VALUES (${c.id}, ${f.id}, ${title}, NULL, '', 0) RETURNING id`;
    const [{ id: fait }] = await sql<{ id: number }[]>`
      INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, value_number, value_unit, confidence, excerpt,
                                  canonical_key, raw_key, raw_value, target_type, target_entity_id, projection_origin, projection_rule)
      VALUES (${c.id}, ${f.id}, ${ext}, ${PRIX.key.toLowerCase()}, 'Montant', NULL, ${V.nombre}, 'EUR', 'certain', ${`Montant convenu : ${V.ecrit} EUR`},
              NULL, ${PRIX.key}, NULL, 'GENERIC_KNOWLEDGE', NULL, 'GENERIC', 'TEST_REQUALIFIED_RULE') RETURNING id`;
    return { fileId: f.id, factId: Number(fait) };
  }
  /** Événement de référence réel portant le montant (composante), sans fait sur son document. */
  async function operation(c: AccountRow, assetId: number) {
    const fileId = await k.document(c, assetId, [cand({ targetHints: [cible(assetId)], financialHints: [fh('FORECAST_COST', V.minor)] })], { title: 'Pièce comptable' });
    await k.passer(c);
    return fileId;
  }
  /** Cas de référence : bien, deux documents (faits sans clé canonique), un événement de référence. */
  async function casDeReference(c: AccountRow) {
    const m = await maison(c);
    const d1 = await documentSansCle(c, m.id, 'Pièce 1');
    const d2 = await documentSansCle(c, m.id, 'Pièce 2');
    const dOp = await operation(c, m.id);
    return { m, d1, d2, dOp };
  }
  const valeur = async (c: AccountRow, assetId: number) => {
    const { getCanonicalAssetState } = await import('@/services/canonical/asset-state');
    return (await getCanonicalAssetState(assetId, c.id))!.fields[PRIX.key]?.value ?? null;
  };
  const runs = (c: AccountRow) => sql<Json[]>`
    SELECT id::int AS id, account_id, asset_id, object_type, object_id, status, cause, contract_state, campaign_id::int AS campaign_id, trigger_code, run_ref, context_fp, prompt_version,
           contract_version, batch_fp, properties, calls, attempts, retry_at, created_at, updated_at
      FROM property_recovery_runs WHERE account_id = ${c.id} ORDER BY id`;
  const decisions = (c: AccountRow) => sql<Json[]>`
    SELECT field_key, decision, cause, value_after, proposed_value, provenance FROM property_recovery_decisions WHERE account_id = ${c.id} ORDER BY id`;
  const decisionPrix = async (c: AccountRow) => (await decisions(c)).find((d) => d.field_key === PRIX.key) ?? null;
  const ecritures = (c: AccountRow) => sql<Json[]>`
    SELECT canonical_key, new_value, origin, outcome FROM canonical_field_writes WHERE account_id = ${c.id} AND source_type = 'coherence_missing_property' ORDER BY id`;
  const campagne = (c: AccountRow, mode: 'DRY_RUN' | 'CORRECTIVE' = 'CORRECTIVE', today = AUJ) => runCoherenceFor(sql, [c.id], { mode, today });

  // ══ L91B-E2E-01 ═══════════════════════════════════════════════════════════

  it('L91B-E2E-01 — cas de référence : contrat absent, à blanc, puis contrat livré — jamais « vide + 0 run + 0 décision »', async () => {
    const c = await compte();
    const { m, d1, d2 } = await casDeReference(c);
    expect(await valeur(c, m.id)).toBeNull();

    // Les faits SANS clé canonique (clé voisine, valeur numérique seule) sont bien collectés pour T3.
    const { missingPropertiesState } = await import('@/services/ai/reconciliation/missing-properties/service');
    const st = (await missingPropertiesState(c.id, { type: 'ASSET', id: m.id }))!;
    const faits = st.plan.pages.flatMap((p) => p.elements).filter((e) => e.layer === 'FACT');
    expect(faits.map((e) => e.fileId).sort()).toEqual([d1.fileId, d2.fileId].sort());
    expect(faits.every((e) => e.kind === PRIX.key && e.value === String(V.nombre) && (e.text ?? '').includes(V.ecrit))).toBe(true);
    expect(st.pending.map((p) => p.key)).toContain(PRIX.key);

    // 1. Prompt T3 actif SANS le contrat : aucun appel, aucune écriture… mais une issue PERSISTÉE, un constat non résolu, une alerte.
    await capacite(false);
    const r1 = await campagne(c);
    expect(r1.status).toBe('COMPLETE');
    expect(modele.appels).toHaveLength(0);
    expect(await valeur(c, m.id)).toBeNull();
    expect(await decisions(c)).toEqual([]);
    const [attente, ...autres] = await runs(c);
    expect(autres).toEqual([]);
    expect(attente).toMatchObject({
      account_id: c.id, asset_id: m.id, object_type: 'ASSET', object_id: m.id, status: 'CONTRACT_PENDING', contract_state: 'MARKER_MISSING',
      campaign_id: r1.campaignId, trigger_code: 'COHERENCE:MANUAL', contract_version: 't3-knowledge-query-v2', calls: 0, retry_at: null,
    });
    expect(attente.properties).toContain(PRIX.key);
    // Empreinte du contexte COURANT (la campagne a pu enrichir le contexte : titres, Agenda de l'événement de référence).
    expect(attente.context_fp).toBe((await missingPropertiesState(c.id, { type: 'ASSET', id: m.id }))!.contextFingerprint);
    expect(attente.prompt_version).not.toBe('');
    expect(attente.cause).toMatch(/t3-knowledge-query-v2/);
    expect(attente.cause).toMatch(/88B-t3-proprietes-manquantes/);
    expect(attente.run_ref).toBe(`coherence:manual-${r1.campaignId}:${CHECK}`);
    const p1 = (await proofOf(sql, c.id, CHECK, m.id))!;
    expect(p1).toMatchObject({ last_result: 'FINDING' });
    expect(p1.finding).toMatchObject({ anomaly: 'MISSING_PROPERTY_ARBITRATION_PENDING' });
    // Supervision : signalée dès le premier constat (défaut de configuration exploitable).
    const { computeCoherenceAlerts } = await import('@/services/coherence/supervision');
    const alertes = await computeCoherenceAlerts(new Date(), sql);
    const alerte = alertes.find((a) => a.fingerprint === 'other:coherence:coh-missing-properties:missing_property_arbitration_pending');
    expect(alerte).toBeTruthy();
    expect(alerte!.count).toBeGreaterThanOrEqual(1);
    // Rejeu : même ligne (observations cumulées), jamais de doublon.
    await campagne(c);
    const apres = await runs(c);
    expect(apres).toHaveLength(1);
    expect(apres[0]).toMatchObject({ status: 'CONTRACT_PENDING', attempts: 2 });

    // 2. Contrat livré, campagne À BLANC : aucune IA, aucune écriture — issue DRY_RUN persistée, constat non résolu.
    await capacite(true);
    await campagne(c, 'DRY_RUN');
    expect(modele.appels).toHaveLength(0);
    expect(await valeur(c, m.id)).toBeNull();
    expect((await proofOf(sql, c.id, CHECK, m.id))).toMatchObject({ last_result: 'WOULD_REPAIR' });
    const blanc = (await runs(c)).find((r) => r.status === 'DRY_RUN')!;
    expect(blanc).toMatchObject({ contract_state: 'CARRIED', calls: 0, trigger_code: 'COHERENCE:MANUAL' });
    expect(blanc.cause).toMatch(/CAMPAIGN_DRY_RUN/);

    // 3. Campagne CORRECTIVE : T3 reçoit les faits sans clé canonique et la composante ; valeur écrite par le writer canonique.
    const r3 = await campagne(c);
    expect(r3.status).toBe('COMPLETE');
    const avecPrix = modele.appels.filter((a) => a.candidats.some((x) => x.key === PRIX.key));
    expect(avecPrix).toHaveLength(1);
    expect(avecPrix[0].preuves.filter((p) => p.layer === 'FACT').map((p) => p.ref).sort()).toEqual([`F-${d1.factId}`, `F-${d2.factId}`].sort());
    expect(avecPrix[0].preuves.some((p) => p.layer === 'OPERATION_COMPONENT' && (p.value ?? '').includes(V.composante))).toBe(true);
    expect(await valeur(c, m.id)).toBe(V.nombre);
    const d = (await decisionPrix(c))!;
    expect(d).toMatchObject({ decision: 'WRITTEN', cause: null, value_after: V.nombre });
    expect(d.provenance.cited.documents).toEqual(expect.arrayContaining([d1.fileId, d2.fileId]));
    expect(await ecritures(c)).toEqual([expect.objectContaining({ canonical_key: PRIX.key, new_value: V.nombre, origin: 'RECONCILIATION', outcome: 'written' })]);
    const analyse = (await runs(c)).find((r) => r.status === 'ANSWERED')!;
    expect(analyse).toMatchObject({ campaign_id: r3.campaignId, contract_state: 'CARRIED', trigger_code: 'COHERENCE:MANUAL' });
    expect(analyse.calls).toBeGreaterThanOrEqual(1);
    expect(await proofOf(sql, c.id, CHECK, m.id)).toMatchObject({ last_result: 'REPAIRED' });

    // Idempotence : convergence puis aucun rappel, aucune nouvelle ligne.
    await campagne(c);
    const n = { appels: modele.appels.length, runs: (await runs(c)).length, decisions: (await decisions(c)).length };
    await campagne(c);
    expect({ appels: modele.appels.length, runs: (await runs(c)).length, decisions: (await decisions(c)).length }).toEqual(n);
    expect(await ecritures(c)).toHaveLength(1);
    expect(await proofOf(sql, c.id, CHECK, m.id)).toMatchObject({ last_result: 'CONSISTENT' });
  });

  // ══ L91B-E2E-02 ═══════════════════════════════════════════════════════════

  it('L91B-E2E-02 — T3 s’abstient : ABSTAINED + cause, rien écrit ; correction de l’utilisateur jamais soumise', async () => {
    const c = await compte();
    const { m } = await casDeReference(c);
    modele.confiance = 'probable';
    await campagne(c);
    expect(await valeur(c, m.id)).toBeNull();
    expect(await decisionPrix(c)).toMatchObject({ decision: 'ABSTAINED', cause: 'INSUFFICIENT_CONFIDENCE', proposed_value: V.nombre, value_after: null });
    expect((await runs(c)).map((r) => r.status)).toContain('ANSWERED');
    expect(await ecritures(c)).toEqual([]);
    expect(await proofOf(sql, c.id, CHECK, m.id)).toMatchObject({ last_result: 'AMBIGUOUS' });

    // Valeur effacée par l'utilisateur : protégée — jamais soumise, jamais écrite, aucune issue ne la cite.
    modele.confiance = 'certain';
    modele.appels = [];
    const cu = await compte();
    const { m: mu } = await casDeReference(cu);
    const canon = await import('@/services/canonical/asset-state');
    await canon.writeCanonicalAssetFields({ assetId: mu.id, accountId: cu.id, origin: 'USER', source: { type: 'e2e' }, writes: [{ key: PRIX.key, value: 1 }] });
    await canon.writeCanonicalAssetFields({ assetId: mu.id, accountId: cu.id, origin: 'USER', source: { type: 'e2e' }, writes: [{ key: PRIX.key, value: null }] });
    await capacite(false);
    await campagne(cu);
    await capacite(true);
    await campagne(cu);
    expect(await valeur(cu, mu.id)).toBeNull();
    expect(await decisionPrix(cu)).toBeNull();
    expect((await runs(cu)).every((r) => !(r.properties as string[]).includes(PRIX.key))).toBe(true);
    expect(modele.appels.every((a) => !a.candidats.some((x) => x.key === PRIX.key))).toBe(true);
  });

  // ══ L91B-E2E-03 ═══════════════════════════════════════════════════════════

  it('L91B-E2E-03 — campagne quotidienne : objet sélectionné ; budget, panne, nouvelle tentative, anti-boucle persistés', async () => {
    const orch = await import('@/services/coherence/orchestrator');
    /** Campagne QUOTIDIENNE bornée au compte (date propre au test : une seule campagne du jour par date). */
    const quotidienne = async (c: AccountRow, jour: string) => {
      const now = new Date(`${jour}T08:00:00Z`);
      const id = await orch.startCampaign({ kind: 'DAILY', trigger: 'schedule', mode: 'CORRECTIVE', scopeAccountIds: [c.id], now, deadlineAt: null });
      for (let i = 0; i < 40; i++) if ((await orch.runCampaignStep(id, { deadline: Date.now() + 120_000, now, today: jour })).done) break;
      return (await orch.getCampaign(id))!;
    };
    try {
      // Budget épuisé : aucun appel, issue BUDGET_EXHAUSTED avec cause et prochaine tentative ; objet sélectionné par la quotidienne.
      process.env.T3_KNOWLEDGE_QUERY_DAILY_MAX = '0';
      const c = await compte();
      const { m } = await casDeReference(c);
      const q1 = await quotidienne(c, '2037-09-14');
      expect(q1.kind).toBe('DAILY');
      expect(modele.appels).toHaveLength(0);
      const [proofQ] = await sql<Json[]>`SELECT last_trigger, last_campaign_id::int AS last_campaign_id, last_result FROM coherence_object_proofs WHERE account_id = ${c.id} AND check_id = ${CHECK} AND object_id = ${m.id}`;
      expect(proofQ).toMatchObject({ last_trigger: 'DAILY', last_campaign_id: q1.id });
      expect(proofQ.last_result).not.toMatch(/^(CONSISTENT|REPAIRED|GONE)$/);
      const [budget] = await runs(c);
      expect(budget).toMatchObject({ status: 'BUDGET_EXHAUSTED', calls: 0, campaign_id: q1.id, trigger_code: 'COHERENCE:DAILY' });
      expect(budget.cause).toMatch(/T3_KNOWLEDGE_QUERY_DAILY_MAX/);
      expect(budget.retry_at).not.toBeNull();
      expect(await valeur(c, m.id)).toBeNull();
      // Même jour, mêmes entrées (nouvelle campagne exhaustive) : anti-boucle du moteur — l'issue REPAIR_SUPPRESSED est elle aussi persistée.
      await campagne(c, 'CORRECTIVE', '2037-09-14');
      const supprime = (await runs(c)).find((r) => r.status === 'REPAIR_SUPPRESSED');
      expect(supprime?.cause ?? '').toMatch(/ANTI_LOOP/);
      restaurerEnv();
      process.env.T3_MISSING_PROPERTIES_PER_CALL = '40';

      // Panne IA : AI_FAILED avec nouvelle tentative différée ; le lendemain (tentative pas encore due) : RETRY_SCHEDULED persisté.
      const c2 = await compte();
      const { m: m2 } = await casDeReference(c2);
      modele.panne = true;
      await quotidienne(c2, '2037-09-15');
      modele.panne = false;
      const echec = (await runs(c2)).find((r) => r.status === 'AI_FAILED')!;
      expect(echec).toMatchObject({ trigger_code: 'COHERENCE:DAILY' });
      expect(echec.cause).toMatch(/AI_CALL_FAILED/);
      expect(echec.retry_at).not.toBeNull();
      const appels = modele.appels.length;
      await quotidienne(c2, '2037-09-16');
      expect(modele.appels.length).toBe(appels);
      const attente = (await runs(c2)).find((r) => r.status === 'RETRY_SCHEDULED')!;
      expect(attente.batch_fp).toMatch(/^gate:/);
      expect(new Date(attente.retry_at).getTime()).toBe(new Date(echec.retry_at).getTime());
      // La ligne d'issue ne remplace pas l'analyse en échec (tentatives conservées).
      expect((await runs(c2)).find((r) => r.id === echec.id)).toMatchObject({ status: 'AI_FAILED', attempts: 1 });
      expect(await valeur(c2, m2.id)).toBeNull();
      expect(await decisions(c2)).toEqual([]);
    } finally {
      restaurerEnv();
    }
  });

  // ══ L91B-E2E-04 ═══════════════════════════════════════════════════════════

  it('L91B-E2E-04 — rattrapage des objets jamais examinés : NOT_SELECTED, contrôle ciblé, décision ; simulation sans écriture ; idempotent', async () => {
    const orch = await import('@/services/coherence/orchestrator');
    const c = await compte();
    const { m } = await casDeReference(c);
    expect(await proofOf(sql, c.id, CHECK, m.id)).toBeNull();

    // Simulation : l'objet est listé, rien n'est écrit.
    const sim = await orch.requestCatchupChecks({ apply: false, accountId: c.id, sql });
    expect(sim.items).toEqual(expect.arrayContaining([{ checkId: CHECK, accountId: c.id, objectId: m.id, reason: 'NEVER_CONTROLLED' }]));
    expect(await runs(c)).toEqual([]);
    expect(await proofOf(sql, c.id, CHECK, m.id)).toBeNull();

    // Application : trace NOT_SELECTED + contrôle ciblé demandé, exécuté sans nouvel upload ni modification de l'utilisateur.
    const app = await orch.requestCatchupChecks({ apply: true, accountId: c.id, sql });
    expect(app.requested[CHECK]).toBeGreaterThanOrEqual(1);
    const [nonSel] = await runs(c);
    expect(nonSel).toMatchObject({ status: 'NOT_SELECTED', trigger_code: 'CATCHUP', object_id: m.id, calls: 0 });
    expect(nonSel.cause).toMatch(/NEVER_CONTROLLED/);
    const [demande] = await sql<Json[]>`SELECT request_reason FROM coherence_object_proofs WHERE account_id = ${c.id} AND check_id = ${CHECK} AND object_id = ${m.id}`;
    expect(demande.request_reason).toBe('CATCHUP:NEVER_CONTROLLED');
    await orch.runTargetedChecks({ deadline: Date.now() + 120_000, sql, mode: 'CORRECTIVE', today: AUJ });
    expect(await valeur(c, m.id)).toBe(V.nombre);
    expect(await decisionPrix(c)).toMatchObject({ decision: 'WRITTEN' });
    expect((await runs(c)).find((r) => r.status === 'ANSWERED')).toMatchObject({ trigger_code: 'COHERENCE:TARGETED' });

    // Rejoué : rien n'est redemandé (objet contrôlé, issue récente).
    const encore = await orch.requestCatchupChecks({ apply: true, accountId: c.id, sql });
    expect(encore.requested[CHECK] ?? 0).toBe(0);

    // Bloc BO : même sélection (simulation, aucun écrit) et synthèse lisible.
    const c2 = await compte();
    await casDeReference(c2);
    const { executeBackfill } = await import('@/services/admin/ops/backfill/executors');
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    const out = await executeBackfill(sql, { script: 'missing-properties-catchup', action: 'simulate', step: null, runId: null, accountId: c2.id, reason: null },
      { log: () => {}, progress: () => {} });
    expect(summarizeBackfill('missing-properties-catchup', 'simulate', null, out).headline).toMatch(/1 objet\(s\) à reprendre/);
    expect(await runs(c2)).toEqual([]);
  });
});
