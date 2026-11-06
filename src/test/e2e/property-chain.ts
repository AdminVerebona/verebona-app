/**
 * Lot 113Q — lecture de la traçabilité des propriétés d'un ZIP de diagnostic
 * (tests e2e) : parties réunies, fichiers détaillés indexés, chaînes
 * DÉVELOPPÉES (`expandPropertyChain`, même forme que la chaîne du lot 91A).
 */
import { PROPERTY_DETAIL_FILES, expandPropertyChain, indexPropertyDetails } from '@/services/admin/diagnostics-export/properties';

type Row = Record<string, any>;
const PART = /\.part-\d{4}(?=\.json$)/;

/** Lignes d'un fichier logique (parties `.part-NNNN.json` réunies, dans l'ordre). */
export function logicalRows(files: Record<string, string>, path: string): Row[] {
  return Object.keys(files).filter((p) => p.replace(PART, '') === path).sort().flatMap((p) => JSON.parse(files[p]) as Row[]);
}

/** Chaînes des propriétés développées (références remplacées par les lignes détaillées). */
export function expandedProperties(files: Record<string, string>): Row[] {
  const rows = Object.fromEntries(Object.entries(PROPERTY_DETAIL_FILES).map(([k, p]) => [k, logicalRows(files, p)]));
  const idx = indexPropertyDetails(rows);
  return logicalRows(files, 'tracabilite/proprietes.json').map((e) => expandPropertyChain(e, idx));
}
