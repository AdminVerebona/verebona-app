/**
 * Lot 83D — jeu « Dégât des eaux » d'un dossier Assurance-sinistre, construit
 * par les chemins de PRODUCTION qui existent avant ET après la refonte O-8
 * (dépôt des Opérations, service unique de regroupement 82D) et, pour les
 * structures de l'ancien modèle (actions, échanges, enfant d'intervention),
 * par insertion SQL directe — exactement ce que la préproduction contient.
 *
 * Utilisé par le test de RÉFÉRENCE du contenu utile du dossier (avant /
 * après refonte, L83D-E01) et par les scénarios du nettoyage (L83D-E04…).
 *
 *   Bien « Maison » (IMMOBILIER), Pièce « Salle de bain », équipement
 *   « Chauffe-eau » ; Opération CLAIM du 12/03/2026 :
 *     · documents : constat (source), devis plombier, facture réparation,
 *       courrier de l'expert, photo du plafond (galerie du bien) ;
 *     · détails assurance (type, déclaration, référence, police, statut,
 *       circonstances, conséquences, mesures, estimation) ; indemnité ;
 *     · dommage « Salle de bain / Plafond » avec sa photo et son justificatif ;
 *     · chronologie : principal « Dégât des eaux » + « Visite de l'expert »
 *       + « Réparation du plafond » ;
 *     · ancien modèle : une action (facture) et un échange (courrier) ;
 *       intervention ENFANT (parent_operation_id) établie par la facture.
 */
import type postgres from 'postgres';
import type { AccountRow, AssetRow, Factories } from '../factories';

export interface SinistreDossier {
  compte: AccountRow & { owner: { id: number } };
  maison: AssetRow;
  claimId: number;
  childInterventionId: number;
  salleDeBain: number;
  chauffeEau: number;
  files: { constat: number; devis: number; facture: number; courrier: number; photoFile: number };
  photoId: number;
  damageId: number;
  agenda: { principal: number; expert: number; reparation: number };
  legacy: { actionId: number; exchangeId: number };
}

