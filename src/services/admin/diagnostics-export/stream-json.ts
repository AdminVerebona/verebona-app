/**
 * Lot 113Q (#714) — sérialisation PROGRESSIVE et lectures MÉMORISÉES du
 * diagnostic (serveur uniquement, pur hors E/S injectées).
 *
 *   · `writeMaskedJson` : écrit `JSON.stringify(mask(v), null, 2)` morceau
 *     par morceau — même texte, octet pour octet — sans construire ni la
 *     copie masquée complète ni la chaîne complète (journaux T1 / T3, coûts
 *     IA, sorties modèle : avant, objet complet + copie masquée + chaîne
 *     entière en mémoire en même temps) ;
 *   · `memoQuery` : une requête identique (même texte, mêmes paramètres)
 *     relue dans le MÊME instantané rend le même résultat — la traçabilité
 *     TCO relisait document, extraction, Opération, historique… pour chaque
 *     ligne d'un même bien. Résultats gardés en TEXTE (copie neuve à chaque
 *     lecture : aucun partage d'objet entre deux lignes), borne en octets,
 *     compteurs (lectures évitées).
 */
import type { DiagQuery } from '@/services/business-operations/diagnostics/service';

type Row = Record<string, unknown>;
const SENTINEL = 'VB113Q-SENTINELLE';

const isPlainObject = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && typeof (v as { toJSON?: unknown }).toJSON !== 'function';
const isMarker = (v: unknown) => isPlainObject(v) && typeof (v as Row).$etat === 'string';

/**
 * Écrit `JSON.stringify(mask(value), null, 2)` (avec `pad` ajouté après
 * chaque saut de ligne) en flux. `mask` est le masquage du diagnostic
 * (`maskForExport`) : appliqué SOUS-ARBRE par sous-arbre, avec le contexte
 * de l'objet parent (colonnes clés) — même résultat que sur l'objet entier.
 */
export async function writeMaskedJson(w: (c: string) => Promise<void>, value: unknown, mask: (v: unknown) => unknown, opts: { pad?: string; maxDepth?: number; chunkChars?: number } = {}): Promise<void> {
  const maxDepth = opts.maxDepth ?? 6;
  const limit = opts.chunkChars ?? 64 * 1024;
  let buf = '';
  const out = async (s: string) => { buf += s; if (buf.length >= limit) { const c = buf; buf = ''; await w(c); } };
  const leaf = async (masked: unknown, ind: string) => { await out((JSON.stringify(masked, null, 2) ?? 'null').replace(/\n/g, `\n${ind}`)); };
  /** Valeur DÉJÀ masquée au niveau de ses clés (`raw` : la donnée, `masked` connu si une règle de clé l'a remplacée). */
  const walk = async (raw: unknown, depth: number, ind: string): Promise<void> => {
    if (depth >= maxDepth || raw === null || typeof raw !== 'object' || raw instanceof Date || isMarker(raw)) { await leaf(mask(raw), ind); return; }
    if (Array.isArray(raw)) {
      if (!raw.length) { await out('[]'); return; }
      await out('[');
      for (let i = 0; i < raw.length; i++) {
        await out(`${i ? ',' : ''}\n${ind}  `);
        const v = raw[i];
        if (v === undefined || typeof v === 'function') await out('null'); else await walk(v, depth + 1, `${ind}  `);
      }
      await out(`\n${ind}]`);
      return;
    }
    if (!isPlainObject(raw)) { await leaf(mask(raw), ind); return; }
    const entries = Object.entries(raw).filter(([, v]) => v !== undefined && typeof v !== 'function');
    if (!entries.length) { await out('{}'); return; }
    // Contexte du parent pour le masquage d'une clé : ses valeurs scalaires (colonnes clés, ex. field_key).
    const scalars: Row = {};
    for (const [k, v] of entries) if (v === null || typeof v !== 'object') scalars[k] = v;
    await out('{');
    let first = true;
    for (const [k, v] of entries) {
      await out(`${first ? '' : ','}\n${ind}  ${JSON.stringify(k)}: `);
      first = false;
      if (v === null || typeof v !== 'object') { await leaf((mask({ ...scalars, [k]: v }) as Row)[k], `${ind}  `); continue; }
      // Règle portée par la CLÉ (secret, registre sensible, valeur d'une ligne sensible) : valeur remplacée en bloc.
      const probe = (mask({ ...scalars, [k]: SENTINEL }) as Row)[k];
      if (probe !== SENTINEL) { await leaf((mask({ ...scalars, [k]: v }) as Row)[k], `${ind}  `); continue; }
      await walk(v, depth + 1, `${ind}  `);
    }
    await out(`\n${ind}}`);
  };
  await walk(value, 0, opts.pad ?? '');
  if (buf) await w(buf);
}

export interface MemoStats { hits: number; misses: number; bytes: number; evicted: number }

/**
 * Requêtes mémorisées dans un même instantané (pur : `q` fourni). Au-delà de
 * `maxBytes` de résultats gardés, les plus anciens sont oubliés (relus au
 * besoin) : la mémoire reste bornée.
 */
export function memoQuery(q: DiagQuery, opts: { maxBytes?: number; stats?: MemoStats } = {}): DiagQuery & { stats: MemoStats; clear(): void } {
  const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
  const stats = opts.stats ?? { hits: 0, misses: 0, bytes: 0, evicted: 0 };
  const cache = new Map<string, string>();
  const fn = (async (sql: string, params: unknown[] = []) => {
    const key = `${sql}\u0000${JSON.stringify(params)}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      stats.hits++;
      cache.delete(key);
      cache.set(key, hit);
      return JSON.parse(hit) as Row[];
    }
    stats.misses++;
    const rows = await q(sql, params);
    const text = JSON.stringify(rows);
    if (text.length <= maxBytes / 4) {
      cache.set(key, text);
      stats.bytes += text.length;
      for (const [k, v] of cache) {
        if (stats.bytes <= maxBytes) break;
        cache.delete(k);
        stats.bytes -= v.length;
        stats.evicted++;
      }
    }
    return JSON.parse(text) as Row[];
  }) as DiagQuery & { stats: MemoStats; clear(): void };
  fn.stats = stats;
  fn.clear = () => { cache.clear(); stats.bytes = 0; };
  return fn;
}
