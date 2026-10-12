/**
 * Lot 50 — ticket « Mascotte : fiabiliser les sujets affichés et le contexte
 * transmis à T6 », base réelle.
 *
 * MASC50-AC02 : nouveau document réellement en cours d'analyse (traitement
 *               USER) → PROC-DOC-ANALYSIS présent, observé PENDANT l'analyse.
 * MASC50-AC03 : document déjà analysé, réanalyse technique « documents/PUT »
 *               réellement exécutée (T1 rejoué) → aucun PROC-DOC-ANALYSIS,
 *               alors que l'état effectif reste « en cours d'analyse ».
 * MASC50-AC04 : autre réanalyse technique (déplacement, en file) et remise en
 *               file après échec : même comportement, sans exception par
 *               origine ; un document jamais analysé n'est pas masqué.
 * MASC50-AC05/06 : rôle de la date lu dans l'agenda réel (échéance
 *               automatique → DEADLINE ; rendez-vous saisi avec une heure →
 *               SCHEDULED_EVENT), transmis dans les faits.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { sortieT1, useTargetState } from '../chain';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };

scenario('L50', 'Mascotte : réanalyses techniques masquées, rôle des dates', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();

  const sortie = (assetId: number) => sortieT1({
    title: 'Facture d’entretien', date: '2026-09-14', documentTypeCode: 'MAINTENANCE_INVOICE', rubricCode: 'MAINTENANCE_WORKS',
    assets: [{ id: assetId, label: 'Clio' }], facts: [],
  });

  const codes = async (compteId: number) => {
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    const { buildCandidates } = await import('@/services/home/mascot/signals');
    return buildCandidates(await collectMascotData(compteId)).candidates.map((c) => c.sourceCode);
  };
  const etatEffectif = async (fileId: number) => {
    const { effectiveAnalysisStateSql } = await import('@/services/ai/processing-status/effective-state-sql');
    const [r] = await sql.unsafe(`SELECT ${effectiveAnalysisStateSql('f')} AS etat FROM asset_files f WHERE f.id = $1`, [fileId] as never[]);
    return (r as unknown as { etat: string | null }).etat;
  };
  const visibilite = async (fileId: number) =>
    (await sql<{ v: string | null }[]>`SELECT analysis_visibility AS v FROM asset_files WHERE id = ${fileId}`)[0].v;

  /**
   * Analyse par le point d'entrée de production ; `pendant` s'exécute AU
   * MOMENT de l'appel modèle — le document est alors réellement en analyse.
   */
  const analyser = async (
    compte: Compte, fileId: number, assetId: number,
    opts: { origin: string; visibility: 'USER' | 'TECHNICAL'; pendant?: () => Promise<void> },
  ) => {
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = coalesce(original_filename, ${`doc-${fileId}.pdf`})
               WHERE id = ${fileId}`;
    const replay = await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output: sortie(assetId), repeat: true }]);
    const appel = replay.call.bind(replay);
    let observe = false;
    replay.call = async (input) => {
      if (opts.pendant && !observe) { observe = true; await opts.pendant(); }
      return appel(input);
    };
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([fileId], compte.id, {
      userId: compte.ownerUserId, billable: false, origin: opts.origin, processingVisibility: opts.visibility,
    });
    expect(observe || !opts.pendant).toBe(true);
    return r;
  };

  it('MASC50-AC02 — dépôt d’un nouveau document (USER) : PROC-DOC-ANALYSIS pendant l’analyse', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { name: 'Clio' });
    const f = await make.assetFile(compte, { assetId: bien.id });
    let vu: string[] = [];
    let etat: string | null = null;
    await analyser(compte, f.id, bien.id, {
      origin: 'files/confirm', visibility: 'USER',
      pendant: async () => { vu = await codes(compte.id); etat = await etatEffectif(f.id); },
    });
    expect(etat).toBe('ANALYZING');
    expect(vu).toContain('PROC-DOC-ANALYSIS');
    expect(await visibilite(f.id)).toBe('USER');
  });

  it('MASC50-AC03 — rattachement d’un document déjà analysé : réanalyse « documents/PUT » exécutée, jamais présentée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { name: 'Clio' });
    const f = await make.assetFile(compte, { assetId: bien.id });
    await analyser(compte, f.id, bien.id, { origin: 'files/confirm', visibility: 'USER' });
    const [avant] = await sql<{ at: Date | null }[]>`SELECT last_analysis_at AS at FROM asset_files WHERE id = ${f.id}`;
    expect(avant.at).not.toBeNull();

    let vu: string[] = [];
    let etat: string | null = null;
    const r = await analyser(compte, f.id, bien.id, {
      origin: 'documents/PUT', visibility: 'TECHNICAL',
      pendant: async () => { vu = await codes(compte.id); etat = await etatEffectif(f.id); },
    });
    // Le traitement est réel : état effectif « en cours » pendant, analyse aboutie après.
    expect(etat).toBe('ANALYZING');
    expect(r?.results.length).toBe(1);
    const [apres] = await sql<{ at: Date }[]>`SELECT last_analysis_at AS at FROM asset_files WHERE id = ${f.id}`;
    expect(new Date(apres.at).getTime()).toBeGreaterThanOrEqual(new Date(avant.at!).getTime());
    // … mais la mascotte ne le présente pas.
    expect(vu).not.toContain('PROC-DOC-ANALYSIS');
    expect(await visibilite(f.id)).toBe('TECHNICAL');
  });

  it('MASC50-AC04 — autre réanalyse technique en file (déplacement) : masquée, sans exception par origine', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { name: 'Clio' });
    const f = await make.assetFile(compte, { assetId: bien.id });
    await analyser(compte, f.id, bien.id, { origin: 'files/confirm', visibility: 'USER' });

    const { enqueueFileAnalyses } = await import('@/services/ai/source-analysis/queue/t1-handler');
    // Origine quelconque : seule la visibilité déclarée compte.
    const acceptes = await enqueueFileAnalyses([f.id], compte.id, { origin: 'e2e/autre-correction', billable: false, processingVisibility: 'TECHNICAL' });
    expect(acceptes).toEqual([f.id]);
    const [job] = await sql<{ status: string; payload: Record<string, unknown> }[]>`
      SELECT status, payload FROM ai_job_queue WHERE treatment = 'T1' AND target_id = ${String(f.id)} AND status = 'PENDING'`;
    expect(job.payload.processingVisibility).toBe('TECHNICAL');
    expect(await etatEffectif(f.id)).toBe('UPLOADED');
    expect(await codes(compte.id)).not.toContain('PROC-DOC-ANALYSIS');
  });

  it('MASC50-AC04 — document jamais analysé : un traitement technique ne masque pas sa première analyse', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { name: 'Clio' });
    const f = await make.assetFile(compte, { assetId: bien.id });
    const { enqueueFileAnalyses } = await import('@/services/ai/source-analysis/queue/t1-handler');
    expect(await enqueueFileAnalyses([f.id], compte.id, { origin: 'files/confirm', processingVisibility: 'USER' })).toEqual([f.id]);
    const { markAnalysisVisibility } = await import('@/services/ai/processing-status/processing-visibility');
    await markAnalysisVisibility([f.id], compte.id, 'TECHNICAL');
    expect(await visibilite(f.id)).toBe('USER');
    expect(await codes(compte.id)).toContain('PROC-DOC-ANALYSIS');
  });

  it('MASC50-AC04 — échec d’une réanalyse technique hors file : la remise en file hérite de TECHNICAL', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { name: 'Clio' });
    const f = await make.assetFile(compte, { assetId: bien.id });
    await analyser(compte, f.id, bien.id, { origin: 'files/confirm', visibility: 'USER' });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket' WHERE id = ${f.id}`;
    await rejouer([{
      operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output: null, repeat: true,
      error: { message: 'fournisseur indisponible (simulation)', status: 503, recoverable: true },
    }]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    await analyzeFileSources([f.id], compte.id, {
      userId: compte.ownerUserId, billable: false, origin: 'documents/bulk-move', processingVisibility: 'TECHNICAL',
    });
    const jobs = await sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM ai_job_queue WHERE treatment = 'T1' AND target_id = ${String(f.id)} AND status = 'PENDING'`;
    expect(jobs.length).toBe(1);
    expect(jobs[0].payload.processingVisibility).toBe('TECHNICAL');
    expect(await codes(compte.id)).not.toContain('PROC-DOC-ANALYSIS');
  });

  it('MASC50-AC05 / AC06 — rôle de la date lu dans l’agenda réel et transmis dans les faits', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'VEHICULE', name: 'Cupra' });
    await sql`UPDATE assets SET subtype = 'Voiture' WHERE id = ${bien.id}`;
    const ct = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
    const rdv = new Date(Date.now() + 500 * 86_400_000).toISOString().slice(0, 10);
    const echeance = await make.agendaItem(compte, { title: 'Prochain contrôle technique — CUPRA LEON E-HYBRID180', startDate: ct, assetIds: [bien.id] });
    await sql`UPDATE agenda_items SET is_automatic = TRUE, origin_type = 'asset_field' WHERE id = ${echeance.id}`;
    const rendezVous = await make.agendaItem(compte, { title: 'Rendez-vous garage', startDate: rdv, assetIds: [bien.id] });
    await sql`UPDATE agenda_items SET start_time = '09:30' WHERE id = ${rendezVous.id}`;

    const { collectMascotData } = await import('@/services/home/mascot/collector');
    const { buildCandidates, formatDateFr } = await import('@/services/home/mascot/signals');
    const raw = await collectMascotData(compte.id);
    expect(raw.agenda?.find((i) => i.id === echeance.id)?.dateRole).toBe('DEADLINE');
    expect(raw.agenda?.find((i) => i.id === rendezVous.id)?.dateRole).toBe('SCHEDULED_EVENT');

    const s = buildCandidates(raw).candidates.find((c) => c.sourceCode === 'DATE-NEXT')!;
    expect(s.facts).toMatchObject({ dateRole: 'DEADLINE', dateNature: 'confirmée' });
    expect(s.fallbackText).toBe(`Le prochain contrôle technique de la Cupra est à prévoir pour le ${formatDateFr(ct)}.`);
  });
});
