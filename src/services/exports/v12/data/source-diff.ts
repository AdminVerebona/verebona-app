/**
 * Rapport d'écarts entre la source historique et la source canonique d'un
 * dossier V12 — mode `shadow` d'`EXPORTS_CANONICAL_SOURCE` (CDC 15 X-02,
 * lot 16). Fonctions PURES, testées.
 *
 * Aucun contenu : le rapport ne porte que des NOMS de champs, des
 * identifiants de pièces (avec leur chemin de rattachement canonique) et des
 * clés d'événements. Il est journalisé et ses compteurs sont figés dans le
 * snapshot ; jamais une valeur (adresse, immatriculation, montant…).
 */
import { isPastEvent, isUpcoming } from './choices';
import type { ExportSource, SourceEvent } from './source';
import { sameExportValue, type DocumentPath, type EventBucket, type ExportSourceDiff } from './canonical-source';

/** Champs scalaires du bien comparés (la fiche imprimée en dépend). */
const ASSET_SCALARS = [
  'purchaseDate', 'purchasePriceCents', 'warrantyEndDate', 'mileageOrHours', 'registrationNumber', 'dimensions',
  'engineInfo', 'purchaseLocation', 'address', 'postalCode', 'city', 'generalCondition', 'objectCategory', 'description',
] as const;

/** Classement d'un événement : historique, échéance à venir, aucun. */
export function eventBucket(e: SourceEvent, today: string): EventBucket {
  if (isUpcoming(e, today)) return 'deadline';
  if (isPastEvent(e, today)) return 'history';
  return null;
}

export function diffExportSources(
  legacy: ExportSource,
  canonical: ExportSource,
  opts: { today: string; documentPaths?: Record<number, DocumentPath[]>; unconfirmed?: number[] },
): ExportSourceDiff {
  const fields: string[] = [];
  for (const k of ASSET_SCALARS) {
    if (!sameExportValue(legacy.asset[k], canonical.asset[k])) fields.push(`asset.${k}`);
  }
  const cles = new Set([...Object.keys(legacy.asset.characteristics), ...Object.keys(canonical.asset.characteristics)]);
  for (const k of [...cles].sort()) {
    // Clés techniques de la fiche (`x__origin`) : jamais imprimées, écart sans objet.
    if (k.includes('__') || /_origin$/.test(k)) continue;
    if (!sameExportValue(legacy.asset.characteristics[k], canonical.asset.characteristics[k])) fields.push(`characteristics.${k}`);
  }

  const idsL = new Set(legacy.documents.map((d) => d.id));
  const idsC = new Set(canonical.documents.map((d) => d.id));
  const onlyLegacy = [...idsL].filter((id) => !idsC.has(id)).sort((a, b) => a - b);
  const onlyCanonical = [...idsC].filter((id) => !idsL.has(id)).sort((a, b) => a - b)
    .map((id) => ({ id, paths: opts.documentPaths?.[id] ?? [], confirmed: !(opts.unconfirmed ?? []).includes(id) }));
  const addedInCanonical = {
    confirmed: onlyCanonical.filter((d) => d.confirmed).length,
    unconfirmed: onlyCanonical.filter((d) => !d.confirmed).length,
  };

  const parCle = new Map(canonical.events.map((e) => [e.key, e]));
  const events: ExportSourceDiff['events'] = [];
  for (const e of legacy.events) {
    const c = parCle.get(e.key);
    const bl = eventBucket(e, opts.today);
    const bc = c ? eventBucket(c, opts.today) : null;
    if (bl !== bc) events.push({ key: e.key, legacy: bl, canonical: bc });
  }
  for (const c of canonical.events) {
    if (legacy.events.some((e) => e.key === c.key)) continue;
    const bc = eventBucket(c, opts.today);
    if (bc) events.push({ key: c.key, legacy: null, canonical: bc });
  }

  return {
    fields,
    documents: { onlyLegacy, onlyCanonical, addedInCanonical },
    events,
    total: fields.length + onlyLegacy.length + onlyCanonical.length + events.length,
  };
}
