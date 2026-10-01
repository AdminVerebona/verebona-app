/**
 * Corpus §15 (CDC 15) — assistant T2 de bout en bout : E2E-T2-01 à E2E-T2-23
 * (hors ceux déjà portés par `t2-routage-cibles` et `p-t2-master`, voir
 * `src/test/e2e/CORPUS-CDC15.md`).
 *
 * Chaîne réelle : `runAssistant` + ports réels sur PostgreSQL, T2 en
 * architecture `master` (version de configuration), lecture canonique
 * (`ASSISTANT_CANONICAL_READ=enabled`) et tous les commutateurs cibles
 * (`TARGET_SWITCHES`). Les sorties modèle (t2_understand, t2_answer,
 * t2_revalidate, t1_analyze_document) sont des enregistrements synthétiques
 * rejoués par la vraie passerelle (D-08) ; aucun réseau (D-17).
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import {
  agenda, analyserDocument, demander, drainQueues, fiche, preuves, sortieT1, useTargetState, type FaitT1,
} from '../chain';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
type Reponse = Awaited<ReturnType<typeof demander>>;

/** Date à J+n (Europe/Paris suffit : écarts de plusieurs jours). */
const jour = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const ids = (r: Reponse) => r.sources.map((s) => s.id);

scenario('CORPUS-T2', 'Corpus §15 — assistant T2 (enabled / master)', ({ sql, make, useRecordings }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });

  const compteDe = async (): Promise<Compte> => {
    const a = await make.account();
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const bien = (c: Compte, name: string, over: Record<string, unknown> = {}) =>
    make.asset({ id: c.id, ownerUserId: c.ownerUserId } as never, { category: 'VEHICULE', name, ...over });
  /** Document déjà analysé (colonnes lues par T2). */
  const doc = async (c: Compte, v: { assetId: number | null; title: string; type: string | null; amount?: number | null; date?: string; supplier?: string | null }) => {
    const f = await make.assetFile({ id: c.id, ownerUserId: c.ownerUserId } as never, { assetId: v.assetId });
    await sql`UPDATE asset_files SET retained_title = ${v.title}, document_type_code = ${v.type}, document_type = NULL,
              amount_cents = ${v.amount ?? null}, document_date = ${v.date ?? '2026-03-01'}, supplier = ${v.supplier ?? null},
              analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    return f;
  };
  const echeance = async (c: Compte, assetId: number, title: string, date: string, over: { nature?: string; businessType?: string } = {}) => {
    const i = await make.agendaItem({ id: c.id, ownerUserId: c.ownerUserId } as never, { title, startDate: date, assetIds: [assetId] });
    if (over.nature || over.businessType) {
      await sql`UPDATE agenda_items SET event_nature = ${over.nature ?? null}, business_type = ${over.businessType ?? null} WHERE id = ${i.id}`;
    }
    return i.id;
  };
  /** Facture d'entretien analysée par la chaîne réelle (T1 → T3 → T4). */
  const analyserFacture = async (c: Compte, assetId: number, v: { date: string; mileage: number; due?: string; texte?: string[]; dueExcerpt?: string }) => {
    const f = await make.assetFile({ id: c.id, ownerUserId: c.ownerUserId } as never, { assetId });
    const due = v.due ?? null;
    await analyserDocument(sql, useRecordings, {
      accountId: c.id, userId: c.ownerUserId, fileId: f.id, linkedAssetId: assetId,
      output: sortieT1({
        title: `Facture entretien ${v.date}`, date: v.date, documentTypeCode: 'MAINTENANCE_INVOICE', amountCents: 30000, supplier: 'Garage Martin',
        assets: [{ id: assetId, label: 'Clio' }], texte: v.texte,
        facts: [
          { canonicalKey: 'mileage', value: v.mileage, valueType: 'number', unit: 'km', excerpt: `Kilométrage relevé : ${v.mileage} km`, assetId },
          ...(due ? [{ canonicalKey: 'maintenanceDueDate', value: due, valueType: 'date', excerpt: v.dueExcerpt ?? `Échéance : ${due.split('-').reverse().join('/')}`,
            assetId, semanticEvent: { type: 'maintenance', nature: 'DEADLINE' } }] : []),
        ] as FaitT1[],
      }),
    });
    return f;
  };

  it('E2E-T2-01 — état canonique avant un ancien document (enabled/master) : T2 répond la valeur canonique récente', async () => {
    const c = await compteDe();
    const clio = await bien(c, 'Clio');
    await analyserFacture(c, clio.id, { date: '2026-09-03', mileage: 45000 });
    // Un document ANCIEN déposé ensuite ne fait pas reculer l'état canonique.
    await analyserFacture(c, clio.id, { date: '2024-05-02', mileage: 30000 });
    expect((await fiche(sql, clio.id)).mileage).toBe(45000);

    const r = await demander(c, 'Quel est le kilométrage de la Clio ?');
    expect(r.answer).toMatch(/45\s?000 km/);
    expect(r.answer).not.toMatch(/30\s?000/);
    expect(ids(r)).toEqual([`asset_field:${clio.id}:mileage`]);
  });

  it('E2E-T2-02 — valeur USER prioritaire (enabled/master) : T2 répond la valeur USER et ne la revalide pas comme obsolète', async () => {
    const c = await compteDe();
    const clio = await bien(c, 'Clio');
    const { updateAssetDetails } = await import('@/services/asset-details-write.service');
    await updateAssetDetails({ assetId: clio.id, accountId: c.id, section: 'vehicle_usage', fields: { mileage: 47000 }, actorUserId: c.ownerUserId });
    // Document plus récent, valeur automatique différente.
    await analyserFacture(c, clio.id, { date: '2026-09-03', mileage: 45000 });
    expect(await fiche(sql, clio.id)).toMatchObject({ mileage: 47000, mileage__origin: 'USER' });

    const r = await demander(c, 'Quel est le kilométrage de la Clio ?');
    expect(r.answer).toMatch(/47\s?000 km/);
    expect(r.answer).toMatch(/saisie par vous/);
    expect(r.answer).not.toMatch(/45\s?000|obsol/i);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM verebona_fact_revalidations WHERE account_id = ${c.id}`;
    expect(n).toBe(0);
  });

  it('E2E-T2-03 — « À traiter » (enabled/master) : réponse alignée sur la page À traiter', async () => {
    const c = await compteDe();
    const clio = await bien(c, 'Clio');
    const polo = await bien(c, 'Polo');
    const { upsertAction } = await import('@/services/to-process/to-process-action.service');
    await upsertAction({ accountId: c.id, targetType: 'ASSET', targetId: clio.id, fieldKey: 'acquisitionPrice', actionKind: 'ARBITRATE',
      ruleCode: 'DATA-ACQUISITION-PRICE', proposals: [{ value: 12500, label: '12 500 €', confidence: 0.8 }] });
    await upsertAction({ accountId: c.id, targetType: 'ASSET', targetId: polo.id, fieldKey: 'registrationNumber', actionKind: 'COMPLETE', ruleCode: 'DATA-REGISTRATION' });
    const resolue = await upsertAction({ accountId: c.id, targetType: 'ASSET', targetId: polo.id, fieldKey: 'acquisitionPrice', actionKind: 'COMPLETE', ruleCode: 'DATA-ACQUISITION-PRICE' });
    await sql`UPDATE to_process_actions SET resolved_at = now() WHERE id = ${(resolue as { actionId: number }).actionId}`;

    const { getToProcessPage } = await import('@/services/to-process/to-process-query.service');
    const page = await getToProcessPage(c.id);
    const r = await demander(c, 'Qu’est-ce que j’ai à traiter ?');
    expect(r.route?.intent).toBe('ACCOUNT_TO_PROCESS');
    const [{ ids: pageIds }] = await sql<{ ids: number[] }[]>`
      SELECT coalesce(array_agg(id ORDER BY id), '{}') AS ids FROM to_process_actions
       WHERE account_id = ${c.id} AND public_id = ANY(${page.actions.map((a) => a.publicId)})`;
    expect(ids(r).sort()).toEqual(pageIds.map((i) => `todo_${i}`).sort());
    expect(page.actions.map((a) => a.question).sort()).toEqual(r.sources.map((s) => s.title).sort());
    expect(page.total).toBe(2);
  });

  it('E2E-T2-04 — informations manquantes (enabled/master) : règles de complétude réelles', async () => {
    const c = await compteDe();
    const polo = await bien(c, 'Polo');
    const can = await import('@/services/verebona-assistant/canonical');
    const attendu = (await can.listMissingInformation(c.id, { assetIds: [polo.id] }))[0].missing.map((m) => m.key).sort();
    expect(attendu).toEqual(['acquisitionDate', 'registrationNumber']);

    const r = await demander(c, 'Qu’est-ce qui manque sur la fiche de la Polo ?');
    expect(r.route?.intent).toBe('ACCOUNT_MISSING_INFORMATION');
    expect(ids(r).sort()).toEqual(attendu.map((k) => `asset_field:${polo.id}:${k}`).sort());
    expect(r.answer).toContain('date d’achat');
    expect(r.answer).toContain('immatriculation');

    // Une information complétée sort de la liste (même règle que la fiche).
    const { updateAssetDetails } = await import('@/services/asset-details-write.service');
    await updateAssetDetails({ assetId: polo.id, accountId: c.id, section: 'vehicle_identification', fields: { registrationNumber: 'AB-123-CD' }, actorUserId: c.ownerUserId });
    const apres = await demander(c, 'Qu’est-ce qui manque sur la fiche de la Polo ?');
    expect(ids(apres)).toEqual([`asset_field:${polo.id}:acquisitionDate`]);
    expect(apres.answer).not.toContain('immatriculation');
  });

  it('E2E-T2-05 — fournisseurs (enabled/master) : recherche fournisseur réelle, dédoublonnée', async () => {
    const c = await compteDe();
    const clio = await bien(c, 'Clio');
    await doc(c, { assetId: clio.id, title: 'Facture révision', type: 'MAINTENANCE_INVOICE', amount: 30000, supplier: 'Garage Martin' });
    await doc(c, { assetId: clio.id, title: 'Facture pneus', type: 'REPAIR_INVOICE', amount: 42000, supplier: 'garage  MARTIN' });
    await doc(c, { assetId: clio.id, title: 'Avis d’échéance', type: 'INSURANCE_DUE_NOTICE', amount: 50000, supplier: 'MAAF' });
    const autre = await compteDe();
    await doc(autre, { assetId: null, title: 'Facture intrus', type: 'MAINTENANCE_INVOICE', supplier: 'Garage Intrus' });

    const r = await demander(c, 'Quels sont mes fournisseurs ?');
    expect(r.route?.intent).toBe('ACCOUNT_SEARCH_SUPPLIER');
    expect(new Set(r.sources.map((s) => s.type))).toEqual(new Set(['supplier']));
    const noms = r.sources.map((s) => s.title.toLowerCase().replace(/\s+/g, ' '));
    expect(noms.sort()).toEqual(['garage martin', 'maaf']);
  });

  it('E2E-T2-06 — « Retrouve une facture » (enabled/master) : filtre documentType effectif', async () => {
    const c = await compteDe();
    const maison = await bien(c, 'Maison', { category: 'IMMOBILIER' });
    const facture = await doc(c, { assetId: maison.id, title: 'Travaux toiture', type: 'WORKS_INVOICE', amount: 120000 });
    const entretien = await doc(c, { assetId: maison.id, title: 'Entretien chaudière', type: 'MAINTENANCE_INVOICE', amount: 18000 });
    const devis = await doc(c, { assetId: maison.id, title: 'Devis — facture prévisionnelle toiture', type: 'WORKS_QUOTE', amount: 130000 });
    const attestation = await doc(c, { assetId: maison.id, title: 'Attestation d’assurance habitation', type: 'INSURANCE_CERTIFICATE' });

    const r = await demander(c, 'Retrouve une facture');
    expect(r.route?.intent).toBe('ACCOUNT_SEARCH_DOCUMENT');
    expect(ids(r).sort()).toEqual([`doc_${facture.id}`, `doc_${entretien.id}`].sort());
    expect(ids(r)).not.toContain(`doc_${devis.id}`);
    expect(ids(r)).not.toContain(`doc_${attestation.id}`);
  });

  it('E2E-T2-08 — échéances proches (enabled/master) : liste chronologique fiable', async () => {
    const c = await compteDe();
    const clio = await bien(c, 'Clio');
    const polo = await bien(c, 'Polo');
    const j20 = await echeance(c, clio.id, 'Contrôle technique Clio', jour(20), { nature: 'DEADLINE', businessType: 'inspection' });
    const j5 = await echeance(c, polo.id, 'Entretien Polo', jour(5), { nature: 'DEADLINE', businessType: 'maintenance' });
    const j12 = await echeance(c, clio.id, 'Assurance Clio', jour(12), { nature: 'DEADLINE', businessType: 'insurance' });
    await echeance(c, clio.id, 'Achat Clio (fait passé daté)', jour(8), { nature: 'HISTORICAL', businessType: 'purchase' });
    await echeance(c, clio.id, 'Entretien 2025', '2025-01-10', { nature: 'DEADLINE', businessType: 'maintenance' });
    await echeance(c, clio.id, 'Vidange lointaine', jour(90), { nature: 'DEADLINE', businessType: 'maintenance' });

    const r = await demander(c, 'Quelles sont mes prochaines échéances ?');
    expect(r.cascade?.strategy).toBe('structured.upcoming_agenda');
    expect(ids(r)).toEqual([`agenda_${j5}`, `agenda_${j12}`, `agenda_${j20}`]);
    const ordre = ['Entretien Polo', 'Assurance Clio', 'Contrôle technique Clio'].map((t) => r.answer.indexOf(t));
    expect(ordre.every((p, i) => p >= 0 && (i === 0 || p > ordre[i - 1]))).toBe(true);
    expect(r.answer).not.toMatch(/Achat Clio|Entretien 2025|Vidange lointaine/);
  });

  it('E2E-T2-11 — suivi conversationnel document (enabled/master) : « le deuxième » puis « son montant » garde la cible', async () => {
    const c = await compteDe();
    const clio = await bien(c, 'Clio');
    await doc(c, { assetId: clio.id, title: 'Facture révision Clio', type: 'MAINTENANCE_INVOICE', amount: 30000, date: '2026-03-01' });
    await doc(c, { assetId: clio.id, title: 'Facture pneus Clio', type: 'REPAIR_INVOICE', amount: 42000, date: '2026-05-01' });

    const liste = await demander(c, 'Retrouve mes factures');
    expect(liste.sources).toHaveLength(2);
    const deuxieme = liste.sources[1];
    const choix = await demander(c, 'Le deuxième', { conversationId: liste.conversationId });
    expect(choix.cascade?.reference).toMatchObject({ method: 'ordinal', outcome: 'resolved' });
    expect(ids(choix)).toEqual([deuxieme.id]);
    const montant = await demander(c, 'Et son montant ?', { conversationId: liste.conversationId });
    expect(montant.cascade?.strategy).toBe('target.document_amount');
    expect(ids(montant)).toEqual([deuxieme.id]);
    expect(montant.answer).toContain(deuxieme.title);
    expect(montant.answer).toMatch(deuxieme.title.includes('pneus') ? /420,00/ : /300,00/);
  });

  it('E2E-T2-12 — suivi agenda (enabled/master) : la question de statut vise le même événement', async () => {
    const c = await compteDe();
    const clio = await bien(c, 'Clio');
    const polo = await bien(c, 'Polo');
    const premier = await echeance(c, polo.id, 'Entretien Polo', jour(5), { nature: 'DEADLINE', businessType: 'maintenance' });
    await echeance(c, clio.id, 'Contrôle technique Clio', jour(20), { nature: 'DEADLINE', businessType: 'inspection' });

    const liste = await demander(c, 'Quelles sont mes prochaines échéances ?');
    expect(ids(liste)[0]).toBe(`agenda_${premier}`);
    const choix = await demander(c, 'Le premier', { conversationId: liste.conversationId });
    expect(choix.contextUpdate).toMatchObject({ type: 'agenda_item', id: premier });
    for (const question of ['Quel est son statut ?', 'Est-il réalisé ?']) {
      const r = await demander(c, question, { conversationId: liste.conversationId });
      expect(r.cascade?.strategy).toBe('target.agenda_status');
      expect(r.cascade?.reference?.entity).toEqual({ type: 'agenda_item', id: premier });
      expect(ids(r)).toEqual([`agenda_${premier}`]);
      expect(r.answer).toContain('Entretien Polo');
    }
  });

  it('E2E-T2-13 — synthèse (enabled/master) : état canonique + documents + conflits + agenda', async () => {
    const c = await compteDe();
    const clio = await bien(c, 'Clio', { keyCharacteristics: { acquisitionPrice: 12000, mileage: 45000 } });
    const facture = await doc(c, { assetId: clio.id, title: 'Facture révision Clio', type: 'MAINTENANCE_INVOICE', amount: 30000, supplier: 'Garage Martin' });
    await echeance(c, clio.id, 'Contrôle technique Clio', jour(20), { nature: 'DEADLINE', businessType: 'inspection' });
    const { upsertAction } = await import('@/services/to-process/to-process-action.service');
    await upsertAction({ accountId: c.id, targetType: 'ASSET', targetId: clio.id, fieldKey: 'acquisitionPrice', actionKind: 'ARBITRATE',
      ruleCode: 'DATA-ACQUISITION-PRICE', proposals: [{ value: 12500, label: '12 500 €', confidence: 0.8 }] });

    const attendus = [`asset_${clio.id}`, `doc_${facture.id}`, `upcoming_agenda:asset_${clio.id}`, `to_process:asset_${clio.id}`];
    const replay = await useRecordings([{
      operationCode: 't2_answer', task: 'ANSWER',
      output: {
        mode: 'ANSWER', format: 'claims', status: 'answered',
        claims: [
          { text: 'Clio : prix d’achat 12 000 €, kilométrage 45 000 km.', sourceIds: [attendus[0]], derivation: 'direct', factual: true },
          { text: 'Dernière facture : révision chez Garage Martin, 300,00 €.', sourceIds: [attendus[1]], derivation: 'direct', factual: true },
          { text: 'Prochaine échéance : contrôle technique.', sourceIds: [attendus[2]], derivation: 'direct', factual: true },
          { text: 'Le prix d’acquisition est à vérifier dans « À traiter ».', sourceIds: [attendus[3]], derivation: 'direct', factual: true },
        ],
      },
    }]);
    const r = await demander(c, 'Fais-moi une synthèse de la Clio');
    expect(r.route?.intent).toBe('ACCOUNT_SUMMARY');
    expect(ids(r)).toEqual(expect.arrayContaining(attendus));
    expect(new Set(r.sources.map((s) => s.type))).toEqual(new Set(['asset_field', 'document_extraction', 'agenda_item', 'to_process_item']));
    expect(replay.calls[0].task).toBe('ANSWER');
    for (const id of attendus) expect(replay.calls[0].prompt).toContain(`"sourceId": "${id}"`);
    expect(r.answer).toContain('12 000 €');
    expect(r.answer).toContain('À traiter');
    expect(r.supportLevel).toBe('supported');
  });

  it('E2E-T2-14 — comparaison (enabled/master) : mêmes dimensions sur deux biens, sans mélange', async () => {
    const c = await compteDe();
    const clio = await bien(c, 'Clio', { keyCharacteristics: { acquisitionPrice: 12000, mileage: 45000 } });
    const polo = await bien(c, 'Polo', { keyCharacteristics: { acquisitionPrice: 9000 } });
    const fc = await doc(c, { assetId: clio.id, title: 'Facture révision Clio', type: 'MAINTENANCE_INVOICE', amount: 30000 });
    const fp = await doc(c, { assetId: polo.id, title: 'Facture révision Polo', type: 'MAINTENANCE_INVOICE', amount: 20000 });

    const replay = await useRecordings([{
      operationCode: 't2_answer', task: 'ANSWER',
      output: {
        mode: 'ANSWER', format: 'claims', status: 'answered',
        claims: [
          { text: 'Prix d’achat : Clio 12 000 €, Polo 9 000 €.', sourceIds: [`asset_${clio.id}`, `asset_${polo.id}`], derivation: 'direct', factual: true },
          { text: 'Kilométrage : Clio 45 000 km ; non renseigné pour la Polo.', sourceIds: [`asset_${clio.id}`, `asset_${polo.id}`], derivation: 'direct', factual: true },
        ],
      },
    }]);
    const r = await demander(c, 'Compare la Clio et la Polo');
    expect(r.route?.intent).toBe('ACCOUNT_COMPARISON');
    const fiches = r.sources.filter((s) => s.type === 'asset_field');
    expect(fiches.map((s) => s.id).sort()).toEqual([`asset_${clio.id}`, `asset_${polo.id}`].sort());
    // Mêmes dimensions, dans le même ordre, pour les deux biens.
    const prompt = replay.calls[0].prompt;
    const dimensions = (nom: string) => {
      const m = prompt.match(new RegExp(`Fiche de ${nom} \\(vehicule\\)((?:\\\\n[^\\\\"]+)+)`));
      return (m?.[1] ?? '').split('\\n').filter(Boolean).map((l) => l.split(' : ')[0]);
    };
    expect(dimensions('Clio').length).toBeGreaterThan(1);
    expect(dimensions('Polo')).toEqual(dimensions('Clio'));
    expect(prompt).toMatch(/Kilométrage : non renseigné/);
    // Sans mélange : chaque document reste sur son bien.
    const contenu = (id: string) => prompt.match(new RegExp(`"sourceId": "${id}"[\\s\\S]*?"content": "([^"]*)"`))?.[1] ?? '';
    expect(ids(r)).toEqual(expect.arrayContaining([`doc_${fc.id}`, `doc_${fp.id}`]));
    expect(contenu(`doc_${fc.id}`)).toMatch(/bien : Clio$/);
    expect(contenu(`doc_${fp.id}`)).toMatch(/bien : Polo$/);
    expect(r.answer).toContain('9 000 €');
    expect(r.answer).not.toMatch(/Polo 45 000|Polo 0 km/);
  });

  it('E2E-T2-15 — chronologie (enabled/master) : achat, entretien, réparation, contrôle, sinistre triés', async () => {
    const c = await compteDe();
    const clio = await bien(c, 'Clio');
    // Insérés dans le désordre.
    const e = [
      ['Sinistre — bris de glace', '2025-11-20', 'HISTORICAL', 'claim'],
      ['Achat de la Clio', '2021-05-25', 'HISTORICAL', 'purchase'],
      ['Contrôle technique', '2027-02-01', 'DEADLINE', 'inspection'],
      ['Réparation embrayage', '2024-03-15', 'HISTORICAL', 'repair'],
      ['Révision', '2023-06-01', 'HISTORICAL', 'maintenance'],
    ] as const;
    for (const [t, d, n, b] of e) await echeance(c, clio.id, t, d, { nature: n, businessType: b });

    const r = await demander(c, 'Historique de la Clio');
    expect(r.route?.intent).toBe('ACCOUNT_TIMELINE');
    const ev = r.events ?? [];
    expect(ev.map((x) => x.date)).toEqual(['2021-05-25', '2023-06-01', '2024-03-15', '2025-11-20', '2027-02-01']);
    for (const [t] of e) expect(ev.some((x) => x.text.includes(t))).toBe(true);
    expect(r.answer.split('\n').filter((l) => l.startsWith('•'))).toHaveLength(5);
  });

  it('E2E-T2-16 — somme sémantique (enabled/master) : entretien 300 + assurance 500 → entretien = 300', async () => {
    const c = await compteDe();
    const clio = await bien(c, 'Clio');
    await doc(c, { assetId: clio.id, title: 'Facture révision Clio', type: 'MAINTENANCE_INVOICE', amount: 30000, supplier: 'Garage Martin' });
    await doc(c, { assetId: clio.id, title: 'Avis d’échéance assurance Clio', type: 'INSURANCE_DUE_NOTICE', amount: 50000, supplier: 'MAAF' });

    const r = await demander(c, 'Combien ai-je dépensé en entretien pour la Clio ?');
    expect(r.cascade?.strategy).toBe('structured.sum_qualified');
    expect(r.answer).toMatch(/300,00\s€ \(1 document\)/);
    expect(r.answer).not.toMatch(/800|500,00/);
  });

  it('E2E-T2-17 — classification ambiguë (enabled/master) : clarification obligatoire', async () => {
    const c = await compteDe();
    await bien(c, 'Clio');
    const replay = await useRecordings([{
      operationCode: 't2_understand', task: 'UNDERSTAND',
      output: {
        mode: 'UNDERSTAND', intent: 'ACCOUNT_SEARCH_DOCUMENT', confidence: 'ambiguous', entityHints: [],
        requestedFacts: [], requestedTopics: [], filters: {}, reason: 'deux lectures possibles',
      },
    }]);
    const r = await demander(c, 'Et le truc de la dernière fois ?');
    expect(replay.calls[0].task).toBe('UNDERSTAND');
    expect(r.cascade?.strategy).toMatch(/^clarification\./);
    expect(r.sources).toEqual([]);
    expect(r.answer).toMatch(/Que cherchez-vous \?/);
  });

  it('E2E-T2-18 — source hors type attendu (enabled/master) : rejet des sources hors contrat', async () => {
    const c = await compteDe();
    const clio = await bien(c, 'Clio');
    const ct = await echeance(c, clio.id, 'Contrôle technique', jour(40), { nature: 'DEADLINE', businessType: 'inspection' });
    const pv = await doc(c, { assetId: clio.id, title: 'Contrôle technique — procès-verbal', type: 'INSPECTION_REPORT' });

    const r = await demander(c, 'Retrouve le contrôle technique dans mon agenda');
    const { getIntentDefinition } = await import('@/services/verebona-assistant/registries/intent-registry');
    const contrat = new Set(getIntentDefinition(r.route!.intent).expectedSourceTypes);
    expect(r.sources.length).toBeGreaterThan(0);
    expect(r.sources.every((s) => contrat.has(s.type))).toBe(true);
    expect(ids(r)).toContain(`agenda_${ct}`);
    expect(ids(r)).not.toContain(`doc_${pv.id}`);
  });

  it('E2E-T2-21 — vraie modification (enabled/master) : aperçu → confirmation → origine USER', async () => {
    const c = await compteDe();
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status) VALUES (${c.id}, 'premium', 'active')`;
    const clio = await bien(c, 'Clio', { keyCharacteristics: { mileage: 47000 } });
    process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS = 'true';
    try {
      const apercu = await demander(c, 'Modifie le kilométrage de la Clio à 50000 km');
      expect(apercu.cascade?.strategy).toBe('command.preview');
      expect(apercu.commandPlan?.summary).toMatch(/47\s000\skm → 50\s000\skm/);
      // Aperçu seul : rien n'est écrit.
      expect((await fiche(sql, clio.id)).mileage).toBe(47000);

      const { confirmCommandPlan } = await import('@/services/verebona-assistant/commands/plan.service');
      const ok = await confirmCommandPlan({ planId: apercu.commandPlan!.planId, accountId: c.id, userId: c.ownerUserId });
      expect(ok).toMatchObject({ ok: true });
      expect(await fiche(sql, clio.id)).toMatchObject({ mileage: 50000, mileage__origin: 'USER' });
      // Une seconde confirmation ne rejoue rien.
      expect(await confirmCommandPlan({ planId: apercu.commandPlan!.planId, accountId: c.id, userId: c.ownerUserId })).toMatchObject({ ok: false });
    } finally {
      delete process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS;
    }
  });

  it('E2E-T2-22 — revalidation d’une échéance (enabled/master) : réinjection + T3 + T4 synchronisés', async () => {
    const c = await compteDe();
    const clio = await bien(c, 'Clio');
    // T1 a mal lu l'échéance (03/09 au lieu de 03/10).
    const f = await analyserFacture(c, clio.id, {
      date: '2026-09-03', mileage: 45000, due: '2027-09-03', dueExcerpt: 'Échéance : 03/09/2027', texte: ['Prochaine révision : 03/10/2027'],
    });
    expect((await fiche(sql, clio.id)).maintenanceDueDate).toBe('2027-09-03');
    expect((await agenda(sql, clio.id)).filter((e) => e.nature === 'DEADLINE').map((e) => e.date)).toEqual(['2027-09-03']);

    const [fait] = await sql<{ id: number }[]>`
      SELECT id::int AS id FROM document_facts WHERE file_id = ${f.id} AND fact_key = 'maintenanceDueDate' ORDER BY id DESC LIMIT 1`;
    const replay = await useRecordings([{
      operationCode: 't2_revalidate', task: 'REVALIDATE',
      output: {
        mode: 'REVALIDATE', status: 'corrected', value: '2027-10-03', unit: null, confidence: 'certain',
        evidence: { provenance: 'TEXT_EXTRACTION', excerpt: 'Prochaine révision : 03/10/2027', page: 1 },
      },
    }]);
    const rv = await import('@/services/verebona-assistant/core/revalidation.service');
    const r = await rv.revalidateFact({
      accountId: c.id, userId: c.ownerUserId, factId: fait.id, question: 'Quand est la prochaine révision ?', trigger: 'CONFLICT', allowModel: true,
    });
    await drainQueues();

    expect(replay.calls[0].task).toBe('REVALIDATE');
    expect(r).toMatchObject({ status: 'CORRECTED', value: '2027-10-03' });
    expect(r!.reinjectedFactId).toBeTruthy();
    // T3 : une seule preuve active, la valeur corrigée sur la fiche.
    expect((await preuves(sql, clio.id)).filter((p) => p.key === 'maintenanceDueDate').map((p) => p.value)).toEqual(['2027-10-03']);
    expect((await fiche(sql, clio.id)).maintenanceDueDate).toBe('2027-10-03');
    // T4 : l'échéance suit, sans doublon.
    expect((await agenda(sql, clio.id)).filter((e) => e.nature === 'DEADLINE').map((e) => e.date)).toEqual(['2027-10-03']);
  });

  it('E2E-T2-23 — conflit déjà arbitré (enabled/master) : T2 respecte l’arbitrage utilisateur', async () => {
    const c = await compteDe();
    const clio = await bien(c, 'Clio');
    const prix = async (euros: number, date: string, title: string) => {
      const f = await make.assetFile({ id: c.id, ownerUserId: c.ownerUserId } as never, { assetId: clio.id });
      await analyserDocument(sql, useRecordings, {
        accountId: c.id, userId: c.ownerUserId, fileId: f.id, linkedAssetId: clio.id,
        output: sortieT1({
          title, date, documentTypeCode: 'ACQUISITION_INVOICE', amountCents: euros * 100, supplier: 'Concession Martin',
          assets: [{ id: clio.id, label: 'Clio' }],
          facts: [{ canonicalKey: 'acquisitionPrice', value: euros, valueType: 'money_eur', unit: 'EUR', excerpt: `Prix de vente : ${euros} €`, assetId: clio.id }],
        }),
      });
    };
    // Deux documents en désaccord : T3 ouvre un arbitrage.
    await prix(12000, '2021-05-25', 'Facture d’achat Clio');
    await prix(12500, '2021-05-26', 'Bon de commande Clio');
    const cartes = () => sql<{ resolved: boolean; kind: string; reason: string | null }[]>`
      SELECT resolved_at IS NOT NULL AS resolved, action_kind AS kind, resolution_reason AS reason FROM to_process_actions
       WHERE account_id = ${c.id} AND target_type = 'ASSET' AND target_id = ${clio.id} AND field_key = 'acquisitionPrice'`;
    expect(await cartes()).toEqual([{ resolved: false, kind: 'ARBITRATE', reason: null }]);
    const q = 'Quel est le prix d’achat de la Clio ?';
    expect((await demander(c, q)).answer).toMatch(/arbitrer dans « À traiter »/);

    // L'utilisateur arbitre : il retient 12 500 € dans le tiroir de la carte
    // (saisie sur la fiche, origine USER).
    const { updateAssetDetails } = await import('@/services/asset-details-write.service');
    await updateAssetDetails({ assetId: clio.id, accountId: c.id, section: 'common', fields: { acquisitionPrice: 12500 }, actorUserId: c.ownerUserId });
    await drainQueues();
    expect(await fiche(sql, clio.id)).toMatchObject({ acquisitionPrice: 12500, acquisitionPrice__origin: 'USER' });
    expect(await cartes()).toEqual([{ resolved: true, kind: 'ARBITRATE', reason: 'USER_COMPLETED' }]);

    const r = await demander(c, q);
    expect(r.answer).toMatch(/12\s?500\s?€/);
    expect(r.answer).toMatch(/saisie par vous/);
    expect(r.answer).not.toMatch(/12\s?000|arbitrer|deux valeurs/i);
    expect(ids(r)).toEqual([`asset_field:${clio.id}:acquisitionPrice`]);
  });
});
