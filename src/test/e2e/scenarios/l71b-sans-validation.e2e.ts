/**
 * Lot 71B — décision PO du 19/10 : « Il ne doit pas y avoir de système de
 * validation sur les fiches. Soit il y a besoin d'une carte À traiter, soit
 * la donnée est ajoutée. » — sur PostgreSQL 16 réel (toutes les migrations,
 * dont 0495).
 *
 * Connaissance T1 PERSISTÉE (extraction, faits, unités), dates RELATIVES au
 * jour d'exécution, T4 simulé de façon générique (comme L58B / L61) : la
 * décision centrale du pont « À traiter » est celle de la production.
 *
 * VALID-02 Valeur fiable (fait certain, sans conflit) d'un document resté
 *          « à valider » : écrite directement par la reprise (valeur
 *          automatique, tracée), aucune carte, document « analysé ».
 * VALID-03 Valeur incertaine (unité « libellé : valeur », non certaine) :
 *          carte « À traiter » ARBITRATE, rien d'écrit.
 * VALID-04 Valeurs contradictoires : carte ARBITRATE avec les deux dates,
 *          rien d'écrit.
 * VALID-05 Valeur saisie par l'utilisateur : jamais écrasée, aucune carte.
 * VALID-06 Reprise idempotente : rejouée → rien de plus (cartes, valeurs,
 *          trace : une ligne par document) ; balayage « À traiter » ensuite
 *          → aucune carte en double ; propositions laissées « pending »
 *          (jamais « kept » = validé par l'utilisateur).
 * VALID-07 Isolation des comptes : reprise limitée à un compte (BO) → l'autre
 *          compte intact ; puis reprise globale → chaque document dans son
 *          compte, aucune donnée croisée.
 * VALID-08 Simulation (BO) : lecture seule — rien n'est écrit ; synthèse BO,
 *          tâche planifiée enregistrée, rattrapage au catalogue BO.
 * VALID-09 Plus aucun producteur de l'état : la fin d'analyse T1 d'un
 *          document multi-biens pose ANALYZED (chaîne de production, sortie
 *          rejouée) ; l'ancien service de validation a disparu.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { setDefaultResponder } from '../replay-gateway';
import { drainQueues, sortieT1, useTargetState } from '../chain';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };

const jour = (decalage: number) => {
  const d = new Date(Date.now() + decalage * 86_400_000);
  const iso = d.toISOString().slice(0, 10);
  const [y, m, j] = iso.split('-');
  return { iso, slash: `${j}/${m}/${y}`, point: `${j}.${m}.${y}` };
};
const FUTUR = jour(250);
const FUTUR2 = jour(400);
const PROCHE = jour(60);
const PROCHE2 = jour(90);

/** T4 simulé GÉNÉRIQUE (même principe que L58B) : seule la date inconnue d'un contrat appelle une intervention. */
function t4Simule(input: { prompt: string }): unknown {
  const i = input.prompt.indexOf('\nEXECUTION_CONTEXT\n');
  const ctx = i >= 0 ? JSON.parse(input.prompt.slice(i + '\nEXECUTION_CONTEXT\n'.length).split('\n')[0]) as { event_context?: Record<string, any> } : {};
  const demande = ctx.event_context?.toProcessAssessment as { situation: string } | undefined;
  const base = { task: 'CLASSIFY_EVENT', agendaDecision: 'accept', recurrenceDecision: 'not_applicable', homeCategory: 'information', businessType: null, confidence: 'certain', reason: 'simulé', recurrenceReason: null };
  if (!demande) return { ...base, intervention: null };
  const intervention = demande.situation === 'UNDATED'
    ? { needed: 'yes', kind: 'PROVIDE_INFORMATION', action: 'Indiquer la date de fin du contrat', justification: 'contrat en cours (simulé)', consequence: null, evidence: null, timing: 'NOW', actBy: null, dataNeeded: true }
    : { needed: 'no', kind: null, action: null, justification: 'aucune démarche restante (simulé)', consequence: null, evidence: null, timing: 'NONE', actBy: null, dataNeeded: false };
  return { ...base, intervention };
}

