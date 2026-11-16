/**
 * Lot 114O (Trello #744, CDC « Opérations / Agenda V2.0 ») — point G, REVUE
 * DES DOSSIERS RESTANTS sur le nouveau modèle : « Vente »,
 * « Assurance — souscription », « Dossier complet » et la sortie ZIP
 * (critères AC24, AC43, AC59, AC69) — sur PostgreSQL 16 réel, par les chemins
 * de PRODUCTION : `loadExportSource`, pré-sélection, plan de sélection,
 * mappeurs et rendu HTML des templates (le PDF seul demande Chromium).
 * Aucune IA. Dates fixes.
 *
 * Ce qui est vérifié sur CHACUN des trois dossiers et sur le ZIP :
 *   1. aucun élément PARTAGÉ en double — un événement de l'Agenda relié à DEUX
 *      événements de référence, un justificatif relié à DEUX événements de
 *      référence : une seule fois dans la source, dans les données du dossier
 *      et dans l'archive ;
 *   2. aucun événement de référence SUPPRIMÉ (invalidé) ou REGROUPÉ (fusionné)
 *      cité : son intitulé n'apparaît nulle part ;
 *   3. un événement et un justificatif reliés par le NOUVEAU lien N↔N mais
 *      étrangers au bien n'ÉLARGISSENT PAS le dossier (AC69) : ils n'y entrent
 *      pas ; ce que le bien porte, lui, n'est jamais oublié ;
 *   4. isolation des comptes : rien d'un autre compte, même à nom identique.
 *
 *   L114OG-E01  « Vente » : partages dédoublonnés, aucun événement de référence cité, dossier non élargi
 *   L114OG-E02  « Assurance — souscription » : mêmes garanties
 *   L114OG-E03  « Dossier complet » : mêmes garanties, historique et échéances séparés sans répétition
 *   L114OG-E04  sortie ZIP : un chemin par pièce, aucun doublon, aucune pièce étrangère au bien
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';
import type { ExportSource } from '@/services/exports/v12/data/source';
import type { ChoiceItem, ExportChoices } from '@/services/exports/v12/data/choices';
import type { DossierCode } from '@/services/exports/catalog';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const AUJ = '2026-06-15';
const META = {
  reference: 'VBN-744G-000001', generatedAt: '2026-06-15T09:00:00+02:00', preparedBy: 'Claire Martin',
  templateLabel: 'recette · v1.0', zipName: null, label: 'Recette 744G',
};
/** Les trois dossiers encore à revoir (le sinistre et le CIL l'ont été au passage précédent). */
const DOSSIERS: DossierCode[] = ['VENTE', 'ASSURANCE_SOUSCRIPTION', 'DOSSIER_COMPLET'];

/** Intitulés distinctifs : on compte leurs occurrences dans les données rendues. */
const T = {
  elementPartage: 'Entretien annuel partage 744G',
  echeancePartagee: 'Echeance partagee 2031 744G',
  elementHorsBien: 'Element hors bien 744G',
  docPartage: 'Facture partagee 744G',
  docHorsBien: 'Justificatif hors bien 744G',
  supprime: 'Evenement supprime par erreur 744G',
  regroupe: 'Evenement regroupe ailleurs 744G',
  etranger: 'Entretien annuel partage 744G',
};

