/**
 * Informations complémentaires — éléments du bien que les listes structurées
 * peuvent citer (CDC Exports V12 §4, §10, §12, §13 ; RULE-001/002 sinistre).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX RÔLES
 *
 *   1. `loadAdditionalInfoReferences` : ce que le formulaire propose dans ses
 *      sélecteurs — pièces et photos du bien, événements « sinistre » de
 *      l'agenda ou de l'historique, suggestions de points forts de vente.
 *      Lu avec `loadExportSource`, la lecture même du moteur de dossiers :
 *      les identifiants proposés sont exactement ceux que les mappeurs
 *      retrouveront à la génération (même périmètre, mêmes exclusions).
 *
 *   2. `findInvalidReferences` : à l'écriture, chaque identifiant cité par un
 *      correctif (photos, pièces, événement lié) doit appartenir AU BIEN et
 *      au compte. Un identifiant d'un autre bien ou d'un autre compte est
 *      refusé (422) — jamais stocké, donc jamais résolu plus tard.
 *
 * Une pièce supprimée APRÈS coup reste citée dans la liste stockée : le
 * mappeur ne la retrouve plus dans la source et l'ignore (lien souple).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { documentInAssetsCondition } from '@/services/documents/asset-document-scope';
import { db } from '@/db';
import { agendaAssetLinks, agendaItems, assetFiles, assetPhotos, assets, equipments, events, substructures } from '@/db/schema';
import {
  EVENT_KEY_RE, findField,
  type AdditionalInfoReferencesDto,
  type AdditionalInfoSectionKey, type ListColumnType, type NormalizedPatch, type PatchValidationIssue,
} from '@/lib/assets/additional-infos';
import { todayParis } from '@/lib/asset-detail-rules';
import { loadExportSource } from './v12/data/source';
import { eventKind } from './v12/data/choices';
import { highlightSuggestions } from './v12/data/mappers/vente';

export type AdditionalInfoReferences = AdditionalInfoReferencesDto;

export async function loadAdditionalInfoReferences(params: { assetId: number; accountId: number; userId: number }): Promise<AdditionalInfoReferences> {
  const source = await loadExportSource({ ...params, exportType: 'ASSURANCE_SINISTRE' });
  const today = todayParis();
  return {
    // Pièces d'occupant (bail, état des lieux…) : jamais incluses dans un dossier,
    // donc jamais proposées au lien.
    documents: source.documents
      .filter((d) => !d.occupantData)
      .map((d) => ({ id: d.id, title: d.title, typeLabel: d.typeLabel, date: d.date, format: d.format, sensitive: d.sensitive, occupantData: d.occupantData }))
      .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || a.title.localeCompare(b.title)),
    photos: source.photos.map((p) => ({ id: p.id, fileId: p.fileId, caption: p.caption, date: p.date, isPrimary: p.isPrimary })),
    claimEvents: source.events
      .filter((e) => e.status !== 'annule' && !e.forecast && eventKind(e) === 'SINISTRE')
      .map((e) => ({ key: e.key, title: e.title, date: e.date, source: e.source }))
      .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''))),
    highlightSuggestions: highlightSuggestions(source, today),
  };
}

/** Autres biens d'un sinistre dont les références sont proposées (borne). */
export const CLAIM_REFERENCE_ASSETS_MAX = 10;

/**
 * Lot 53 (retour PO Q18) — sélecteur multi-biens d'un sinistre : pièces,
 * photos et événements « sinistre » du bien de la fiche PUIS des autres
 * biens CONCERNÉS par le sinistre, uniquement ceux ACCESSIBLES : bien du
 * compte courant, non supprimé (même règle que l'accès à la fiche et que
 * `findInvalidReferences`). Un bien d'un autre compte, supprimé ou hors du
 * sinistre n'apporte rien. Chaque élément d'un autre bien porte `assetId`
 * et `assetName` ; un élément commun à plusieurs biens n'apparaît qu'une
 * fois (sous le premier bien qui le porte, celui de la fiche d'abord).
 * Suggestions de points forts : celles du bien de la fiche seulement.
 */