export async function buildSinistreDossier(sql: postgres.Sql, make: Factories): Promise<SinistreDossier> {
  const compte = await make.account({ plan: 'premium' });
  const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
  const [{ id: salleDeBain }] = await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name) VALUES (${maison.id}, 'Salle de bain') RETURNING id`;
  const [{ id: chauffeEau }] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name, type) VALUES (${maison.id}, 'Chauffe-eau', 'WATER_HEATER') RETURNING id`;

  const fichier = async (nom: string, type: string, date: string, extra: { mime?: string; supplier?: string; amountCents?: number } = {}) => {
    const f = await make.assetFile(compte, { assetId: maison.id, name: nom, mimeType: extra.mime ?? 'application/pdf' });
    await sql`UPDATE asset_files SET original_filename = ${nom}, document_type = ${type}, document_date = ${date}, upload_status = 'COMPLETED',
                     supplier = ${extra.supplier ?? null}, amount_cents = ${extra.amountCents ?? null} WHERE id = ${f.id}`;
    return f.id;
  };
  const constat = await fichier('Constat dégât des eaux.pdf', 'CLAIM_DECLARATION', '2026-03-12');
  const devis = await fichier('Devis plombier Martin.pdf', 'QUOTE', '2026-03-15', { supplier: 'Plombier Martin', amountCents: 180000 });
  const facture = await fichier('Facture réparation plafond.pdf', 'REPAIR_INVOICE', '2026-04-18', { supplier: 'Plâtrerie Dupont', amountCents: 165000 });
  const courrier = await fichier('Courrier expert convocation.pdf', 'CLAIM_CORRESPONDENCE', '2026-03-20', { supplier: 'Cabinet Expertise Sud' });
  const photoFile = await fichier('Plafond salle de bain.jpg', 'PHOTO', '2026-03-12', { mime: 'image/jpeg' });
  const [{ id: photoId }] = await sql<{ id: number }[]>`
    INSERT INTO asset_photos (asset_id, user_id, file_id, display_order, caption) VALUES (${maison.id}, ${compte.ownerUserId}, ${photoFile}, 0, 'Plafond taché') RETURNING id`;

  const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
  const { claimId, childInterventionId } = await withBusinessOperationWrite(compte.id, async (repo) => {
    const c = await repo.create({
      type: { code: 'CLAIM' }, status: 'REALIZED', realizedDate: '2026-03-12', technicalLabel: 'Dégât des eaux',
      source: { kind: 'DOCUMENT', entityKey: constat, authority: 'DOCUMENT', confidence: 'certain' },
      assets: [{ assetId: maison.id, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E_L83D',
    });
    await repo.addSource(c.id, { kind: 'DOCUMENT', entityKey: devis, authority: 'DOCUMENT' });
    await repo.addSource(c.id, { kind: 'DOCUMENT', entityKey: facture, authority: 'DOCUMENT' });
    const sCourrier = await repo.addSource(c.id, { kind: 'DOCUMENT', entityKey: courrier, authority: 'DOCUMENT' });
    await repo.upsertClaimDetails(c.id, {
      claimType: 'DEGAT_DES_EAUX', declaredOn: '2026-03-14', insurerClaimRef: 'SIN-2026-042', policyReferenceText: 'MRH n° 778',
      status: 'EXPERTISE_PREVUE', circumstances: 'Fuite du ballon d’eau chaude à l’étage.', consequences: 'Plafond de la salle de bain taché.',
      measuresSummary: 'Coupure de l’eau, séchage.', estimatedDamageMinor: 350000,
    }, 'E2E_L83D');
    await repo.addFinancialComponent(c.id, {
      kind: 'INDEMNITY', amountMinor: 120000, currency: 'EUR', amountEurCents: 120000, economicDate: '2026-05-02',
      sources: [{ sourceId: sCourrier }], fingerprint: 'e2e-l83d-indemnite',
    }, 'E2E_L83D');
    // Intervention établie par la facture (ancien modèle : enfant du sinistre, posé en SQL plus bas).
    const i = await repo.create({
      type: { code: 'INTERVENTION' }, status: 'REALIZED', realizedDate: '2026-04-18', technicalLabel: 'Réparation plafond', provider: 'Plâtrerie Dupont',
      source: { kind: 'DOCUMENT', entityKey: facture, authority: 'DOCUMENT', confidence: 'certain' },
      assets: [{ assetId: maison.id, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E_L83D',
    });
    return { claimId: c.id, childInterventionId: i.id };
  });

  // Dommage (données d'assurance conservées, V-Q8) : photo et justificatif reliés, jamais dupliqués.
  const [{ id: damageId }] = await sql<{ id: number }[]>`
    INSERT INTO business_operation_claim_damages (operation_id, zone, element, finding, estimated_amount_minor, sort_order, item_key)
    VALUES (${claimId}, 'Salle de bain', 'Plafond · 5 m²', 'Auréoles, peinture cloquée', 180000, 0, 'd1') RETURNING id`;
  await sql`INSERT INTO business_operation_claim_damage_photos (damage_id, photo_id) VALUES (${damageId}, ${photoId})`;
  await sql`INSERT INTO business_operation_claim_damage_documents (damage_id, file_id) VALUES (${damageId}, ${devis})`;

  // Ancien modèle (préproduction) : action, échange, enfant d'intervention.
  const [{ id: actionId }] = await sql<{ id: number }[]>`
    INSERT INTO business_operation_claim_actions (operation_id, date, status, title, detail, performed_by, invoice_file_id, child_operation_id, sort_order, item_key)
    VALUES (${claimId}, '2026-04-18', 'REALISEE', 'Réparation du plafond', 'Reprise du plâtre', 'Plâtrerie Dupont', ${facture}, ${childInterventionId}, 0, 'a1') RETURNING id`;
  const [{ id: exchangeId }] = await sql<{ id: number }[]>`
    INSERT INTO business_operation_claim_exchanges (operation_id, date, party, channel, direction, summary, document_file_id, sort_order, item_key)
    VALUES (${claimId}, '2026-03-20', 'EXPERT', 'COURRIER', 'RECU', 'Convocation à l’expertise du 26/03', ${courrier}, 0, 'x1') RETURNING id`;
  await sql`UPDATE business_operations SET parent_operation_id = ${claimId} WHERE id = ${childInterventionId}`;

  // Chronologie (Agenda) et Pièces / équipements de l'Opération : service unique de regroupement (82D).
  const principal = await make.agendaItem(compte, { title: 'Dégât des eaux — Maison', startDate: '2026-03-12', assetIds: [maison.id] });
  const expert = await make.agendaItem(compte, { title: 'Visite de l’expert', startDate: '2026-03-26', assetIds: [maison.id] });
  const reparation = await make.agendaItem(compte, { title: 'Réparation du plafond', startDate: '2026-04-18', assetIds: [maison.id] });
  const g = await import('@/services/business-operations/grouping/service');
  await g.withGroupingWrite(compte.id, async (ctx) => {
    await g.designatePrincipal(ctx, { operationId: claimId, itemId: principal.id, origin: 'USER', reasonCode: 'E2E_L83D' });
    await g.attachAgendaItem(ctx, { operationId: claimId, itemId: expert.id, role: 'RELATED', origin: 'USER', reasonCode: 'E2E_L83D' });
    await g.attachAgendaItem(ctx, { operationId: claimId, itemId: reparation.id, role: 'RELATED', origin: 'USER', reasonCode: 'E2E_L83D' });
    await g.attachRoom(ctx, { operationId: claimId, substructureId: salleDeBain, origin: 'USER', reasonCode: 'E2E_L83D' });
    await g.attachEquipment(ctx, { operationId: claimId, equipmentId: chauffeEau, origin: 'USER', reasonCode: 'E2E_L83D' });
  }, { actorUserId: compte.ownerUserId });

  return {
    compte, maison, claimId, childInterventionId, salleDeBain, chauffeEau,
    files: { constat, devis, facture, courrier, photoFile }, photoId, damageId,
    agenda: { principal: principal.id, expert: expert.id, reparation: reparation.id },
    legacy: { actionId, exchangeId },
  };
}

/** Contenu UTILE d'un dossier Assurance-sinistre (libellés, jamais d'identifiants techniques) — comparable avant / après. */
export interface DossierUtile {
  claim: Record<string, string | null>;
  timeline: string[];
  damages: Array<{ zone: string | null; element: string | null; finding: string | null; photos: string[]; justificatifs: string[] }>;
  documents: string[];
  photos: string[];
  actions: string[];
  exchanges: string[];
  /** Pièces et équipements concernés (lot 83D) ; absent avant. */
  scope?: { rooms: string[]; equipments: string[] };
}

type Data = {
  claim: Record<string, string | null | undefined>;
  timeline?: Array<{ date?: string | null; title?: string | null; selected?: boolean }>;
  damages?: Array<{ zone?: string | null; element?: string | null; finding?: string | null; photoRefs?: string | null; docIds?: string[]; selected?: boolean }>;
  documents?: Array<{ id: string; title: string; selected?: boolean }>;
  photos?: Array<{ id: string; ref?: string | null; caption?: string | null; selected?: boolean }>;
  actions?: Array<{ title?: string | null; date?: string | null; whenLabel?: string | null; selected?: boolean }>;
  exchanges?: Array<{ date?: string | null; title?: string | null; channel?: string | null; docId?: string | null; selected?: boolean }>;
  scope?: { rooms?: string[]; equipments?: string[] } | null;
};

/** Calcule le dossier par la chaîne de production (source, choix par défaut, plan, mappeur) et en extrait le contenu utile. */
export async function dossierUtile(d: Pick<SinistreDossier, 'compte' | 'maison' | 'claimId'>, today: string): Promise<{ utile: DossierUtile; data: Data }> {
  const { loadExportSource } = await import('@/services/exports/v12/data/source');
  const { buildDefaultChoices, planSelection } = await import('@/services/exports/v12/data/choices');
  const { mapDossierData } = await import('@/services/exports/v12/data/mappers');
  const source = await loadExportSource({ assetId: d.maison.id, accountId: d.compte.id, userId: d.compte.ownerUserId, exportType: 'ASSURANCE_SINISTRE', claimOperationId: d.claimId });
  const plan = planSelection('ASSURANCE_SINISTRE', source, buildDefaultChoices('ASSURANCE_SINISTRE', source, { today }), today);
  const meta = { reference: 'R', generatedAt: `${today}T00:00:00+00:00`, preparedBy: null, templateLabel: '', zipName: null, label: '' };
  const data = mapDossierData('ASSURANCE_SINISTRE', { source, plan, resolved: null, meta, today } as never) as unknown as Data;
  const sel = <T extends { selected?: boolean }>(l: T[] | undefined) => (l ?? []).filter((x) => x.selected !== false);
  const docTitle = new Map(sel(data.documents).map((x) => [x.id, x.title]));
  const photoCaption = new Map(sel(data.photos).map((p) => [p.ref ?? p.id, p.caption ?? '']));
  const titleOfDocRef = (ref: string) => {
    const id = Number(String(ref).replace(/^\D+/, ''));
    const doc = source.documents.find((x) => x.id === id);
    return doc ? doc.title : ref;
  };
  const utile: DossierUtile = {
    claim: Object.fromEntries(['typeLabel', 'date', 'declaredAt', 'contractLabel', 'insurerRef', 'statusLabel', 'circumstances', 'consequences', 'measures', 'estimatedDamage', 'compensation']
      .map((k) => [k, (data.claim[k] ?? null) as string | null])),
    timeline: sel(data.timeline).map((t) => `${t.date ?? '—'} ${t.title ?? ''}`.trim()),
    damages: sel(data.damages).map((x) => ({
      zone: x.zone ?? null, element: x.element ?? null, finding: x.finding ?? null,
      photos: (x.photoRefs ?? '').split(/[,·]/).map((s) => s.trim()).filter(Boolean).map((r) => photoCaption.get(r) ?? r),
      justificatifs: (x.docIds ?? []).map(titleOfDocRef),
    })),
    documents: [...docTitle.values()].sort(),
    photos: [...photoCaption.values()].sort(),
    actions: sel(data.actions).map((a) => `${a.date ?? a.whenLabel ?? '—'} ${a.title ?? ''}`.trim()),
    exchanges: sel(data.exchanges).map((x) => `${x.date ?? '—'} ${x.title ?? ''}${x.docId ? ` [${titleOfDocRef(x.docId)}]` : ''}`.trim()),
    ...(data.scope ? { scope: { rooms: [...(data.scope.rooms ?? [])], equipments: [...(data.scope.equipments ?? [])] } } : {}),
  };
  return { utile, data };
}
