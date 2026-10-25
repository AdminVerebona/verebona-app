/**
 * Lot 61 — tickets « BUG P1 — À traiter : écarts résiduels du lot 58B »
 * (ATR-R-xx) et « [P1] Fiabiliser la pertinence des cartes et résoudre
 * automatiquement les informations déductibles » (ATR-P-xx), sur
 * PostgreSQL 16 réel (migrations 0418, 0444-0446 appliquées par le
 * bootstrap e2e).
 *
 * Connaissance T1 PERSISTÉE (extraction, faits, unités, nom de fichier),
 * dates RELATIVES au jour d'exécution. T4 (CLASSIFY_EVENT, contrat de
 * référence `t4_output_v3`) est SIMULÉ de façon GÉNÉRIQUE : il ne lit que le
 * contexte d'exécution transmis (preuve, demande « À traiter ») — une
 * démarche citée dans la preuve devient une intervention qui cite ce passage,
 * une date inconnue d'un contrat récent est jugée utile, le reste n'appelle
 * aucune intervention. Aucune règle propre à un type de document ni au
 * gardiennage de pneus dans le code testé. La recette avec le VÉRITABLE T4
 * se lance en préproduction depuis le BO (ATR-R-08).
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { setDefaultResponder } from '../replay-gateway';
import { useTargetState } from '../chain';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };

const jour = (decalage: number) => {
  const d = new Date(Date.now() + decalage * 86_400_000);
  const iso = d.toISOString().slice(0, 10);
  const [y, m, j] = iso.split('-');
  return { iso, slash: `${j}/${m}/${y}`, deuxPoints: `${j}:${m}:${y}` };
};
const PASSE = jour(-40);
const PROCHE = jour(50);
const LOIN = jour(500);
const ANCIEN = jour(-3300);

let t4Mode: 'model' | 'failure' | 'invalid' | 'ambiguous' = 'model';
/** T4 simulé GÉNÉRIQUE (voir l'en-tête) — sortie `t4_output_v3`. */
function t4Simule(input: { prompt: string }): unknown {
  if (t4Mode === 'failure') throw Object.assign(new Error('T4 indisponible (e2e)'), { code: 'PROVIDER_UNAVAILABLE' });
  const i = input.prompt.indexOf('\nEXECUTION_CONTEXT\n');
  const ctx = i >= 0 ? JSON.parse(input.prompt.slice(i + '\nEXECUTION_CONTEXT\n'.length).split('\n')[0]) as { event_context?: Record<string, any>; evidence?: string | null } : {};
  const demande = ctx.event_context?.toProcessAssessment as { situation: string; documentTitle: string | null } | undefined;
  const base = { task: 'CLASSIFY_EVENT', agendaDecision: 'accept', recurrenceDecision: 'not_applicable', homeCategory: 'information', businessType: null, confidence: 'certain', reason: 'simulé', recurrenceReason: null };
  if (t4Mode === 'invalid') return { ...base, intervention: { needed: 'yes', kind: 'INVENTED', action: null, justification: 'x', consequence: null, evidence: null, timing: 'NONE', actBy: 'demain', dataNeeded: null } };
  if (!demande) return { ...base, intervention: null };
  if (t4Mode === 'ambiguous') return { ...base, intervention: { needed: 'uncertain', kind: null, action: null, justification: 'données insuffisantes (simulé)', consequence: null, evidence: null, timing: 'NONE', actBy: null, dataNeeded: null } };
  const preuve = ctx.evidence ?? '';
  // Démarche ENCORE attendue (jamais une simple mention : « sans reconduction » n'en est pas une).
  const phrase = preuve.split(/(?<=\.)\s+/).find((p) => /restituer|reconduit tacitement|sauf résiliation/i.test(p)) ?? null;
  // Lot 75I : une échéance CONNUE (passée ou à venir) est jugée sur les mêmes clauses.
  const intervention = phrase && (demande.situation === 'PAST_DEADLINE' || !!(demande as { knownDate?: string }).knownDate)
    ? { needed: 'yes', kind: /restituer/i.test(phrase) ? 'RETURN_OR_RESTITUTE' : 'RENEW_OR_DECIDE', action: /restituer/i.test(phrase) ? 'Restituer le matériel loué' : 'Décider de la reconduction du contrat',
      justification: 'démarche prévue par le document (simulé)', consequence: 'facturation (simulé)', evidence: phrase.slice(0, 200), timing: 'NOW', actBy: null, dataNeeded: false }
    : demande.situation === 'UNDATED'
      ? { needed: 'yes', kind: 'PROVIDE_INFORMATION', action: 'Indiquer la date de fin du contrat', justification: 'contrat en cours (simulé)', consequence: null, evidence: null, timing: 'NOW', actBy: null, dataNeeded: true }
      : { needed: 'no', kind: null, action: null, justification: 'aucune démarche restante (simulé)', consequence: null, evidence: null, timing: 'NONE', actBy: null, dataNeeded: false };
  return { ...base, homeCategory: intervention.needed === 'yes' ? 'action' : 'information', intervention };
}