export async function loadClaimReferences(params: {
  assetId: number; accountId: number; userId: number; claimAssetIds: readonly number[];
}): Promise<AdditionalInfoReferences> {
  const base = await loadAdditionalInfoReferences({ assetId: params.assetId, accountId: params.accountId, userId: params.userId });
  const autres = [...new Set(params.claimAssetIds.filter((id) => Number.isSafeInteger(id) && id > 0 && id !== params.assetId))];
  if (!autres.length) return base;
  const accessibles = await db.select({ id: assets.id, name: assets.name }).from(assets)
    .where(and(inArray(assets.id, autres), eq(assets.accountId, params.accountId), isNull(assets.deletedAt)))
    .orderBy(assets.name, assets.id)
    .limit(CLAIM_REFERENCE_ASSETS_MAX);
  const docs = new Set(base.documents.map((d) => d.id));
  const photos = new Set(base.photos.map((p) => p.id));
  const evts = new Set(base.claimEvents.map((e) => e.key));
  const out: AdditionalInfoReferences = { ...base, documents: [...base.documents], photos: [...base.photos], claimEvents: [...base.claimEvents] };
  for (const a of accessibles) {
    let r: AdditionalInfoReferences;
    try {
      r = await loadAdditionalInfoReferences({ assetId: a.id, accountId: params.accountId, userId: params.userId });
    } catch (e) {
      // Bien devenu inaccessible entre-temps : il n'apporte rien.
      if ((e as { exportErrorCode?: string }).exportErrorCode === 'ASSET_NOT_FOUND') continue;
      throw e;
    }
    for (const d of r.documents) if (!docs.has(d.id)) { docs.add(d.id); out.documents.push({ ...d, assetId: a.id, assetName: a.name }); }
    for (const p of r.photos) if (!photos.has(p.id)) { photos.add(p.id); out.photos.push({ ...p, assetId: a.id, assetName: a.name }); }
    for (const e of r.claimEvents) if (!evts.has(e.key)) { evts.add(e.key); out.claimEvents.push(e); }
  }
  out.claimEvents.sort((x, y) => String(y.date ?? '').localeCompare(String(x.date ?? '')));
  return out;
}

interface CitedRefs {
  documents: Map<number, string[]>;
  photos: Map<number, string[]>;
  events: Map<string, string[]>;
}

const push = <K>(m: Map<K, string[]>, k: K, path: string) => { m.set(k, [...(m.get(k) ?? []), path]); };

/** Identifiants cités par les valeurs POSÉES d'un correctif validé, avec leur chemin. */
export function collectReferences(patch: NormalizedPatch): CitedRefs {
  const out: CitedRefs = { documents: new Map(), photos: new Map(), events: new Map() };
  for (const [section, values] of Object.entries(patch.set) as Array<[AdditionalInfoSectionKey, Record<string, unknown>]>) {
    for (const [key, value] of Object.entries(values ?? {})) {
      const def = findField(section, key);
      if (!def) continue;
      if (def.type === 'eventRef' && typeof value === 'string' && EVENT_KEY_RE.test(value)) push(out.events, value, `${section}.${key}`);
      if (def.type !== 'list' || !def.list || !Array.isArray(value)) continue;
      const refCols = def.list.columns.filter((c) => (['documentRefs', 'photoRefs', 'documentRef'] as ListColumnType[]).includes(c.type));
      value.forEach((row, i) => {
        for (const col of refCols) {
          const cell = (row as Record<string, unknown>)[col.key];
          const ids = (Array.isArray(cell) ? cell : cell == null ? [] : [cell]).filter((n): n is number => typeof n === 'number');
          for (const id of ids) push(col.type === 'photoRefs' ? out.photos : out.documents, id, `${section}.${key}[${i}].${col.key}`);
        }
      });
    }
  }
  return out;
}

/**
 * Chemins des références qui n'appartiennent pas au bien (ou au compte).
 * Tableau vide : tout est cité à bon droit.
 */
