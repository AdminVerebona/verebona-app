/**
 * Informations complémentaires — éléments du bien que les listes structurées
 * peuvent citer (CDC Exports V12 §4, §10, §12).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX RÔLES
 *
 *   1. `loadAdditionalInfoReferences` : ce que le formulaire propose dans ses
 *      sélecteurs — pièces et photos du bien, suggestions de points forts de
 *      vente (lot 83D : plus d'événement « sinistre » à lier, la sous-rubrique
 *      Sinistre est retirée).
 *      Lu avec `loadExportSource`, la lecture même du moteur de dossiers :
 *      les identifiants proposés sont exactement ceux que les mappeurs
 *      retrouveront à la génération (même périmètre, mêmes exclusions).
 *
 *   2. `findInvalidReferences` : à l'écriture, chaque identifiant cité par un
 *      correctif (photos, pièces) doit appartenir AU BIEN et
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
import { assetFiles, assetPhotos, assets, equipments, substructures } from '@/db/schema';
import {
  findField,
  type AdditionalInfoReferencesDto,
  type AdditionalInfoSectionKey, type ListColumnType, type NormalizedPatch, type PatchValidationIssue,
} from '@/lib/assets/additional-infos';
import { todayParis } from '@/lib/asset-detail-rules';
import { loadExportSource } from './v12/data/source';
import { highlightSuggestions } from './v12/data/mappers/vente';

type AdditionalInfoReferences = AdditionalInfoReferencesDto;

export async function loadAdditionalInfoReferences(params: { assetId: number; accountId: number; userId: number }): Promise<AdditionalInfoReferences> {
  const source = await loadExportSource({ ...params, exportType: 'DOSSIER_COMPLET' });
  const today = todayParis();
  return {
    // Pièces d'occupant (bail, état des lieux…) : jamais incluses dans un dossier,
    // donc jamais proposées au lien.
    documents: source.documents
      .filter((d) => !d.occupantData)
      .map((d) => ({ id: d.id, title: d.title, typeLabel: d.typeLabel, date: d.date, format: d.format, sensitive: d.sensitive, occupantData: d.occupantData }))
      .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || a.title.localeCompare(b.title)),
    photos: source.photos.map((p) => ({ id: p.id, fileId: p.fileId, caption: p.caption, date: p.date, isPrimary: p.isPrimary })),
    highlightSuggestions: highlightSuggestions(source, today),
  };
}

interface CitedRefs {
  documents: Map<number, string[]>;
  photos: Map<number, string[]>;
}

const push = <K>(m: Map<K, string[]>, k: K, path: string) => { m.set(k, [...(m.get(k) ?? []), path]); };

/** Identifiants cités par les valeurs POSÉES d'un correctif validé, avec leur chemin. */
export function collectReferences(patch: NormalizedPatch): CitedRefs {
  const out: CitedRefs = { documents: new Map(), photos: new Map() };
  for (const [section, values] of Object.entries(patch.set) as Array<[AdditionalInfoSectionKey, Record<string, unknown>]>) {
    for (const [key, value] of Object.entries(values ?? {})) {
      const def = findField(section, key);
      if (!def) continue;
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
  // Plusieurs biens admis (lot 44) : une référence est valide si elle appartient à l'un d'eux.
  const assetIds = [...(typeof asset === 'number' ? [asset] : asset)];
  const refs = collectReferences(patch);
  const issues: PatchValidationIssue[] = [];
  const docIds = [...refs.documents.keys()];
  const photoIds = [...refs.photos.keys()];

  const [docRows, photoRows] = await Promise.all([
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
  ]);

  const found = (rows: Array<{ id: number }>) => new Set(rows.map((r) => r.id));
  const docsOk = found(docRows);
  const photosOk = found(photoRows);

  for (const [id, paths] of refs.documents) if (!docsOk.has(id)) for (const path of paths) issues.push({ path, message: 'Document introuvable pour ce bien.' });
  for (const [id, paths] of refs.photos) if (!photosOk.has(id)) for (const path of paths) issues.push({ path, message: 'Photo introuvable pour ce bien.' });
  return issues;
}