scenario('L61-ATR', 'À traiter : écarts 58B et pertinence des cartes (ATR-R-01 à ATR-R-08, ATR-P-01 à ATR-P-12)', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState({}, { masters: ['T1', 'T4'], t4Responder: null });
  beforeAll(() => { setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', t4Simule); });
  afterAll(() => { setDefaultResponder('t4_classify_event', 'CLASSIFY_EVENT', null); });
  afterEach(() => { t4Mode = 'model'; });

  const connaissance = async (compte: Compte, fileId: number, p: {
    title: string; type?: string; fullText?: string | null; filename?: string;
    facts?: Array<{ key?: string | null; raw?: string; label?: string; value: string; norm?: string | null; confidence?: string; excerpt?: string }>;
    units?: Array<{ kind: string; label?: string | null; value?: string | null; text?: string | null; coverage?: string }>;
  }) => {
    const [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, title, document_type_code, full_text, full_text_chars)
      VALUES (${compte.id}, ${fileId}, ${p.title}, ${p.type ?? 'SERVICE_CONTRACT'}, ${p.fullText ?? null}, ${p.fullText?.length ?? 0})
      RETURNING id`;
    await sql`UPDATE asset_files SET document_type_code = ${p.type ?? 'SERVICE_CONTRACT'}, analysis_state = 'ANALYZED',
                     original_filename = ${p.filename ?? 'Contrat.pdf'} WHERE id = ${fileId}`;
    for (const f of p.facts ?? []) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, normalized_value, confidence, excerpt, canonical_key)
                VALUES (${compte.id}, ${fileId}, ${id}, ${f.raw ?? f.key ?? 'fait'}, ${f.label ?? null}, ${f.value},
                        ${f.norm === undefined ? f.value : f.norm}, ${f.confidence ?? 'certain'},
                        ${f.excerpt ?? `${f.label ?? f.key ?? 'fait'} : ${f.value}`}, ${f.key ?? null})`;
    }
    let n = 0;
    for (const u of p.units ?? []) {
      n += 1;
      await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, ordinal, content_text, label, value_text, coverage_status)
                VALUES (${compte.id}, ${fileId}, ${id}, ${`u${n}`}, ${u.kind}, ${n}, ${u.text ?? null}, ${u.label ?? null}, ${u.value ?? null}, ${u.coverage ?? 'COVERED'})`;
    }
    return id;
  };
  const doc = async (compte: Compte, p: Parameters<typeof connaissance>[2]) => {
    const f = await make.assetFile(compte, { assetId: null });
    await connaissance(compte, f.id, p);
    return f.id;
  };
  const carte = async (compte: Compte, fileId: number, kind = 'COMPLETE', field = 'contractEndDate', rule = 'DATA-CONTRACT-END') =>
    (await sql<{ id: number }[]>`
      INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question, proposals_json)
      VALUES (${compte.id}, 'DOCUMENT', ${fileId}, ${field}, ${kind}, ${rule}, 'Quelle est la date de fin de ce contrat ?',
              ${kind === 'ARBITRATE' ? JSON.stringify([{ value: LOIN.iso, label: LOIN.slash, confidence: 0.6 }]) : null}::jsonb)
      RETURNING id`)[0].id;
  const cartes = async (fileId: number, field = 'contractEndDate') => sql<Array<{ id: number; public_id: string; kind: string; open: boolean; reason: string | null; question: string; p: unknown }>>`
    SELECT id, public_id, action_kind AS kind, resolved_at IS NULL AS open, resolution_reason AS reason, question, proposals_json AS p
      FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} AND field_key = ${field} ORDER BY id`;
  const ouvertes = async (fileId: number, field = 'contractEndDate') => (await cartes(fileId, field)).filter((c) => c.open);
  const valeur = async (fileId: number, key = 'contractEndDate') => (await sql<Array<{ v: string | null; u: boolean; kind: string | null; derivation: any }>>`
    SELECT value_text AS v, user_validated AS u, value_kind AS kind, derivation FROM document_field_values WHERE file_id = ${fileId} AND field_key = ${key}`)[0] ?? null;
  const balayage = async (compte: Compte) => (await import('@/services/to-process/producers.service')).produceDocumentActions(compte.id);
  const diag = async (fileId: number, rule = 'DATA-CONTRACT-END') => sql<Array<Record<string, any>>>`
    SELECT * FROM document_rule_evaluations WHERE file_id = ${fileId} AND rule_code = ${rule} ORDER BY id`;
  const appelsT4 = (replay: { calls: Array<{ operationCode?: string }> }) => replay.calls.filter((c) => c.operationCode === 't4_classify_event');
  const evenements = async (actionId: number) => sql<Array<{ event: string; details: any }>>`SELECT event, details FROM to_process_action_events WHERE action_id = ${actionId} ORDER BY id`;

  // ════════════════════════════════════════════════════════════════════════
  // Ticket 1 — écarts résiduels du 58B
  // ════════════════════════════════════════════════════════════════════════

  it('ATR-R-01 — date T1 fiable : écrite, RELUE puis carte fermée dans la même transaction (écriture confirmée tracée)', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat', facts: [{ key: 'contractEndDate', value: PROCHE.iso }] });
    const c = await carte(compte, f);
    await balayage(compte);
    expect(await valeur(f)).toMatchObject({ v: PROCHE.iso, u: false, kind: 'EXPLICIT' });
    expect((await cartes(f)).find((x) => x.id === c)).toMatchObject({ open: false, reason: 'OBSOLETE' });
    expect((await evenements(c))[0]).toMatchObject({ event: 'OBSOLETE', details: { reason: 'AUTO_RESOLVED', valueKind: 'EXPLICIT' } });
    expect((await diag(f)).at(-1)).toMatchObject({ decision: 'WRITE', write_verified: true, outcome: 'AUTO_RESOLVED', write_result: { status: 'CONFIRMED', confirmed: true } });
    expect((await diag(f)).at(-1)!.action_ids.closed).toContain(c);
  });

  it('ATR-R-01 — écriture échouée (BDD) ou NON confirmée à la relecture : carte conservée, aucune fermeture, erreur tracée', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat', facts: [{ key: 'contractEndDate', value: PROCHE.iso }] });
    const c = await carte(compte, f);
    await sql.unsafe(`CREATE OR REPLACE FUNCTION e2e_l61_refus() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.file_id = ${f} AND NEW.origin <> 'USER' THEN RAISE EXCEPTION 'écriture refusée (e2e)'; END IF; RETURN NEW; END $$`);
    await sql.unsafe(`CREATE TRIGGER e2e_l61_refus BEFORE INSERT OR UPDATE ON document_field_values FOR EACH ROW EXECUTE FUNCTION e2e_l61_refus()`);
    let r: Awaited<ReturnType<typeof balayage>>;
    try {
      r = await balayage(compte);
    } finally {
      await sql.unsafe(`DROP TRIGGER e2e_l61_refus ON document_field_values`);
    }
    expect((await cartes(f)).find((x) => x.id === c)?.open).toBe(true);
    expect(await valeur(f)).toBeNull();
    expect((await diag(f)).at(-1)).toMatchObject({ decision: 'ERROR', outcome: 'ERROR', failed_step: 'WRITE', error_kind: 'PERSISTENCE_FAILED' });
    expect(r.ruleErrors).toEqual([expect.objectContaining({ accountId: compte.id, fileId: f, ruleCode: 'DATA-CONTRACT-END', step: 'WRITE' })]);

    // Relecture différente de la valeur écrite (écriture altérée) : NON confirmée → annulée.
    const g = await doc(compte, { title: 'Contrat', facts: [{ key: 'contractEndDate', value: PROCHE.iso }] });
    const cg = await carte(compte, g);
    await sql.unsafe(`CREATE OR REPLACE FUNCTION e2e_l61_altere() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.file_id = ${g} AND NEW.origin <> 'USER' THEN NEW.value_text := '1999-01-01'; END IF; RETURN NEW; END $$`);
    await sql.unsafe(`CREATE TRIGGER e2e_l61_altere BEFORE INSERT OR UPDATE ON document_field_values FOR EACH ROW EXECUTE FUNCTION e2e_l61_altere()`);
    try {
      await balayage(compte);
    } finally {
      await sql.unsafe(`DROP TRIGGER e2e_l61_altere ON document_field_values`);
    }
    expect((await cartes(g)).find((x) => x.id === cg)?.open).toBe(true);
    expect(await valeur(g)).toBeNull();
    expect((await diag(g)).at(-1)).toMatchObject({ decision: 'ERROR', reason_code: 'PERSISTENCE_FAILED', write_verified: false, write_result: { status: 'NOT_CONFIRMED' } });
    // Reprise : écriture possible → résolue.
    await balayage(compte);
    expect((await cartes(g)).find((x) => x.id === cg)?.open).toBe(false);
    expect((await valeur(g))?.v).toBe(PROCHE.iso);
  });

  it('ATR-R-01 — écriture concurrente d’une valeur utilisateur pendant la transaction : jamais écrasée, aucune fermeture incohérente', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat', facts: [{ key: 'contractEndDate', value: PROCHE.iso }] });
    const c = await carte(compte, f);
    // La fermeture de la carte (dans la transaction) déclenche, AVANT l'écriture automatique, une saisie utilisateur concurrente.
    await sql.unsafe(`CREATE OR REPLACE FUNCTION e2e_l61_concurrent() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO document_field_values (account_id, file_id, field_key, value_text, origin, user_validated)
        VALUES (NEW.account_id, NEW.target_id, 'contractEndDate', '${LOIN.iso}', 'USER', true) ON CONFLICT DO NOTHING;
        RETURN NEW;
      END $$`);
    await sql.unsafe(`CREATE TRIGGER e2e_l61_concurrent AFTER UPDATE OF resolved_at ON to_process_actions FOR EACH ROW WHEN (NEW.id = ${c}) EXECUTE FUNCTION e2e_l61_concurrent()`);
    try {
      await balayage(compte);
    } finally {
      await sql.unsafe(`DROP TRIGGER e2e_l61_concurrent ON to_process_actions`);
    }
    // Écriture refusée par la base (valeur utilisateur) → toute la transaction annulée : carte ouverte.
    expect((await cartes(f)).find((x) => x.id === c)?.open).toBe(true);
    expect((await diag(f)).at(-1)).toMatchObject({ outcome: 'KEEP', reason_code: 'WRITE_REFUSED_PROTECTED_VALUE', write_result: { status: 'REFUSED_PROTECTED_VALUE' } });
    // Valeur utilisateur réellement présente : jamais écrasée, la carte se ferme pour ce motif.
    await sql`INSERT INTO document_field_values (account_id, file_id, field_key, value_text, origin, user_validated)
              VALUES (${compte.id}, ${f}, 'contractEndDate', ${LOIN.iso}, 'USER', true)`;
    const { onDocumentEditedByUser } = await import('@/services/to-process/document-rule-bridge');
    await onDocumentEditedByUser(compte.id, f);
    expect(await valeur(f)).toMatchObject({ v: LOIN.iso, u: true });
    expect((await cartes(f)).find((x) => x.id === c)).toMatchObject({ open: false, reason: 'USER_COMPLETED' });
    expect((await diag(f)).at(-1)).toMatchObject({ trigger_code: 'USER', decision: 'CLOSE' });
  });

  it('ATR-R-02 — obligation réelle (T4 : intervention citée) : carte décrivant l’ACTION, jamais « Quelle est la date de fin ? » ; décision utilisateur respectée', async () => {
    const compte = await make.account();
    const preuve = 'À la fin du contrat, le locataire doit restituer le matériel loué dans un délai de 30 jours.';
    const f = await doc(compte, { title: 'Contrat de location — box',
      facts: [{ key: null, raw: 'finContrat', value: PASSE.slash, norm: null, confidence: 'probable', excerpt: preuve }] });
    const ancienne = await carte(compte, f);
    const replay = await rejouer([]);
    await balayage(compte);
    expect(await ouvertes(f)).toHaveLength(0);
    expect((await cartes(f)).find((x) => x.id === ancienne)).toMatchObject({ open: false, reason: 'OBSOLETE' });
    expect((await evenements(ancienne)).at(-1)?.details).toMatchObject({ reason: 'REPLACED_BY_INTERVENTION', pertinence: 'ACTION_REQUIRED' });
    const [iv] = await ouvertes(f, 'intervention:contractEndDate');
    expect(iv).toMatchObject({ kind: 'ARBITRATE', question: 'Restituer le matériel loué' });
    expect(iv.question).not.toMatch(/date de fin/i);
    expect(appelsT4(replay)).toHaveLength(1);
    const d = (await diag(f)).at(-1)!;
    expect(d).toMatchObject({ outcome: 'CREATE_ACTION', pertinence: 'ACTION_REQUIRED', situation: 'PAST_DEADLINE' });
    expect(d.decision_contract).toMatchObject({ version: 'atr-decision-v1', problem: 'DEADLINE_INTERVENTION', card: 'INTERVENTION',
      intervention: { kind: 'RETURN_OR_RESTITUTE', action: 'Restituer le matériel loué' }, interventionDetail: { evidence: expect.stringContaining('restituer') } });
    expect(d.action_ids.intervention).toEqual([expect.any(Number)]);

    // L'utilisateur répond « C'est fait » : carte close, jamais recréée sans élément nouveau, IA non rappelée.
    const { resolveArbitration, undoArbitration } = await import('@/services/to-process/resolve-action.service');
    expect(await resolveArbitration(compte.id, iv.public_id, 'DONE', { userId: compte.ownerUserId })).toMatchObject({ ok: true });
    for (let i = 0; i < 2; i += 1) await balayage(compte);
    expect(await ouvertes(f, 'intervention:contractEndDate')).toHaveLength(0);
    expect(await ouvertes(f)).toHaveLength(0);
    expect(appelsT4(replay)).toHaveLength(1);
    // « Annuler » : la MÊME carte est rouverte.
    expect(await undoArbitration(compte.id, iv.public_id, null)).toMatchObject({ ok: true });
    expect((await ouvertes(f, 'intervention:contractEndDate'))[0]?.id).toBe(iv.id);
    expect(await resolveArbitration(compte.id, iv.public_id, 'AUTRE')).toMatchObject({ ok: false, error: 'INVALID_VALUE' });
  });

  it('ATR-R-03 — document historique sans date fiable : pas de question systématique, aucun appel IA, contrat jamais déclaré terminé', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat d’entretien', facts: [{ key: 'documentDate', value: ANCIEN.iso }] });
    const replay = await rejouer([]);
    await balayage(compte);
    expect(await cartes(f)).toHaveLength(0);
    expect(await valeur(f)).toBeNull();
    expect(appelsT4(replay)).toHaveLength(0);
    // Lot 72 (C2, ATP-FIX-05) : l'ancienneté n'est qu'un indice — décision DIFFÉRÉE sans carte, jamais « sans enjeu ».
    expect((await diag(f))[0]).toMatchObject({ outcome: 'DEFER', pertinence: 'UNDATED_HISTORICAL', reason_code: 'DEFERRED' });
  });

  it('ATR-R-04 — cache invalidé : correction de clause / fait (même sans asset_files.updated_at), configuration IA activée ; sinon aucun appel', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat de location', facts: [{ key: null, raw: 'finContrat', value: PASSE.slash, norm: null, confidence: 'probable', excerpt: 'Le contrat a pris fin sans reconduction.' }] });
    const replay = await rejouer([]);
    const { documentsToReevaluate } = await import('@/services/to-process/document-rule-bridge');
    const ev = await import('@/services/to-process/document-field-evidence');
    await balayage(compte);
    await balayage(compte);
    expect(appelsT4(replay)).toHaveLength(1);
    expect((await diag(f)).at(-1)).toMatchObject({ outcome: 'NO_ACTION', pertinence: 'NO_ACTION_NEEDED' });
    expect(await documentsToReevaluate(compte.id)).not.toContain(f);
    // Fait corrigé (clause modifiée) SANS toucher asset_files.updated_at : réévalué.
    const avant = (await sql<{ u: string }[]>`SELECT updated_at::text AS u FROM asset_files WHERE id = ${f}`)[0].u;
    await sql`UPDATE document_facts SET status = 'superseded' WHERE file_id = ${f}`;
    await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, value_text, normalized_value, confidence, excerpt)
              SELECT ${compte.id}, ${f}, id, 'finContrat', ${PASSE.slash}, NULL, 'probable', 'Contrat reconduit tacitement sauf résiliation.' FROM document_extractions WHERE file_id = ${f}`;
    expect((await sql<{ u: string }[]>`SELECT updated_at::text AS u FROM asset_files WHERE id = ${f}`)[0].u).toBe(avant);
    expect(await documentsToReevaluate(compte.id)).toContain(f);
    await balayage(compte);
    expect(appelsT4(replay)).toHaveLength(2);
    expect(await ouvertes(f, 'intervention:contractEndDate')).toHaveLength(1);
    // Configuration IA changée (nouvelle version T4 activée dans le BO) : décision différée réévaluée.
    const g = await doc(compte, { title: `Avis d’échéance`, filename: `Echeance ${PASSE.deuxPoints}.pdf` });
    await balayage(compte);
    expect((await diag(g)).at(-1)).toMatchObject({ outcome: 'DEFER' });
    expect(await documentsToReevaluate(compte.id)).not.toContain(g);
    ev.__setT4AssessmentConfigForTests({ ref: 'bo:v99:t4_output_v3', interventionCapable: true });
    try {
      expect(await documentsToReevaluate(compte.id)).toContain(g);
    } finally { ev.__setT4AssessmentConfigForTests(null); }
  });

  it('ATR-R-05 — lecture impossible, T4 en erreur, BDD : erreur visible (bilan, diagnostic), AUCUNE fausse résolution', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat', filename: `Contrat ${PASSE.deuxPoints}.pdf` });
    const c = await carte(compte, f);
    await sql`ALTER TABLE document_facts RENAME TO document_facts_e2e`;
    let r: Awaited<ReturnType<typeof balayage>>;
    try {
      r = await balayage(compte);
    } finally {
      await sql`ALTER TABLE document_facts_e2e RENAME TO document_facts`;
    }
    expect((await cartes(f)).find((x) => x.id === c)?.open).toBe(true);
    expect((await diag(f)).at(-1)).toMatchObject({ decision: 'ERROR', outcome: 'ERROR', error_kind: 'READ_FAILED', failed_step: 'KNOWLEDGE' });
    expect(r.ruleErrors[0]).toMatchObject({ accountId: compte.id, fileId: f, ruleCode: 'DATA-CONTRACT-END', step: 'KNOWLEDGE' });
    expect(r.ruleErrors[0].cause).toMatch(/document_facts/);
    // Bilan global du compte (balayage horaire) : l'erreur remonte, identifiée.
    const { produceAccountActions } = await import('@/services/to-process/producers.service');
    await sql`ALTER TABLE document_facts RENAME TO document_facts_e2e`;
    let bilan: Awaited<ReturnType<typeof produceAccountActions>>;
    try {
      bilan = await produceAccountActions(compte.id);
    } finally {
      await sql`ALTER TABLE document_facts_e2e RENAME TO document_facts`;
    }
    expect(bilan.errors.join(' | ')).toMatch(new RegExp(`compte ${compte.id} · document ${f} · règle DATA-CONTRACT-END · étape KNOWLEDGE`));
    // T4 en panne : carte existante CONSERVÉE (jamais fermée sur une panne).
    t4Mode = 'failure';
    await balayage(compte);
    expect((await cartes(f)).find((x) => x.id === c)?.open).toBe(true);
    expect((await diag(f)).at(-1)).toMatchObject({ outcome: 'KEEP', reason_code: 'KEPT_ON_TECHNICAL_FAILURE', ai_status: 'ERROR' });
  });

  it('ATR-R-06 — traçabilité : relations, réévaluation d’état, T3, suppression ; passages conservés malgré la déduplication', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const f = await doc(compte, { title: 'Facture', type: 'INVOICE' });
    await sql`UPDATE asset_files SET asset_id = ${bien.id} WHERE id = ${f}`;
    // Carte de rattachement restée ouverte (antérieure au lien) : le balayage la ferme et TRACE la fermeture.
    const [{ id: lien }] = await sql<{ id: number }[]>`INSERT INTO to_process_actions (account_id, target_type, target_id, relation_key, action_kind, rule_code, question)
      VALUES (${compte.id}, 'DOCUMENT', ${f}, 'assetIds', 'COMPLETE', 'LINK-ASSET', 'À quel bien ?') RETURNING id`;
    const { syncDocumentRulesFromState, resolveDocumentRuleFromKnowledge } = await import('@/services/to-process/document-rule-bridge');
    await syncDocumentRulesFromState(compte.id, f, { trigger: 'SWEEP', runRef: 'run:a' });
    expect((await diag(f, 'LINK-ASSET')).at(-1)).toMatchObject({ decision: 'CLOSE', reason_code: 'ALREADY_SATISFIED', trigger_code: 'SWEEP', run_ref: 'run:a' });
    expect((await diag(f, 'LINK-ASSET')).at(-1)!.action_ids.closed).toEqual([lien]);
    expect((await evenements(lien)).at(-1)).toMatchObject({ event: 'OBSOLETE', details: { ruleCode: 'LINK-ASSET', reason: 'ALREADY_SATISFIED' } });

    // Passage T3 sur une carte dont la donnée est déjà renseignée : fermeture tracée (déclencheur T3).
    const g = await doc(compte, { title: 'Contrat' });
    await sql`INSERT INTO document_field_values (account_id, file_id, field_key, value_text, origin, user_validated) VALUES (${compte.id}, ${g}, 'contractEndDate', ${PROCHE.iso}, 'USER', true)`;
    const cg = await carte(compte, g);
    expect(await resolveDocumentRuleFromKnowledge(compte.id, g, 'DATA-CONTRACT-END', { runRef: 't3:run' })).toMatchObject({ status: 'RESOLVED' });
    expect((await diag(g)).at(-1)).toMatchObject({ trigger_code: 'T3', decision: 'CLOSE', run_ref: 't3:run' });
    expect((await diag(g)).at(-1)!.action_ids.closed).toEqual([cg]);

    // Évaluations identiques : une ligne, chaque passage conservé.
    const h = await doc(compte, { title: 'Contrat entretien', facts: [{ key: 'documentDate', value: ANCIEN.iso }] });
    await carte(compte, h);
    await syncDocumentRulesFromState(compte.id, h, { trigger: 'SWEEP', runRef: 'p1' });
    for (const r of ['p2', 'p3']) await syncDocumentRulesFromState(compte.id, h, { trigger: 'SWEEP', runRef: r });
    const lignes = await diag(h);
    expect(lignes.at(-1)!.seen_count).toBeGreaterThanOrEqual(2);
    expect(lignes.at(-1)!.passages.map((p: { runRef: string }) => p.runRef).slice(0, 2)).toEqual(['p3', 'p2']);

    // Document supprimé : cartes fermées, fermeture tracée par règle.
    const k = await doc(compte, { title: 'Contrat' });
    const ck = await carte(compte, k);
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${k}`;
    await syncDocumentRulesFromState(compte.id, k, { trigger: 'SWEEP' });
    expect((await diag(k)).at(-1)).toMatchObject({ decision: 'CLOSE', reason_code: 'TARGET_DELETED' });
    expect((await evenements(ck)).at(-1)).toMatchObject({ event: 'TARGET_DELETED' });

    // Le diagnostic BO expose décision, contrat, cartes et passages.
    const { getT3OpenActionsDiagnostic } = await import('@/services/ai/queue/t3-open-actions-diagnostic');
    const bo = await getT3OpenActionsDiagnostic({ documentId: h, ruleCode: 'DATA-CONTRACT-END' });
    // Lot 72 (C2) : document ancien sans preuve de fin → décision différée (plus « aucune intervention » sur l'âge).
    expect(bo.documentRules![0]).toMatchObject({ outcome: 'DEFER', situation: 'UNDATED', passages: expect.any(Array) });
    expect((await getT3OpenActionsDiagnostic({ accountId: compte.id, result: 'NO_ACTION' })).documentRules!.every((r) => r.outcome === 'NO_ACTION' || r.decision === 'NO_ACTION' || r.reasonCode === 'NO_ACTION')).toBe(true);
  });

  it('ATR-R-08 — sorties T4 ambiguë, incohérente (hors contrat) : aucune carte arbitraire, décision différée, erreur tracée', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat', facts: [{ key: null, raw: 'finContrat', value: PASSE.slash, norm: null, confidence: 'probable', excerpt: 'Fin du contrat.' }] });
    t4Mode = 'ambiguous';
    await balayage(compte);
    expect(await ouvertes(f)).toHaveLength(0);
    expect((await diag(f)).at(-1)).toMatchObject({ outcome: 'DEFER', pertinence: 'UNDECIDED', ai_status: 'OK' });
    const g = await doc(compte, { title: 'Contrat', facts: [{ key: null, raw: 'finContrat', value: PASSE.slash, norm: null, confidence: 'probable', excerpt: 'Fin du contrat.' }] });
    const cg = await carte(compte, g);
    t4Mode = 'invalid';
    await balayage(compte);
    expect((await cartes(g)).find((x) => x.id === cg)?.open).toBe(true);
    expect((await diag(g)).at(-1)).toMatchObject({ ai_status: 'ERROR', pertinence: 'UNDECIDED', outcome: 'KEEP' });
  });

  it('ATR-R-08 — recette « véritable T4 » : corpus livré exécuté par le runner du BO (ici T4 simulé), résultats attendu / obtenu enregistrés', async () => {
    const compte = await make.account();
    const { startRelevanceRecette, listRecetteRuns, RELEVANCE_RECETTE_CASES } = await import('@/services/to-process/relevance-recette');
    const r = await startRelevanceRecette({ accountId: compte.id, userId: compte.ownerUserId });
    expect(r.runId).toEqual(expect.any(Number));
    await r.done;
    const [run] = await listRecetteRuns(1);
    expect(run).toMatchObject({ id: r.runId, status: 'DONE', total: RELEVANCE_RECETTE_CASES.length, configRef: 'repo:t4_output_v3', error: null });
    expect(run.results).toHaveLength(RELEVANCE_RECETTE_CASES.length);
    expect(run.results.filter((x) => !x.ok).map((x) => `${x.caseId}: ${x.problems.join(', ')}`)).toEqual([]);
    expect(run.aiCalls).toBe(RELEVANCE_RECETTE_CASES.filter((c) => !c.deterministic).length);
  });

  // ════════════════════════════════════════════════════════════════════════
  // Ticket 2 — pertinence des cartes et informations déductibles
  // ════════════════════════════════════════════════════════════════════════

  it('ATR-P-01 — prêt avec début effectif et durée fiables : échéance THÉORIQUE calculée (marquée calculée, provenance), sans carte ; recalculée puis retirée quand ses sources changent', async () => {
    const compte = await make.account();
    const debut = jour(-700);
    const f = await doc(compte, { title: 'Offre de prêt immobilier', type: 'FINANCING_CONTRACT',
      facts: [{ key: 'contractStartDate', value: debut.iso }, { key: null, raw: 'dureePret', label: 'Durée du prêt', value: '240 mois', norm: null }] });
    const c = await carte(compte, f);
    const replay = await rejouer([]);
    await balayage(compte);
    const { endFromStart } = await import('@/services/to-process/document-derivations');
    const attendu = endFromStart(debut.iso, 240)!;
    expect(await valeur(f)).toMatchObject({ v: attendu, u: false, kind: 'CALCULATED',
      derivation: { method: 'START_PLUS_DURATION', convention: 'END_INCLUSIVE', start: { value: debut.iso }, duration: { months: 240 } } });
    expect((await cartes(f)).find((x) => x.id === c)).toMatchObject({ open: false });
    expect((await evenements(c)).at(-1)?.details).toMatchObject({ reason: 'AUTO_RESOLVED', valueKind: 'CALCULATED' });
    expect(appelsT4(replay)).toHaveLength(0);
    expect((await diag(f)).at(-1)).toMatchObject({ outcome: 'AUTO_RESOLVED', reason_code: 'CALCULATED_FROM_START_AND_DURATION', write_verified: true });

    // Durée corrigée (25 ans) : recalculée.
    await sql`UPDATE document_facts SET value_text = '25 ans' WHERE file_id = ${f} AND fact_key = 'dureePret'`;
    await sql`UPDATE document_facts SET status = 'superseded' WHERE file_id = ${f} AND fact_key = 'dureePret'`;
    await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, confidence, excerpt)
              SELECT ${compte.id}, ${f}, id, 'dureePret', 'Durée du prêt', '25 ans', 'certain', 'Durée : 25 ans' FROM document_extractions WHERE file_id = ${f}`;
    await balayage(compte);
    expect((await valeur(f))?.v).toBe(endFromStart(debut.iso, 300));
    // Durée disparue : la valeur théorique est retirée (jamais conservée comme une certitude).
    await sql`UPDATE document_facts SET status = 'superseded' WHERE file_id = ${f} AND fact_key = 'dureePret'`;
    await balayage(compte);
    expect(await valeur(f)).toBeNull();
    // Valeur de l'utilisateur : jamais remplacée par un calcul.
    const u = await doc(compte, { title: 'Offre de prêt', type: 'FINANCING_CONTRACT', facts: [{ key: 'contractStartDate', value: debut.iso }, { key: null, raw: 'dureePret', value: '240 mois', norm: null }] });
    await sql`INSERT INTO document_field_values (account_id, file_id, field_key, value_text, origin, user_validated) VALUES (${compte.id}, ${u}, 'contractEndDate', ${LOIN.iso}, 'USER', true)`;
    await balayage(compte);
    expect(await valeur(u)).toMatchObject({ v: LOIN.iso, u: true });
  });

  it('ATR-P-02 — prêt avec simple date d’édition : aucune date de début supposée, rien n’est calculé', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Offre de prêt — édition', type: 'FINANCING_CONTRACT',
      facts: [{ key: 'documentDate', value: jour(-30).iso, label: 'Date d’édition' }, { key: null, raw: 'dureePret', value: '20 ans', norm: null }],
      units: [{ kind: 'LABEL_VALUE', label: 'Date d’édition', value: jour(-30).slash }] });
    await balayage(compte);
    expect(await valeur(f)).toBeNull();
    expect((await diag(f)).at(-1)!.derivation).toMatchObject({ status: 'NOT_DERIVABLE', reason: 'no_effective_start' });
  });

  it('ATR-P-03 — données croisées : même contrat (référence exacte) → résolu ; contrat distinct du même bien → jamais mélangé ; autre compte → jamais lu', async () => {
    const compte = await make.account();
    const autre = await make.account();
    const bien = await make.asset(compte);
    const a = await doc(compte, { title: 'Contrat d’entretien', facts: [{ key: 'contractNumber', value: 'CTR-2024-778812' }] });
    await sql`UPDATE asset_files SET asset_id = ${bien.id} WHERE id = ${a}`;
    await sql`INSERT INTO document_field_values (account_id, file_id, field_key, value_text, origin, user_validated) VALUES (${compte.id}, ${a}, 'contractEndDate', ${PROCHE.iso}, 'USER', true)`;
    const b = await doc(compte, { title: 'Avenant au contrat', facts: [{ key: 'contractNumber', value: 'ctr 2024 778812' }] });
    const c = await doc(compte, { title: 'Autre contrat (même bien)', facts: [{ key: 'contractNumber', value: 'CTR-2023-111111' }] });
    await sql`UPDATE asset_files SET asset_id = ${bien.id} WHERE id IN (${b}, ${c})`;
    const x = await doc(autre, { title: 'Contrat', facts: [{ key: 'contractNumber', value: 'CTR-2024-778812' }] });
    await balayage(compte);
    await balayage(autre);
    expect(await valeur(b)).toMatchObject({ v: PROCHE.iso, u: false, kind: 'EXPLICIT', derivation: { method: 'RELATED_DOCUMENT', documents: [a] } });
    expect(await cartes(b)).toHaveLength(0);
    expect((await valeur(c))?.v ?? null).not.toBe(PROCHE.iso);
    expect((await valeur(x))?.v ?? null).not.toBe(PROCHE.iso);
  });

  it('ATR-P-04 — échéance future lointaine : interpellation différée (carte existante retirée, motif tracé), réévaluée à l’approche', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat', units: [{ kind: 'LABEL_VALUE', label: 'Date de fin de contrat', value: LOIN.slash }] });
    const c = await carte(compte, f, 'ARBITRATE');
    const replay = await rejouer([]);
    await balayage(compte);
    expect((await cartes(f)).find((x) => x.id === c)).toMatchObject({ open: false, reason: 'OBSOLETE' });
    expect((await evenements(c)).at(-1)?.details).toMatchObject({ reason: 'DEFERRED', pertinence: 'FUTURE_DEFERRABLE' });
    const d = (await diag(f)).at(-1)!;
    expect(d).toMatchObject({ outcome: 'DEFER', pertinence: 'FUTURE_DEFERRABLE' });
    expect(new Date(d.reevaluate_at).toISOString().slice(0, 10)).toBe(jour(500 - 120).iso);
    expect(appelsT4(replay)).toHaveLength(0);
    await balayage(compte);
    expect(await ouvertes(f)).toHaveLength(0);
    // L'approche : date de réévaluation atteinte → la question revient (la date compte maintenant).
    await sql`UPDATE document_rule_evaluations SET reevaluate_at = now() - interval '1 minute' WHERE file_id = ${f}`;
    await sql`UPDATE document_source_units SET value_text = ${PROCHE.slash} WHERE file_id = ${f}`;
    await balayage(compte);
    expect((await ouvertes(f))[0]?.kind).toBe('ARBITRATE');
  });

  it('ATR-P-06 — information facultative sans conséquence (fournisseur) : aucune carte ; anomalie de type bloquante : DOC-TYP inchangé', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Facture', type: 'INVOICE' });
    await balayage(compte);
    expect(await cartes(f, 'supplier')).toHaveLength(0);
    const { getRule } = await import('@/services/to-process/rules-catalog');
    expect(getRule('DOC-TYP')!.completePriority).not.toBeNull();
    expect(getRule('DATA-SUPPLIER')!.completePriority).toBeNull();
  });

  it('ATR-P-08 (lot 83E : contrôle de cohérence) — réévaluation RÉTROACTIVE des cartes existantes : issue par carte, idempotente', async () => {
    const compte = await make.account();
    const pret = await doc(compte, { title: 'Offre de prêt', type: 'FINANCING_CONTRACT', facts: [{ key: 'contractStartDate', value: jour(-400).iso }, { key: null, raw: 'dureePret', value: '15 ans', norm: null }] });
    const titre = await doc(compte, { title: 'Avis', filename: `Votre contrat arrive à échéance le ${PASSE.deuxPoints}.pdf` });
    const loin = await doc(compte, { title: 'Contrat', units: [{ kind: 'LABEL_VALUE', label: 'Date de fin de contrat', value: LOIN.slash }] });
    const actif = await doc(compte, { title: 'Contrat de télésurveillance', facts: [{ key: 'contractStartDate', value: jour(-20).iso }] });
    const cartesAvant = { pret: await carte(compte, pret), titre: await carte(compte, titre), loin: await carte(compte, loin, 'ARBITRATE'), actif: await carte(compte, actif) };
    // Lot 83E (C-Q9) : la campagne est RETIRÉE — la même réévaluation (même décision centrale) est faite
    // par le contrôle de cohérence (cartes « donnée » documentaires : COH-TODO-DOCUMENT-FIELDS).
    const { runCoherenceFor, proofOf } = await import('../coherence-run');
    const run = await runCoherenceFor(sql, [compte.id]);
    expect(run.status).toBe('COMPLETE');
    const etat = async (id: number) => (await sql<{ open: boolean; reason: string | null }[]>`
      SELECT a.resolved_at IS NULL AS open, (SELECT ev.details ->> 'reason' FROM to_process_action_events ev WHERE ev.action_id = a.id ORDER BY ev.id DESC LIMIT 1) AS reason
        FROM to_process_actions a WHERE a.id = ${id}`)[0];
    expect(await etat(cartesAvant.pret)).toMatchObject({ open: false });
    expect((await valeur(pret))?.kind).toBe('CALCULATED');
    expect((await etat(cartesAvant.titre)).open).toBe(false);
    expect((await etat(cartesAvant.loin)).open).toBe(false);
    expect(await etat(cartesAvant.actif)).toMatchObject({ open: true });
    for (const id of [cartesAvant.pret, cartesAvant.titre, cartesAvant.loin]) {
      expect((await proofOf(sql, compte.id, 'COH-TODO-DOCUMENT-FIELDS', id))?.last_result, String(id)).toBe('REPAIRED');
    }
    // Aucune suppression physique : les cartes retirées restent (audit).
    expect(await cartes(titre)).toHaveLength(1);
    // Rejouée : aucune nouvelle réparation, aucun doublon.
    // Intégration lot 87 : le contrôle des titres (87D, fin de registre) normalise les titres automatiques
    // au premier passage ; les décisions qui lisent le titre se réalignent au passage suivant. Idempotence
    // vérifiée une fois la campagne convergée.
    await runCoherenceFor(sql, [compte.id]);
    const n = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM coherence_repairs WHERE account_id = ${compte.id}`)[0].n;
    await runCoherenceFor(sql, [compte.id]);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM coherence_repairs WHERE account_id = ${compte.id}`)[0].n).toBe(n);
    // Tâche planifiée déclarée (aucune commande pour l'exploitation).
    const { findTask } = await import('@/services/scheduling/scheduled-tasks.catalog');
    expect(findTask('to-process-relevance-reevaluation')).toMatchObject({ schedule: { kind: 'interval' } });
  });

  it('ATR-P-10 — T6 : une échéance passée « sans intervention » ou tranchée par l’utilisateur n’est pas relancée', async () => {
    const compte = await make.account();
    const f = await doc(compte, { title: 'Contrat de location', facts: [{ key: null, raw: 'finContrat', value: PASSE.slash, norm: null, confidence: 'probable', excerpt: 'Le contrat a pris fin sans reconduction.' }] });
    await balayage(compte);
    expect((await diag(f)).at(-1)).toMatchObject({ pertinence: 'NO_ACTION_NEEDED' });
    const [item] = await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, origin_type, origin_ref_type, origin_ref_id, origin_field_key)
      VALUES (${compte.id}, 'Fin de contrat', ${PASSE.iso}, true, 'qualified_document', 'asset_file', ${f}, 'contractEndDate') RETURNING id`;
    const [futur] = await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, origin_type, origin_ref_type, origin_ref_id, origin_field_key)
      VALUES (${compte.id}, 'Fin de contrat', ${PROCHE.iso}, true, 'qualified_document', 'asset_file', ${f}, 'contractEndDate') RETURNING id`;
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    const raw = await collectMascotData(compte.id);
    expect(raw.toProcessSettledAgendaIds).toContain(item.id);
    expect(raw.toProcessSettledAgendaIds).not.toContain(futur.id);
    const { t6Candidates } = await import('@/services/home/mascot/t6-interpellation.service');
    const c = t6Candidates(raw).find((x) => x.candidate.agendaItemId === item.id);
    if (c) expect(c.candidate.state).toBe('RESOLVED');
  });

  it('ATR-P-12 — isolation des comptes : décisions, mémoire, campagnes et diagnostic restent dans leur compte', async () => {
    const a = await make.account();
    const b = await make.account();
    const fa = await doc(a, { title: 'Contrat de location', facts: [{ key: null, raw: 'finContrat', value: PASSE.slash, norm: null, confidence: 'probable', excerpt: 'Le contrat a pris fin sans reconduction.' }] });
    const fb = await doc(b, { title: 'Contrat de télésurveillance' });
    const replay = await rejouer([]);
    await balayage(a);
    await balayage(b);
    expect(appelsT4(replay)).toHaveLength(2);
    expect((await diag(fa)).every((d) => d.account_id === a.id)).toBe(true);
    expect((await diag(fb)).every((d) => d.account_id === b.id)).toBe(true);
    const { resolveDocumentRuleFromKnowledge } = await import('@/services/to-process/document-rule-bridge');
    expect(await resolveDocumentRuleFromKnowledge(a.id, fb, 'DATA-CONTRACT-END')).toMatchObject({ status: 'TARGET_GONE' });
    expect((await ouvertes(fb))[0]?.kind).toBe('COMPLETE');
  });
});