export async function findInvalidReferences(asset: number | readonly number[], accountId: number, patch: NormalizedPatch): Promise<PatchValidationIssue[]> {
  // Lot 44 : un sinistre multi-biens cite les pièces et photos de N'IMPORTE lequel de ses biens.
  const assetIds = [...(typeof asset === 'number' ? [asset] : asset)];
  const refs = collectReferences(patch);
  const issues: PatchValidationIssue[] = [];
  const docIds = [...refs.documents.keys()];
  const photoIds = [...refs.photos.keys()];
  const agendaIds = [...refs.events.keys()].filter((k) => k.startsWith('agenda:')).map((k) => Number(k.slice(7)));
  const eventIds = [...refs.events.keys()].filter((k) => k.startsWith('event:')).map((k) => Number(k.slice(6)));

  const [docRows, photoRows, agendaRows, eventRows] = await Promise.all([
    docIds.length
      ? db.select({ id: assetFiles.id }).from(assetFiles).where(and(
        inArray(assetFiles.id, docIds),
        eq(assetFiles.accountId, accountId),
        isNull(assetFiles.deletedAt),
        // Pièce du bien : directe, d'une pièce (sous-structure) ou d'un équipement du bien.
        or(
          // Lot 32C (PO 9) : document lié au bien (colonnes, liens PRIMARY / SECONDARY).
          documentInAssetsCondition(assetIds),
          inArray(assetFiles.substructureId, db.select({ id: substructures.id }).from(substructures).where(inArray(substructures.assetId, assetIds))),
          inArray(assetFiles.equipmentId, db.select({ id: equipments.id }).from(equipments).where(inArray(equipments.assetId, assetIds))),
        ),
      ))
      : Promise.resolve([] as Array<{ id: number }>),
    photoIds.length
      // Lot 53 (Q18) : photo d'un bien concerné ET du compte (le bien porteur est vérifié, pas seulement cité).
      ? db.select({ id: assetPhotos.id }).from(assetPhotos)
        .innerJoin(assets, and(eq(assets.id, assetPhotos.assetId), eq(assets.accountId, accountId), isNull(assets.deletedAt)))
        .where(and(inArray(assetPhotos.id, photoIds), inArray(assetPhotos.assetId, assetIds)))
      : Promise.resolve([] as Array<{ id: number }>),
    agendaIds.length
      ? db.select({ id: agendaItems.id }).from(agendaItems)
        .innerJoin(agendaAssetLinks, eq(agendaAssetLinks.agendaItemId, agendaItems.id))
        .where(and(inArray(agendaItems.id, agendaIds), eq(agendaItems.accountId, accountId), inArray(agendaAssetLinks.assetId, assetIds)))
      : Promise.resolve([] as Array<{ id: number }>),
    eventIds.length
      ? db.select({ id: events.id }).from(events).where(and(inArray(events.id, eventIds), eq(events.accountId, accountId), inArray(events.assetId, assetIds)))
      : Promise.resolve([] as Array<{ id: number }>),
  ]);

  const found = (rows: Array<{ id: number }>) => new Set(rows.map((r) => r.id));
  const docsOk = found(docRows);
  const photosOk = found(photoRows);
  const agendaOk = found(agendaRows);
  const eventsOk = found(eventRows);

  for (const [id, paths] of refs.documents) if (!docsOk.has(id)) for (const path of paths) issues.push({ path, message: 'Document introuvable pour ce bien.' });
  for (const [id, paths] of refs.photos) if (!photosOk.has(id)) for (const path of paths) issues.push({ path, message: 'Photo introuvable pour ce bien.' });
  for (const [key, paths] of refs.events) {
    const [kind, raw] = key.split(':');
    const ok = kind === 'agenda' ? agendaOk.has(Number(raw)) : eventsOk.has(Number(raw));
    if (!ok) for (const path of paths) issues.push({ path, message: 'Événement introuvable pour ce bien.' });
  }
  return issues;
}
