/**
 * Chargement des variables d'environnement pour les scripts hors Next.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE FICHIER EXISTE
 *
 * Next.js charge lui-même `.env.local`, `.env.production` et `.env` au
 * démarrage. Un script lancé par `tsx` n'en bénéficie pas : `DATABASE_URL`
 * reste indéfinie.
 *
 * Le pilote `postgres` ne s'en plaint pas. Faute d'URL, il applique ses
 * réglages par défaut — hôte local, et surtout **utilisateur = compte système
 * courant**. D'où le message déroutant qui a motivé ce module :
 *
 *   authentification par mot de passe échouée pour l'utilisateur « famaupilier »
 *
 * L'utilisateur n'existe évidemment pas dans PostgreSQL. Rien dans ce message
 * ne laisse deviner qu'il s'agit en réalité d'une variable non chargée.
 *
 * ⚠️ CE MODULE DOIT ÊTRE IMPORTÉ EN PREMIER.
 * `src/db/index.ts` lit `process.env.DATABASE_URL` au chargement du module.
 * Les imports ES étant évalués dans l'ordre de déclaration, un import placé
 * après celui de la base arriverait trop tard.
 *
 *     import '@/lib/load-env';        // ← toujours en premier
 *     import { db } from '@/db';
 *
 * Note : `import 'dotenv/config'`, utilisé ailleurs dans le dépôt, ne suffit
 * pas. Il ne charge que `.env`, alors que ce projet travaille avec
 * `.env.local` (cf. les commandes `env:recette` et `env:prod`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Ordre de priorité, calqué sur celui de Next.js.
 *
 * `dotenv` n'écrase jamais une variable déjà définie : le premier fichier qui
 * fournit une clé l'emporte. L'ordre ci-dessous est donc du plus spécifique au
 * plus général.
 */
function envFiles(): string[] {
  const mode = process.env.NODE_ENV || 'development';
  return [
    `.env.${mode}.local`,
    // Next ne charge pas `.env.local` en test, pour que les tests ne dépendent
    // pas de la configuration locale d'un poste. Même règle ici.
    ...(mode === 'test' ? [] : ['.env.local']),
    `.env.${mode}`,
    '.env',
  ];
}

const loaded: string[] = [];

for (const file of envFiles()) {
  const path = resolve(process.cwd(), file);
  if (existsSync(path)) {
    config({ path });
    loaded.push(file);
  }
}

if (!process.env.DATABASE_URL) {
  console.error(
    '\n[env] DATABASE_URL est absente.\n' +
    (loaded.length > 0
      ? `[env] Fichiers lus : ${loaded.join(', ')} — aucun ne la définit.\n`
      : `[env] Aucun fichier d'environnement trouvé dans ${process.cwd()}.\n` +
        '[env] Attendus : ' + envFiles().join(', ') + '\n') +
    '[env] Sans elle, le pilote PostgreSQL se rabat sur ses valeurs par défaut\n' +
    "[env] et tente de se connecter avec votre compte système — d'où une erreur\n" +
    "[env] d'authentification portant un nom d'utilisateur inattendu.\n" +
    '[env] Sous Windows : `npm run env:recette` copie .env.recette.local vers .env.local.\n',
  );
} else if (loaded.length > 0) {
  console.info(`[env] Configuration chargée depuis ${loaded.join(', ')}.`);
}

export const loadedEnvFiles = loaded;
