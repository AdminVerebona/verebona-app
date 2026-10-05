/**
 * Lecture d'une variable d'environnement numérique — lot 24 (revue).
 *
 * `Number(process.env.X ?? défaut)` prend une variable PRÉSENTE MAIS VIDE
 * (`X=` recopié de `.env.example`) : `Number('')` vaut 0. Pour l'intervalle
 * de la file IA, cela donnait une boucle sans pause ; pour un bail, 0 s.
 * Ici : absente, vide (après `trim`), non numérique ou sous le minimum →
 * valeur par défaut. Jamais de valeur magique silencieuse.
 */
export function envNumber(
  name: string,
  defaut: number,
  opts: { min?: number } = {},
  env: Record<string, string | undefined> = process.env,
): number {
  const brut = (env[name] ?? '').trim();
  if (brut === '') return defaut;
  const n = Number(brut);
  if (!Number.isFinite(n)) return defaut;
  if (opts.min !== undefined && n < opts.min) return defaut;
  return n;
}
