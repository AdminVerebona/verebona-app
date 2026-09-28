/**
 * Dédoublonnage LOGIQUE des sources — CDC §13.8.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉDOUBLONNAGE NE REGARDAIT QUE L'IDENTIFIANT
 *
 * Deux sources distinctes pour un même contenu passaient toutes les deux :
 *   · un fichier regroupé dans un document logique (`grouped_into_file_id`,
 *     migration 0143) et son document principal ;
 *   · deux téléversements du même fichier (même empreinte `sha256_hash`) ;
 *   · une copie (même titre, même date, même taille) ;
 *   · la même entité remontée par deux chemins (niveau 2 T1 et adaptateur),
 *     avec des identifiants écrits différemment (« doc_12 » / « doc_012 »).
 * L'utilisateur voyait deux fois le même document, et le quota de sources
 * (§13.9) était consommé pour rien.
 *
 * Règle : une clé logique par source ; parmi les doublons, on garde la
 * meilleure (score le plus haut, puis la version la plus récente), À LA
 * PLACE de la première occurrence — l'ordre d'arrivée est préservé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { RetrievedSource } from '../types/sources';
import { parseEntityRef } from './entity-ref';

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);

/** Clés logiques d'une source : deux sources partageant UNE clé sont des doublons. */
export function clesLogiques(s: RetrievedSource): string[] {
  const cles: string[] = [];
  const ref = parseEntityRef(s.id);
  cles.push(ref ? `ref:${ref.kind}:${ref.id}` : `id:${s.id}`);
  const meta = s.meta ?? {};
  // Document secondaire regroupé : c'est le document principal qui compte.
  const logique = Number(meta.logicalFileId);
  if (ref?.kind === 'document' && Number.isSafeInteger(logique) && logique > 0) cles.push(`ref:document:${logique}`);
  // Même contenu binaire.
  const hash = str(meta.contentHash);
  if (hash) cles.push(`hash:${hash}`);
  // Copie : même titre normalisé, même date, même taille.
  const taille = str(meta.size);
  const date = str(meta.date);
  if (ref?.kind === 'document' && taille && date && s.title) cles.push(`copie:${norm(s.title)}|${date.slice(0, 10)}|${taille}`);
  return cles;
}

/** `a` doit-il remplacer `b` parmi deux doublons ? */
function meilleure(a: RetrievedSource, b: RetrievedSource): boolean {
  const sa = a.relevanceScore ?? 0;
  const sb = b.relevanceScore ?? 0;
  if (sa !== sb) return sa > sb;
  // À pertinence égale, la version la plus récente fait foi.
  const da = str(a.meta?.date) ?? '';
  const db = str(b.meta?.date) ?? '';
  if (da !== db) return da > db;
  // Puis le document principal plutôt qu'une source regroupée.
  const pa = parseEntityRef(a.id);
  return pa?.kind === 'document' && Number(a.meta?.logicalFileId) === pa.id;
}

export function dedupeLogique(list: RetrievedSource[]): RetrievedSource[] {
  const garde: RetrievedSource[] = [];
  const indexParCle = new Map<string, number>();
  for (const s of list) {
    const cles = clesLogiques(s);
    const deja = cles.map((c) => indexParCle.get(c)).find((i) => i !== undefined);
    if (deja === undefined) {
      garde.push(s);
      for (const c of cles) indexParCle.set(c, garde.length - 1);
      continue;
    }
    if (meilleure(s, garde[deja])) garde[deja] = s;
    // Les clés des deux doublons pointent désormais vers la même place.
    for (const c of cles) indexParCle.set(c, deja);
  }
  return garde;
}
