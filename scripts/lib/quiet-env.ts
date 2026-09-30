/**
 * Environnement des scripts de CONTRÔLE (`ai:corpus`, `ai:cutover-check`).
 *
 * Charge les fichiers d'environnement comme `@/lib/load-env`, mais SANS ses
 * avertissements : un contrôle statique n'a pas besoin de la base, et
 * « DATABASE_URL absente » y serait du bruit. Sans base, les messages de
 * connexion manquante de `@/db` sont aussi filtrés (aucune connexion n'est
 * ouverte en mode statique).
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

export function loadEnvQuietly(): { hasDatabase: boolean } {
  const mode = process.env.NODE_ENV || 'development';
  for (const f of [`.env.${mode}.local`, ...(mode === 'test' ? [] : ['.env.local']), `.env.${mode}`, '.env']) {
    const p = resolve(process.cwd(), f);
    if (existsSync(p)) config({ path: p, quiet: true } as never);
  }
  const hasDatabase = Boolean(process.env.DATABASE_URL);
  if (!hasDatabase) {
    const bruit = /^\s*\[(env|db)\] (DATABASE_URL|Aucun fichier|Attendus|Sans elle|et tente|d'authentification|Sous Windows)/;
    const orig = console.error.bind(console);
    console.error = (...a: unknown[]) => { if (!(typeof a[0] === 'string' && bruit.test(a[0]))) orig(...a); };
  }
  return { hasDatabase };
}