scenario('L114OG', 'Opérations / Agenda CDC V2.0 — point G : dossiers Vente, Assurance-souscription, Dossier complet et ZIP', ({ sql, make }) => {
  const user = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } });
  const facade = () => import('@/services/business-operations/operation-write.facade');

  async function operation(compte: AccountRow, type: string | null, over: { label?: string; realized?: string; assetId?: number } = {}): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: (type ? { code: type } : null) as never, status: over.realized ? 'REALIZED' : 'ENVISAGED',
      realizedDate: over.realized ?? null, technicalLabel: over.label ?? null,
      source: { kind: 'MIGRATION', entityKey: `l114og-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' },
      ...(over.assetId ? { assets: [{ assetId: over.assetId, authority: 'STRUCTURED' as const }] } : {}),
      reasonCode: 'L114OG_E2E',
    })).id);
  }
  /** Justificatif du compte : `assetId` null = étranger au bien (seul un événement de référence le porte). */
  async function justificatif(compte: AccountRow, assetId: number | null, titre: string, date: string): Promise<number> {
    const f = await make.assetFile(compte, { assetId, name: `${titre}.pdf` });
    await sql`UPDATE asset_files SET retained_title = ${titre}, document_date = ${date}, document_type_code = 'MAINTENANCE_INVOICE', analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    return f.id;
  }
  /** Événement de l'Agenda du compte, avec sa NATURE (fait passé ou échéance à venir : D-14). */
  async function element(compte: AccountRow, title: string, date: string, assetIds: number[], nature: 'HISTORICAL' | 'DEADLINE'): Promise<number> {
    const i = await make.agendaItem(compte, { title, startDate: date, assetIds });
    await sql`UPDATE agenda_items SET event_nature = ${nature}, business_type = ${nature === 'HISTORICAL' ? 'MAINTENANCE' : null} WHERE id = ${i.id}`;
    return i.id;
  }

  /** Jeu d'essai commun : un bien, deux événements de référence, des faits partagés et des faits étrangers au bien. */
  async function jeu(): Promise<{ compte: AccountRow; assetId: number; partage: number; echeance: number; docPartage: number }> {
    const compte = await make.account({ plan: 'premium' });
    const etranger = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison des Lilas' });
    const bienEtranger = await make.asset(etranger, { category: 'IMMOBILIER', name: 'Maison des Lilas' });
    const travaux = await operation(compte, 'INTERVENTION', { label: 'Travaux de plomberie', realized: '2025-04-02', assetId: bien.id });
    const contrat = await operation(compte, 'CONTRACT', { label: 'Contrat d’entretien', assetId: bien.id });

    // 1. Événement de l'Agenda du BIEN (fait passé) et ÉCHÉANCE à venir du bien, reliés aux DEUX
    //    événements de référence : éléments partagés (AC24, AC25 pour la date lointaine).
    const partage = await element(compte, T.elementPartage, '2025-04-02', [bien.id], 'HISTORICAL');
    const echeance = await element(compte, T.echeancePartagee, '2031-04-02', [bien.id], 'DEADLINE');
    // 2. Événement relié aux deux événements de référence mais ÉTRANGER au bien : il n'élargit pas le dossier.
    const horsBien = await element(compte, T.elementHorsBien, '2025-05-05', [], 'HISTORICAL');
    for (const op of [travaux, contrat]) {
      for (const item of [partage, echeance, horsBien]) {
        expect(await (await facade()).linkAgendaItem(user(compte), { operationId: op, agendaItemId: item }), `lien ${op}/${item}`).toMatchObject({ status: 'APPLIED' });
      }
    }
    // 3. Justificatif du BIEN, relié aux DEUX événements de référence (partagé, AC43).
    const docPartage = await justificatif(compte, bien.id, T.docPartage, '2025-04-03');
    // 4. Justificatif ÉTRANGER au bien, relié à un événement de référence seulement : il n'élargit pas le dossier.
    const docHorsBien = await justificatif(compte, null, T.docHorsBien, '2025-04-04');
    for (const op of [travaux, contrat]) {
      expect(await (await facade()).linkDocument(user(compte), { operationId: op, fileId: docPartage }), `doc ${op}`).toMatchObject({ status: 'APPLIED' });
    }
    expect(await (await facade()).linkDocument(user(compte), { operationId: travaux, fileId: docHorsBien })).toMatchObject({ status: 'APPLIED' });

    // 5. Événement de référence SUPPRIMÉ (invalidé) et événement REGROUPÉ (fusionné) : jamais cités.
    const supprime = await operation(compte, 'INTERVENTION', { label: T.supprime, realized: '2025-01-10', assetId: bien.id });
    expect(await (await facade()).invalidateOperation(user(compte), { operationId: supprime })).toMatchObject({ status: 'APPLIED' });
    const regroupe = await operation(compte, 'INTERVENTION', { label: T.regroupe, realized: '2025-02-10', assetId: bien.id });
    await sql`UPDATE business_operations SET merged_into_operation_id = ${travaux}, invalidated_at = '2026-01-01T00:00:00Z', invalidation_reason = 'MERGED'
               WHERE id = ${regroupe} AND account_id = ${compte.id}`;

    // 6. Compte ÉTRANGER : mêmes noms, même date — rien ne doit traverser (AC59).
    const opEtrangere = await operation(etranger, 'INTERVENTION', { label: 'Travaux de plomberie', realized: '2025-04-02', assetId: bienEtranger.id });
    const itemEtranger = await element(etranger, T.etranger, '2025-04-02', [bienEtranger.id], 'HISTORICAL');
    const docEtranger = await justificatif(etranger, bienEtranger.id, T.docPartage, '2025-04-03');
    expect(await (await facade()).linkAgendaItem(user(etranger), { operationId: opEtrangere, agendaItemId: itemEtranger })).toMatchObject({ status: 'APPLIED' });
    expect(await (await facade()).linkDocument(user(etranger), { operationId: opEtrangere, fileId: docEtranger })).toMatchObject({ status: 'APPLIED' });

    return { compte, assetId: bien.id, partage, echeance, docPartage };
  }

  /** Source d'un dossier par le chemin de production. */
  async function source(compte: AccountRow, assetId: number, code: DossierCode): Promise<ExportSource> {
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    return loadExportSource({ assetId, accountId: compte.id, userId: compte.ownerUserId, exportType: code });
  }
  /** Tout ce que le bien porte est retenu (sections ouvertes) : le pire cas pour un doublon. */
  async function toutRetenu(code: DossierCode, src: ExportSource): Promise<ExportChoices> {
    const { DEFAULT_SECTIONS, buildDefaultChoices } = await import('@/services/exports/v12/data/choices');
    const base = buildDefaultChoices(code, src, { outputFormat: 'ZIP', today: AUJ });
    // Toutes les sections du dossier ouvertes (y compris celles décochées par défaut, comme le suivi de « Vente »).
    const sections = Object.fromEntries(Object.keys(DEFAULT_SECTIONS[code]).map((s) => [s, true]));
    const items: ChoiceItem[] = [
      ...src.documents.map((d) => ({ sourceType: 'document' as const, sourceId: d.id, selected: true, mode: 'PDF' as const })),
      ...src.photos.map((p) => ({ sourceType: 'photo' as const, sourceId: p.id, selected: true, mode: 'PDF' as const })),
      ...src.events.map((e) => ({ sourceType: e.source, sourceId: e.id, selected: true })),
    ];
    return { ...base, origin: 'user', items, sections };
  }
  /** Données du dossier et son texte rendu (templates purs, sans Chromium). */
  async function dossier(compte: AccountRow, assetId: number, code: DossierCode): Promise<{ src: ExportSource; data: Json; texte: string }> {
    const [{ planSelection }, { mapDossierData }, { renderDossierHtml }] = await Promise.all([
      import('@/services/exports/v12/data/choices'), import('@/services/exports/v12/data/mappers'), import('@/services/exports/v12/templates'),
    ]);
    const src = await source(compte, assetId, code);
    const choices = await toutRetenu(code, src);
    const plan = planSelection(code, src, choices, AUJ);
    const resolved = {
      documents: new Map(src.documents.map((d) => [d.id, { id: d.id, status: 'ok' as const, pages: 1, localPath: `/tmp/d${d.id}` }])),
      photos: new Map(src.photos.map((p) => [p.id, { id: p.id, status: 'ok' as const, url: `file:///tmp/p${p.id}.jpg` }])),
    };
    const data = mapDossierData(code, { source: src, plan, resolved, meta: META, today: AUJ }) as unknown as Json;
    const html = renderDossierHtml(code, data as never, { sys: 'SYS/', asset: (f: string | null | undefined) => (f ? `file:///tmp/${f}.jpg` : null), stylesheets: [], pageMap: null }).html;
    const texte = html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ').trim();
    return { src, data, texte };
  }
  const fois = (s: string, motif: string): number => s.split(motif).length - 1;

  /** Garanties communes aux trois dossiers (le texte du dossier et ses données). */
  async function verifier(code: DossierCode, compte: AccountRow, assetId: number, ids: { partage: number; echeance: number; docPartage: number }): Promise<Json> {
    const { src, data, texte } = await dossier(compte, assetId, code);

    // 1. La source : chaque justificatif et chaque événement UNE fois (clé unique), partages compris.
    const docIds = src.documents.map((d) => d.id);
    expect(docIds.length, `${code} : justificatif répété dans la source`).toBe(new Set(docIds).size);
    const cles = src.events.map((e) => e.key);
    expect(cles.length, `${code} : événement répété dans la source`).toBe(new Set(cles).size);
    expect(docIds, `${code} : justificatif du bien absent`).toContain(ids.docPartage);
    expect(cles, `${code} : événement du bien absent`).toContain(`agenda:${ids.partage}`);
    expect(cles, `${code} : échéance du bien absente`).toContain(`agenda:${ids.echeance}`);
    // Le fait partagé est bien RENDU (la garantie « une seule fois » n'est pas vide de sens).
    expect(fois(texte, T.elementPartage), `${code} : le fait partagé du bien doit figurer une fois`).toBe(1);

    // 2. Le dossier ne s'élargit pas : un fait relié par le lien N↔N mais étranger au bien n'y entre pas (AC69).
    expect(fois(texte, T.elementHorsBien), `${code} : élargi par un événement étranger au bien`).toBe(0);
    expect(fois(texte, T.docHorsBien), `${code} : élargi par un justificatif étranger au bien`).toBe(0);

    // 3. Aucun événement de référence supprimé ou regroupé n'est cité (AC47, AC67, AC69).
    for (const interdit of [T.supprime, T.regroupe]) {
      expect(fois(texte, interdit), `${code} : ${interdit} cité`).toBe(0);
      expect(fois(JSON.stringify(data), interdit), `${code} : ${interdit} dans les données`).toBe(0);
    }

    // 4. Aucun élément partagé en double dans les données (AC24, AC43).
    expect(fois(JSON.stringify(data), T.elementPartage), `${code} : événement partagé en double (données)`).toBe(1);
    expect(fois(JSON.stringify(data), T.echeancePartagee), `${code} : échéance partagée en double (données)`).toBeLessThanOrEqual(1);
    expect(fois(texte, T.echeancePartagee), `${code} : échéance partagée en double (texte)`).toBeLessThanOrEqual(1);
    const items = (data.documents ?? []) as Array<{ id: string }>;
    expect(items.length, `${code} : justificatif répété dans les pièces`).toBe(new Set(items.map((d) => d.id)).size);

    // 5. Isolation : aucun justificatif, aucun événement d'un autre compte (même nom, même date).
    const [fuiteDoc] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM asset_files WHERE id = ANY(${docIds.length ? docIds : [0]}::bigint[]) AND account_id <> ${compte.id}`;
    expect(fuiteDoc.n, `${code} : justificatif hors compte`).toBe(0);
    const agendaIds = src.events.filter((e) => e.source === 'agenda').map((e) => e.id);
    const [fuiteItem] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM agenda_items WHERE id = ANY(${agendaIds.length ? agendaIds : [0]}::bigint[]) AND account_id <> ${compte.id}`;
    expect(fuiteItem.n, `${code} : événement hors compte`).toBe(0);
    return data;
  }

  it('L114OG-E01 — dossier « Vente » : partages dédoublonnés, aucun événement de référence cité, dossier non élargi', async () => {
    const { compte, assetId, partage, echeance, docPartage } = await jeu();
    const data = await verifier('VENTE', compte, assetId, { partage, echeance, docPartage });
    // Le suivi du bien cite l'événement partagé une seule fois.
    const suivi = (data.followUp ?? []) as Array<{ title: string }>;
    expect(suivi.filter((f) => f.title === T.elementPartage).length).toBeLessThanOrEqual(1);
    expect(suivi.map((f) => f.title)).not.toContain(T.elementHorsBien);
  });

  it('L114OG-E02 — dossier « Assurance — souscription » : partages dédoublonnés, aucun événement de référence cité', async () => {
    const { compte, assetId, partage, echeance, docPartage } = await jeu();
    const data = await verifier('ASSURANCE_SOUSCRIPTION', compte, assetId, { partage, echeance, docPartage });
    const etat = (data.condition ?? []) as Array<{ title: string }>;
    expect(etat.filter((c) => c.title === T.elementPartage).length).toBeLessThanOrEqual(1);
    expect(etat.map((c) => c.title)).not.toContain(T.elementHorsBien);
  });

  it('L114OG-E03 — « Dossier complet » : historique et échéances séparés, chaque fait une seule fois', async () => {
    const { compte, assetId, partage, echeance, docPartage } = await jeu();
    const data = await verifier('DOSSIER_COMPLET', compte, assetId, { partage, echeance, docPartage });
    const histoire = (data.history ?? []) as Array<{ title: string }>;
    const echeances = (data.deadlines ?? []) as Array<{ title: string; date: string }>;
    // L'événement partagé figure dans une seule des deux rubriques, une seule fois.
    expect(histoire.filter((h) => h.title === T.elementPartage).length + echeances.filter((d) => d.title === T.elementPartage).length).toBe(1);
    // L'échéance partagée reste À SA date (2031), dans les échéances, une seule fois (AC24, AC25).
    expect(echeances.filter((d) => d.title === T.echeancePartagee).map((d) => d.date)).toEqual(['2031-04-02']);
    for (const liste of [histoire, echeances]) expect(liste.map((x) => x.title)).not.toContain(T.elementHorsBien);
    // Les intitulés d'une même rubrique ne se répètent pas.
    expect(histoire.length).toBe(new Set(histoire.map((h) => `${h.title}`)).size);
  });

  it('L114OG-E04 — sortie ZIP : un chemin par pièce, aucun doublon, aucune pièce étrangère au bien', async () => {
    const { compte, assetId, partage, docPartage } = await jeu();
    const { planAttachments } = await import('@/services/exports/v12/html/selection');
    for (const code of DOSSIERS) {
      const { data } = await dossier(compte, assetId, code);
      const plan = planAttachments((data.documents ?? []) as never);
      const chemins = plan.zip.map((z) => z.zipPath).filter((p): p is string => !!p);
      // Un chemin par pièce du ZIP, jamais deux fois le même fichier d'archive (ZIP-006/007).
      expect(chemins.length, `${code} : chemin de ZIP répété`).toBe(new Set(chemins).size);
      const ids = [...plan.zip, ...plan.annexes].map((d) => d.id);
      expect(ids.length, `${code} : pièce répétée entre annexes et ZIP`).toBe(new Set(ids).size);
      // Aucune pièce étrangère au bien dans l'archive, malgré le lien N↔N vers un événement de référence.
      expect(JSON.stringify([...plan.zip, ...plan.annexes]), `${code} : pièce étrangère au bien dans l'archive`).not.toContain(T.docHorsBien);
    }
    // Rappel du jeu : le justificatif partagé du bien est bien là (rien n'est perdu).
    const { src } = await dossier(compte, assetId, 'DOSSIER_COMPLET');
    expect(src.documents.map((d) => d.id)).toContain(docPartage);
    expect(src.events.map((e) => e.key)).toContain(`agenda:${partage}`);
  });
});
