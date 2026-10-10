/**
 * Lot 34 — ticket T2 « Que dois-je faire aujourd'hui ? », de bout en bout
 * sur PostgreSQL réel : routage, contrat de sources, lectures canoniques SQL
 * (`canonical/actionables` : « À traiter » ouverts, échéances actives), période
 * calculée, ordre, déduplication, isolation (compte, biens archivés,
 * documents supprimés, HISTORICAL, échéances closes), trace persistée.
 *
 * TEMP-01 à TEMP-12 du ticket, avec compteur d'appels LLM (passerelle
 * rejouée, aucun enregistrement fourni : tout appel serait compté).
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander, useTargetState } from '../chain';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
type Reponse = Awaited<ReturnType<typeof demander>>;

scenario('L34-TEMP', 'Lot 34 — T2 : demandes d’actions temporelles → données actionnables, sans repli documentaire', ({ sql, make, useRecordings }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });

  let replay: Awaited<ReturnType<typeof useRecordings>>;
  let J = '';
  const decale = (n: number) => {
    const [a, m, d] = J.split('-').map(Number);
    return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
  };

  beforeAll(async () => {
    replay = await useRecordings([]);
    const { aujourdhuiParis } = await import('@/services/verebona-assistant/core/query-period');
    J = aujourdhuiParis();
  });

  const compte = async (): Promise<Compte> => {
    const a = await make.account({ plan: 'premium' });
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const bien = async (c: Compte, name: string, status = 'EN_SERVICE') => {
    const a = await make.asset({ id: c.id, ownerUserId: c.ownerUserId } as never, { category: 'VEHICULE', name });
    await sql`UPDATE assets SET status = ${status} WHERE id = ${a.id}`;
    return a.id;
  };
  const echeance = async (c: Compte, assetIds: number[], title: string, date: string, o: { nature?: string; statut?: string } = {}) => {
    const i = await make.agendaItem({ id: c.id, ownerUserId: c.ownerUserId } as never, { title, startDate: date, assetIds });
    await sql`UPDATE agenda_items SET event_nature = ${o.nature ?? 'DEADLINE'}, manual_status = ${o.statut ?? null} WHERE id = ${i.id}`;
    return i.id;
  };
  const document = async (c: Compte, assetId: number | null, titre: string) => {
    const f = await make.assetFile({ id: c.id, ownerUserId: c.ownerUserId } as never, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${titre}, original_filename = ${`${titre}.pdf`}, analysis_state = 'ANALYZED',
              extracted_text = ${`${titre} — que faire aujourd'hui, entretien, échéance, à traiter`} WHERE id = ${f.id}`;
    return f.id;
  };
  /** « À traiter » ouvert (producteur réel), échéance facultative. */
  const aTraiter = async (c: Compte, cible: { type: 'ASSET' | 'DOCUMENT' | 'AGENDA_ITEM'; id: number }, fieldKey: string, due?: string) => {
    const { upsertAction } = await import('@/services/to-process/to-process-action.service');
    const r = await upsertAction({ accountId: c.id, targetType: cible.type, targetId: cible.id, fieldKey, actionKind: 'COMPLETE', ruleCode: 'DATA-REGISTRATION' });
    const id = (r as { actionId: number }).actionId;
    expect(id).toBeGreaterThan(0);
    if (due) await sql`UPDATE to_process_actions SET due_date = (${due}::date + time '12:00') AT TIME ZONE 'Europe/Paris' WHERE id = ${id}`;
    return id;
  };

  const appelsAvant = () => replay.calls.length;
  /** Invariants : 0 appel modèle, aucune source documentaire, trace SQL canonique sans repli. */
  const verifier = (r: Reponse, avant: number) => {
    expect(replay.calls.length - avant).toBe(0);
    expect(r.cascade?.aiCalls).toBe(0);
    expect(r.cascade?.strategy).toBe('structured.actionable');
    expect(r.sources.every((s) => s.type === 'to_process_item' || s.type === 'agenda_item')).toBe(true);
    expect(r.answer).not.toMatch(/semblent li/);
    expect(r.cascade?.actionable).toMatchObject({ resolution: 'SUCCESS', queryStrategy: 'SQL_CANONICAL', fallbackUsed: false, answeredBy: 'structured' });
  };
  const ids = (r: Reponse) => r.sources.map((s) => s.id);
  const demande = async (c: Compte, q: string) => {
    const avant = appelsAvant();
    const r = await demander(c, q);
    verifier(r, avant);
    return r;
  };

  it('TEMP-01 — aucune action, documents présents : 0 résultat (SUCCESS), aucun document, pas de repli ; trace persistée', async () => {
    const c = await compte();
    const polo = await bien(c, 'Polo');
    for (const t of ['32501387723_2026-03-15', 'Justificatif d’entretien 7', 'Notice de montage du lit enfant Chamonix']) await document(c, polo, t);
    const r = await demande(c, 'Que dois-je faire aujourd’hui ?');
    expect(r.route?.intent).toBe('ACCOUNT_TO_PROCESS');
    expect(r.sources).toEqual([]);
    expect(r.answer).toMatch(/^Rien à faire pour aujourd’hui/);
    expect(r.cascade?.actionable).toMatchObject({
      intentResolution: 'ACTIONS_TEMPORAL', requestedTimeScope: 'TODAY', resolvedStartDate: J, resolvedEndDate: J,
      allowedSourceTypes: ['TODO', 'DEADLINE'], queriedSources: ['TODO', 'DEADLINE'], resultCount: 0,
    });
    const [run] = await sql<{ t: { actionable?: { intentResolution: string; resultCount: number }; fallbackUsed?: boolean } }[]>`
      SELECT retrieval_methods_json AS t FROM verebona_request_runs WHERE request_id = ${r.requestId}`;
    expect(run?.t?.actionable).toMatchObject({ intentResolution: 'ACTIONS_TEMPORAL', resultCount: 0 });
    expect(run?.t?.fallbackUsed).toBe(false);
  });

  it('TEMP-02 — échéance aujourd’hui active : retournée (DUE_TODAY)', async () => {
    const c = await compte();
    const polo = await bien(c, 'Polo');
    const e = await echeance(c, [polo], 'Entretien voiture', J);
    const r = await demande(c, 'Que dois-je faire aujourd’hui ?');
    expect(ids(r)).toEqual([`agenda_${e}`]);
    expect(r.cascade?.actionable?.results[0]).toMatchObject({ sourceType: 'DEADLINE', reasonForInclusion: 'DUE_TODAY', dueDate: J, relatedAssetId: polo });
  });

  it('TEMP-03 / TEMP-04 — échéance d’hier active : OVERDUE ; réalisée ou annulée : exclue ; HISTORICAL : exclue', async () => {
    const c = await compte();
    const polo = await bien(c, 'Polo');
    const active = await echeance(c, [polo], 'Contrôle technique', decale(-1));
    await echeance(c, [polo], 'Vidange réalisée', decale(-1), { statut: 'realise' });
    await echeance(c, [polo], 'Révision annulée', decale(-2), { statut: 'annule' });
    await echeance(c, [polo], 'Achat de la Polo', decale(-3), { nature: 'HISTORICAL' });
    const r = await demande(c, 'Que dois-je faire aujourd’hui ?');
    expect(ids(r)).toEqual([`agenda_${active}`]);
    expect(r.cascade?.actionable?.results[0]).toMatchObject({ reasonForInclusion: 'OVERDUE', dueDate: decale(-1) });
    expect(r.answer).not.toMatch(/Vidange réalisée|Révision annulée|Achat de la Polo/);
  });

  it('TEMP-05 — « Qu’est-ce que je dois traiter ? » : À traiter ouverts, alignés sur la page À traiter ; résolus exclus', async () => {
    const c = await compte();
    const polo = await bien(c, 'Polo');
    const clio = await bien(c, 'Clio');
    const ouvert = await aTraiter(c, { type: 'ASSET', id: polo }, 'registrationNumber');
    const resolu = await aTraiter(c, { type: 'ASSET', id: clio }, 'registrationNumber');
    await sql`UPDATE to_process_actions SET resolved_at = now(), resolution_reason = 'USER_COMPLETED' WHERE id = ${resolu}`;
    await echeance(c, [polo], 'Échéance du jour', J);
    const r = await demande(c, 'Qu’est-ce que je dois traiter ?');
    expect(r.route?.intent).toBe('ACCOUNT_TO_PROCESS');
    expect(ids(r)).toEqual([`todo_${ouvert}`]);
    expect(r.cascade?.actionable).toMatchObject({ intentResolution: 'TO_PROCESS_OPEN', queriedSources: ['TODO'], todoCount: 1, deadlineCount: 0 });
    const { getToProcessPage } = await import('@/services/to-process/to-process-query.service');
    expect((await getToProcessPage(c.id)).total).toBe(1);
  });

  it('TEMP-06 — compte avec seulement factures, notices, contrats : aucun document présenté comme une action', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison');
    const titres = ['Facture EDF mars', 'Notice lave-linge', 'Contrat assurance habitation'];
    for (const t of titres) await document(c, maison, t);
    for (const q of ['Que dois-je faire aujourd’hui ?', 'Qu’est-ce qui est urgent ?', 'Est-ce que j’ai quelque chose en retard ?', 'Qu’est-ce que j’ai cette semaine ?']) {
      const r = await demande(c, q);
      expect(r.sources, q).toEqual([]);
      for (const t of titres) expect(r.answer, q).not.toContain(t);
    }
  });

  it('TEMP-07 — échéance du jour + document associé : échéance principale, document en contexte seulement', async () => {
    const c = await compte();
    const maison = await bien(c, 'Maison');
    const e = await echeance(c, [maison], 'Entretien annuel chaudière', J);
    const contrat = await document(c, maison, 'Contrat entretien chaudière');
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id) VALUES (${e}, ${contrat})`;
    const r = await demande(c, 'Que dois-je faire aujourd’hui ?');
    expect(ids(r)).toEqual([`agenda_${e}`]);
    expect(r.cascade?.actionable?.results[0]).toMatchObject({ sourceType: 'DEADLINE', reasonForInclusion: 'DUE_TODAY', contextDocumentIds: [contrat] });
    expect(r.answer).toContain('document associé : « Contrat entretien chaudière »');
  });

  it('TEMP-08 — formulations équivalentes : même domaine, mêmes résultats', async () => {
    const c = await compte();
    const polo = await bien(c, 'Polo');
    const e = await echeance(c, [polo], 'Entretien voiture', J);
    const t = await aTraiter(c, { type: 'ASSET', id: polo }, 'registrationNumber');
    for (const q of ['Que dois-je faire aujourd’hui ?', 'Qu’est-ce que j’ai à faire aujourd’hui ?', 'J’ai quoi à faire aujourd’hui ?', 'J’ai quoi aujourd’hui ?']) {
      const r = await demande(c, q);
      expect(r.cascade?.actionable?.intentResolution, q).toBe('ACTIONS_TEMPORAL');
      expect(ids(r), q).toEqual([`agenda_${e}`, `todo_${t}`]);
    }
  });

  it('TEMP-09 — « Quelles sont mes échéances aujourd’hui ? » : 1 échéance, aucun À traiter injecté', async () => {
    const c = await compte();
    const polo = await bien(c, 'Polo');
    const clio = await bien(c, 'Clio');
    const maison = await bien(c, 'Maison');
    const e = await echeance(c, [polo], 'Contrôle chaudière', J);
    for (const id of [polo, clio, maison]) await aTraiter(c, { type: 'ASSET', id }, 'registrationNumber');
    const r = await demande(c, 'Quelles sont mes échéances aujourd’hui ?');
    expect(r.route?.intent).toBe('ACCOUNT_SEARCH_AGENDA');
    expect(ids(r)).toEqual([`agenda_${e}`]);
    expect(r.cascade?.actionable).toMatchObject({ intentResolution: 'DEADLINES_PERIOD', queriedSources: ['DEADLINE'], todoCount: 0, resultCount: 1 });
  });

  it('TEMP-10 — « Est-ce que j’ai quelque chose en retard ? » : seulement les éléments échus et encore actifs', async () => {
    const c = await compte();
    const polo = await bien(c, 'Polo');
    const clio = await bien(c, 'Clio');
    const retard = await echeance(c, [polo], 'Contrôle technique', decale(-10));
    await echeance(c, [polo], 'Vidange faite', decale(-5), { statut: 'realise' });
    await echeance(c, [polo], 'Du jour', J);
    await echeance(c, [polo], 'Plus tard', decale(20));
    const todoRetard = await aTraiter(c, { type: 'ASSET', id: polo }, 'registrationNumber', decale(-1));
    await aTraiter(c, { type: 'ASSET', id: clio }, 'registrationNumber');
    const r = await demande(c, 'Est-ce que j’ai quelque chose en retard ?');
    expect(r.cascade?.actionable?.intentResolution).toBe('ACTIONS_OVERDUE');
    expect(ids(r)).toEqual([`agenda_${retard}`, `todo_${todoRetard}`]);
    expect(r.cascade?.actionable?.results.every((x) => x.reasonForInclusion === 'OVERDUE')).toBe(true);
  });

  it('TEMP-11 — période : « cette semaine » et « demain » filtrés sur la période calculée', async () => {
    const { analyserPorteeTemporelle } = await import('@/services/verebona-assistant/core/query-period');
    const semaine = analyserPorteeTemporelle('cette semaine', J);
    const c = await compte();
    const polo = await bien(c, 'Polo');
    const finSemaine = await echeance(c, [polo], 'Fin de semaine', semaine.to!);
    const apres = await echeance(c, [polo], 'Semaine suivante', decale(Math.round((Date.parse(semaine.to!) - Date.parse(J)) / 86_400_000) + 1));
    const demainId = await echeance(c, [polo], 'Demain', decale(1));
    const sansDate = await aTraiter(c, { type: 'ASSET', id: polo }, 'registrationNumber');

    const r = await demande(c, 'Qu’est-ce que j’ai cette semaine ?');
    expect(r.cascade?.actionable).toMatchObject({ requestedTimeScope: 'THIS_WEEK', resolvedStartDate: semaine.from, resolvedEndDate: semaine.to });
    expect(ids(r)).toContain(`agenda_${finSemaine}`);
    expect(ids(r)).not.toContain(`agenda_${apres}`);
    expect(ids(r)).not.toContain(`todo_${sansDate}`);
    if (decale(1) <= semaine.to!) expect(ids(r)).toContain(`agenda_${demainId}`);

    const d = await demande(c, 'Que dois-je faire demain ?');
    expect(d.cascade?.actionable).toMatchObject({ requestedTimeScope: 'TOMORROW', resolvedStartDate: decale(1), resolvedEndDate: decale(1) });
    // Même date (samedi : la fin de semaine est demain) → ordre stable par identifiant, comparé sans ordre.
    expect([...ids(d)].sort()).toEqual([`agenda_${demainId}`, ...(semaine.to === decale(1) ? [`agenda_${finSemaine}`] : [])].sort());
  });

  it('TEMP-12 — nombreux documents sans action : résultat identique', async () => {
    const c = await compte();
    const polo = await bien(c, 'Polo');
    await echeance(c, [polo], 'Entretien', J);
    await echeance(c, [polo], 'Retard', decale(-2));
    await aTraiter(c, { type: 'ASSET', id: polo }, 'registrationNumber');
    const avant = await demande(c, 'Que dois-je faire aujourd’hui ?');
    for (let i = 0; i < 40; i += 1) await document(c, i % 2 ? polo : null, `Document ${i} à faire aujourd’hui`);
    const apres = await demande(c, 'Que dois-je faire aujourd’hui ?');
    expect(apres.answer).toBe(avant.answer);
    expect(apres.cascade?.actionable?.results).toEqual(avant.cascade?.actionable?.results);
  });

  it('Isolation — autre compte, bien archivé, document supprimé : jamais lus', async () => {
    const c = await compte();
    const polo = await bien(c, 'Polo');
    const vieille = await bien(c, 'Vieille Clio', 'ARCHIVED');
    const ok = await echeance(c, [polo], 'Visible', J);
    await echeance(c, [vieille], 'Bien archivé', J);
    await aTraiter(c, { type: 'ASSET', id: vieille }, 'registrationNumber');
    const supprime = await document(c, polo, 'Supprimé');
    await aTraiter(c, { type: 'DOCUMENT', id: supprime }, 'documentType');
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${supprime}`;
    const autre = await compte();
    const autreBien = await bien(autre, 'Polo voisine');
    await echeance(autre, [autreBien], 'Autre compte', J);
    await aTraiter(autre, { type: 'ASSET', id: autreBien }, 'registrationNumber');

    const r = await demande(c, 'Que dois-je faire aujourd’hui ?');
    expect(ids(r)).toEqual([`agenda_${ok}`]);
    expect(r.answer).not.toMatch(/Bien archivé|Autre compte|Supprimé/);
  });

  it('Déduplication — carte « réalisée ? » sur une échéance en retard : un seul résultat (l’échéance)', async () => {
    const c = await compte();
    const polo = await bien(c, 'Polo');
    const e = await echeance(c, [polo], 'Contrôle technique', decale(-3));
    const carte = await aTraiter(c, { type: 'AGENDA_ITEM', id: e }, 'manualStatus');
    const r = await demande(c, 'Que dois-je faire aujourd’hui ?');
    expect(ids(r)).toEqual([`agenda_${e}`]);
    expect(r.cascade?.actionable?.results[0].mergedSourceIds).toEqual([`todo_${carte}`]);
  });
});