scenario('L71B', 'Plus de validation sur les fiches : écriture directe ou carte « À traiter » (VALID-02 à VALID-09)', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState({}, { masters: ['T1', 'T4'], t4Responder: null });
  beforeAll(() => { setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', t4Simule); });
  afterAll(() => { setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', null); });

  /**
   * Document tel que l'ancien moteur le laissait : connaissance T1 persistée,
   * run de référence avec propositions « pending », état VALIDATION_REQUIRED.
   */
  const docAValider = async (compte: Compte, p: {
    facts?: Array<{ key?: string | null; raw?: string; value: string; norm?: string | null; confidence?: string }>;
    units?: Array<{ kind: string; label?: string | null; value?: string | null }>;
  }) => {
    const f = await make.assetFile(compte, { assetId: null });
    const [{ id: ext }] = await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, title, document_type_code, full_text, full_text_chars)
      VALUES (${compte.id}, ${f.id}, 'Contrat d’entretien', 'SERVICE_CONTRACT', NULL, 0) RETURNING id`;
    for (const x of p.facts ?? []) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, normalized_value, confidence, excerpt, canonical_key)
                VALUES (${compte.id}, ${f.id}, ${ext}, ${x.raw ?? x.key ?? 'fait'}, NULL, ${x.value}, ${x.norm === undefined ? x.value : x.norm},
                        ${x.confidence ?? 'certain'}, ${`Fin du contrat : ${x.value}`}, ${x.key ?? null})`;
    }
    let n = 0;
    for (const u of p.units ?? []) {
      n += 1;
      await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, ordinal, content_text, label, value_text, coverage_status)
                VALUES (${compte.id}, ${f.id}, ${ext}, ${`u${n}`}, ${u.kind}, ${n}, NULL, ${u.label ?? null}, ${u.value ?? null}, 'COVERED')`;
    }
    const [run] = await sql<{ id: number }[]>`
      INSERT INTO document_analysis_runs (asset_file_id, input_file_hash, prompt_version, provider, model, status, is_current_reference, account_id)
      VALUES (${f.id}, ${`h${f.id}`}, 't1_master_v1@file', 'replay', 'm', 'completed', true, ${compte.id}) RETURNING id`;
    await sql`INSERT INTO document_analysis_proposals (run_id, asset_file_id, proposal_type, target_key, proposed_value_json, confidence, account_id)
              VALUES (${run.id}, ${f.id}, 'field', 'contractEndDate', ${JSON.stringify({ value: p.facts?.[0]?.value ?? null, excerpt: '' })}, 'certain', ${compte.id})`;
    await sql`UPDATE asset_files SET document_type_code = 'SERVICE_CONTRACT', original_filename = 'Contrat.pdf',
                     analysis_state = 'VALIDATION_REQUIRED', last_analysis_at = now() WHERE id = ${f.id}`;
    return f.id;
  };
  const etat = async (fileId: number) => (await sql<{ s: string | null }[]>`SELECT analysis_state AS s FROM asset_files WHERE id = ${fileId}`)[0].s;
  const cartes = async (fileId: number, field = 'contractEndDate') => sql<Array<{ id: number; account_id: number; kind: string; open: boolean; p: unknown }>>`
    SELECT id, account_id, action_kind AS kind, resolved_at IS NULL AS open, proposals_json AS p
      FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} AND field_key = ${field} ORDER BY id`;
  const ouvertes = async (fileId: number) => (await cartes(fileId)).filter((c) => c.open);
  const valeur = async (fileId: number) => (await sql<{ v: string | null; u: boolean; origin: string | null }[]>`
    SELECT value_text AS v, user_validated AS u, origin FROM document_field_values WHERE file_id = ${fileId} AND field_key = 'contractEndDate'`)[0] ?? null;
  const traces = async (fileId: number) => sql<Array<{ account_id: number; origin: string; passes: number; before_state: string; after_state: string; pending_proposals: number; reason: string | null }>>`
    SELECT account_id, origin, passes, before_state, after_state, pending_proposals, reason FROM document_validation_reprise WHERE file_id = ${fileId}`;
  const props = (p: unknown) => ((typeof p === 'string' ? JSON.parse(p) : p) ?? []) as Array<{ value: unknown }>;
  const reprise = async (o: { apply: boolean; accountId?: number; origin?: 'BO' | 'SCHEDULED'; reason?: string }) =>
    (await import('@/services/documents/validation-reprise')).runValidationReprise({ origin: 'BO', ...o });

  it('VALID-02 / VALID-03 / VALID-04 / VALID-05 — reprise : fiable écrite, incertaine et conflit en carte, valeur utilisateur intacte ; plus aucun document « à valider »', async () => {
    const compte = await make.account();
    const fiable = await docAValider(compte, { facts: [{ key: 'contractEndDate', value: FUTUR.iso }] });
    const incertaine = await docAValider(compte, { units: [{ kind: 'LABEL_VALUE', label: 'Date de fin de contrat', value: PROCHE.point }] });
    const conflit = await docAValider(compte, { facts: [{ key: 'contractEndDate', value: PROCHE.iso }, { key: null, raw: 'finContrat', value: PROCHE2.slash, norm: null }] });
    const utilisateur = await docAValider(compte, { facts: [{ key: 'contractEndDate', value: FUTUR2.iso }] });
    await sql`INSERT INTO document_field_values (account_id, file_id, field_key, value_text, origin, user_validated)
              VALUES (${compte.id}, ${utilisateur}, 'contractEndDate', ${FUTUR.iso}, 'USER', true)`;

    const r = await reprise({ apply: true, accountId: compte.id, reason: 'Recette VALID (e2e)' });
    expect(r).toMatchObject({ mode: 'apply', scanned: 4, processed: 4, skipped: 0, failed: [], pendingProposals: 4 });
    expect(r.rules.written).toBeGreaterThanOrEqual(1);
    for (const f of [fiable, incertaine, conflit, utilisateur]) expect(await etat(f)).toBe('ANALYZED');

    // VALID-02 : valeur fiable écrite directement (automatique, jamais « validée par l'utilisateur »), aucune carte.
    expect(await valeur(fiable)).toMatchObject({ v: FUTUR.iso, u: false });
    expect(await ouvertes(fiable)).toHaveLength(0);
    // VALID-03 : valeur incertaine → carte « À traiter », rien d'écrit.
    expect(await valeur(incertaine)).toBeNull();
    const [ci] = await ouvertes(incertaine);
    expect(ci.kind).toBe('ARBITRATE');
    expect(props(ci.p).map((x) => x.value)).toEqual([PROCHE.iso]);
    // VALID-04 : conflit → carte avec les deux valeurs, rien d'écrit.
    expect(await valeur(conflit)).toBeNull();
    const [cc] = await ouvertes(conflit);
    expect(cc.kind).toBe('ARBITRATE');
    expect(props(cc.p).map((x) => x.value).sort()).toEqual([PROCHE.iso, PROCHE2.iso].sort());
    // VALID-05 : valeur utilisateur jamais écrasée, aucune carte.
    expect(await valeur(utilisateur)).toMatchObject({ v: FUTUR.iso, u: true });
    expect(await ouvertes(utilisateur)).toHaveLength(0);

    // Trace : une ligne par document, motif, état avant / après.
    expect(await traces(fiable)).toEqual([expect.objectContaining({
      account_id: compte.id, origin: 'BO', passes: 1, before_state: 'VALIDATION_REQUIRED', after_state: 'ANALYZED', pending_proposals: 1, reason: 'Recette VALID (e2e)',
    })]);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${compte.id} AND analysis_state = 'VALIDATION_REQUIRED'`;
    expect(n).toBe(0);

    // VALID-06 : rejouée → rien ; balayage « À traiter » → aucune carte en double ; propositions jamais « kept ».
    const cartesAvant = await sql`SELECT id, action_kind, resolved_at FROM to_process_actions WHERE account_id = ${compte.id} ORDER BY id`;
    const r2 = await reprise({ apply: true, accountId: compte.id, reason: 'Relance (e2e)' });
    expect(r2).toMatchObject({ scanned: 0, processed: 0 });
    const { produceDocumentActions } = await import('@/services/to-process/producers.service');
    await produceDocumentActions(compte.id);
    expect(await sql`SELECT id, action_kind, resolved_at FROM to_process_actions WHERE account_id = ${compte.id} ORDER BY id`).toEqual(cartesAvant);
    expect(await ouvertes(incertaine)).toHaveLength(1);
    expect(await ouvertes(conflit)).toHaveLength(1);
    expect((await traces(fiable))[0].passes).toBe(1);
    const statuts = await sql<{ status: string }[]>`SELECT DISTINCT status FROM document_analysis_proposals WHERE account_id = ${compte.id}`;
    expect(statuts.map((x) => x.status)).toEqual(['pending']);
  });

  it('VALID-06 — un document repris qui retomberait dans l’ancien état (ancienne instance) : une seule ligne de trace, passes incrémentées, aucune carte en double', async () => {
    const compte = await make.account();
    const f = await docAValider(compte, { facts: [{ key: 'contractEndDate', value: PROCHE.iso }, { key: null, raw: 'finContrat', value: PROCHE2.slash, norm: null }] });
    await reprise({ apply: true, accountId: compte.id });
    await sql`UPDATE asset_files SET analysis_state = 'VALIDATION_REQUIRED' WHERE id = ${f}`;
    await reprise({ apply: true, accountId: compte.id, origin: 'SCHEDULED' });
    expect(await etat(f)).toBe('ANALYZED');
    expect(await traces(f)).toEqual([expect.objectContaining({ passes: 2, origin: 'SCHEDULED' })]);
    expect(await ouvertes(f)).toHaveLength(1);
  });

  it('VALID-07 — isolation des comptes : reprise limitée à un compte, l’autre intact ; reprise globale : chaque carte et valeur dans son compte', async () => {
    const a = await make.account();
    const b = await make.account();
    const fa = await docAValider(a, { facts: [{ key: 'contractEndDate', value: FUTUR.iso }] });
    const fb = await docAValider(b, { units: [{ kind: 'LABEL_VALUE', label: 'Date de fin de contrat', value: PROCHE.point }] });

    const ra = await reprise({ apply: true, accountId: a.id, reason: 'Compte A seul (e2e)' });
    expect(ra).toMatchObject({ scanned: 1, processed: 1 });
    expect(await etat(fa)).toBe('ANALYZED');
    expect(await etat(fb)).toBe('VALIDATION_REQUIRED');
    expect(await cartes(fb)).toHaveLength(0);
    expect(await traces(fb)).toEqual([]);

    await reprise({ apply: true, origin: 'SCHEDULED' });
    expect(await etat(fb)).toBe('ANALYZED');
    expect((await ouvertes(fb)).map((c) => c.account_id)).toEqual([b.id]);
    expect(await sql`SELECT 1 FROM to_process_actions WHERE account_id = ${a.id} AND target_id = ${fb}`).toEqual([]);
    expect(await sql`SELECT 1 FROM document_field_values WHERE account_id = ${a.id} AND file_id = ${fb}`).toEqual([]);
    expect((await traces(fb))[0]).toMatchObject({ account_id: b.id, origin: 'SCHEDULED' });
    expect((await traces(fa))[0]).toMatchObject({ account_id: a.id, origin: 'BO' });
  });

  it('VALID-08 — simulation : lecture seule (état, valeurs, cartes, trace inchangés) ; synthèse BO ; tâche planifiée et rattrapage au catalogue', async () => {
    const compte = await make.account();
    const f = await docAValider(compte, { facts: [{ key: 'contractEndDate', value: FUTUR.iso }] });
    const sim = await reprise({ apply: false, accountId: compte.id });
    expect(sim).toMatchObject({ mode: 'simulate', scanned: 1, processed: 0, pendingProposals: 1, failed: [] });
    expect(await etat(f)).toBe('VALIDATION_REQUIRED');
    expect(await valeur(f)).toBeNull();
    expect(await cartes(f)).toHaveLength(0);
    expect(await traces(f)).toEqual([]);

    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    expect(summarizeBackfill('document-validation', 'simulate', null, { result: sim }).headline).toMatch(/^Simulation : 1 document\(s\) « à valider » à reprendre, 1 proposition\(s\)/);
    const { validateBackfillRequest } = await import('@/services/admin/ops/backfill/definitions');
    expect(validateBackfillRequest({ script: 'document-validation', action: 'apply', accountId: compte.id, reason: 'Recette lot 71B' }))
      .toMatchObject({ ok: true, value: { script: 'document-validation', action: 'apply', accountId: compte.id } });
    expect(validateBackfillRequest({ script: 'document-validation', action: 'apply' })).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });

    // Tâche planifiée : même service, application.
    const { findTask } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const tache = findTask('document-validation-reprise')!;
    expect(tache.schedule).toMatchObject({ kind: 'interval' });
    const note = await tache.run({ deadline: Date.now() + 60_000, trigger: 'manual' });
    expect(note).toMatchObject({ note: expect.stringMatching(/repris/) });
    expect(await etat(f)).toBe('ANALYZED');
    expect(await valeur(f)).toMatchObject({ v: FUTUR.iso, u: false });
    expect(await tache.run({ deadline: Date.now() + 60_000, trigger: 'manual' })).toEqual({ note: 'aucun document « à valider »' });
  });

  it('VALID-09 — fin d’analyse T1 d’un document multi-biens (bien choisi, propositions écrites) : ANALYZED, jamais « à valider » ; service de validation retiré', async () => {
    process.env.OVH_S3_ACCESS_KEY_ID ??= 'e2e';
    process.env.OVH_S3_SECRET_ACCESS_KEY ??= 'e2e';
    process.env.OVH_S3_BUCKET ??= 'e2e-bucket';
    process.env.OVH_S3_ENDPOINT ??= 'http://127.0.0.1:9';
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const studio = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio' });
    const doc = await make.assetFile(compte, { assetId: maison.id });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = 'facture.pdf', analysis_state = NULL WHERE id = ${doc.id}`;
    const sortie = sortieT1({
      title: 'Facture travaux Maison et Studio', date: '2026-09-12', documentTypeCode: 'INVOICE', supplier: 'Chauffage Rhône', amountCents: 18_900,
      multiAsset: true,
      assets: [{ id: maison.id, label: 'Maison' }, { id: studio.id, label: 'Studio' }],
      facts: [{ canonicalKey: null, rawKey: 'prestation', value: 'Entretien chaudière', excerpt: 'Entretien chaudière', assetId: null, valueType: 'string' }],
    });
    await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output: sortie }]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([doc.id], compte.id, { userId: compte.ownerUserId, billable: false, origin: 'e2e/l71b', linkedAssetId: maison.id });
    expect(r?.results.length).toBe(1);
    expect(r!.results[0].warnings.map((w) => w.code)).toContain('MULTI_ASSET_DOCUMENT');
    await drainQueues();
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_analysis_proposals WHERE asset_file_id = ${doc.id}`;
    expect(n).toBeGreaterThan(0);
    expect(['ANALYZED', 'FUSION_SUGGESTED']).toContain(await etat(doc.id));
    expect(await etat(doc.id)).not.toBe('VALIDATION_REQUIRED');

    const { stat } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const existe = (p: string) => stat(join(process.cwd(), p)).then(() => true, () => false);
    expect(await existe('src/app/api/documents/[id]/commit/route.ts')).toBe(false);
    expect(await existe('src/services/documents/document-validation.service.ts')).toBe(false);
  });
});
