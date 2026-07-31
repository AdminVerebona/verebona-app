/**
 * Élargissement des contraintes de classement — correctif ponctuel.
 *
 *   npm run db:fix-constraints -- --dry-run   # montre l'état, n'écrit rien
 *   npm run db:fix-constraints                # applique
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN SCRIPT PLUTÔT QU'UN FICHIER SQL
 *
 * La base de préproduction n'est joignable ni par un client en ligne de
 * commande — non installable sur le poste —, ni par une console web, l'offre
 * n'en proposant pas. Le seul canal disponible est `npm`, qui fait déjà
 * tourner `db:push` et les amorçages.
 *
 * ── CE CORRECTIF NE PEUT RIEN CASSER ──────────────────────────────────────
 *
 * Les cinq contraintes sont ÉLARGIES, jamais restreintes : chaque nouvelle
 * liste contient l'ancienne. Aucune ligne existante ne peut devenir non
 * conforme.
 *
 * Il est par ailleurs idempotent : relancé, il repose les mêmes valeurs.
 *
 * ── POURQUOI CE CORRECTIF EXISTE ──────────────────────────────────────────
 *
 * Cinq contraintes sont définies par une migration puis redéfinies par une
 * suivante. Tant que l'ordre est respecté, seule la dernière compte.
 *
 * Mais une migration en échec n'est pas enregistrée : elle est retentée au
 * démarrage suivant, DONC APRÈS celles qui l'ont suivie entre-temps. Une
 * valeur périmée écrase alors une valeur récente.
 *
 * C'est ce qui s'est produit : `accounts_plan_type_check` est revenue au
 * modèle `FREEMIUM/PREMIUM/DUO/ENTERPRISE`, et l'inscription refusait
 * `STANDARD`.
 *
 * Les migrations sont corrigées pour l'avenir, mais elles sont déjà
 * enregistrées comme appliquées sur cette base : elles ne seront pas
 * rejouées. D'où ce script.
 * ══════════════════════════════════════════════════════════════════════════
 */
import '@/lib/load-env';
import { pgClient } from '@/db';

interface Correctif {
  table: string;
  contrainte: string;
  definition: string;
  /** Valeur qui doit être acceptée après correction — sert au contrôle. */
  temoin: string;
}

const CORRECTIFS: Correctif[] = [
  {
    table: 'accounts',
    contrainte: 'accounts_plan_type_check',
    temoin: 'STANDARD',
    definition: `CHECK (plan_type IN ('STANDARD', 'PREMIUM', 'DUO', 'PREMIUM_DUO', 'PRO',
                       'FREEMIUM', 'ENTERPRISE'))`,
  },
  {
    table: 'users',
    contrainte: 'chk_users_plan_type',
    temoin: 'STANDARD',
    definition: `CHECK (plan_type IN ('STANDARD', 'PREMIUM', 'PREMIUM_DUO', 'PREMIUM_PRO',
                       'FREEMIUM', 'DUO', 'ENTERPRISE'))`,
  },
  {
    table: 'assets',
    contrainte: 'assets_status_check',
    temoin: 'TRANSMIS',
    definition: `CHECK (status IN ('EN_SERVICE', 'EN_MAINTENANCE', 'HORS_SERVICE',
                    'ARCHIVED', 'TRANSMIS'))`,
  },
  {
    table: 'asset_files',
    contrainte: 'asset_files_category_source_check',
    temoin: 'RULE',
    definition: `CHECK (category_source IS NULL OR category_source IN
    ('AI', 'USER', 'REFERENCE_CORRECTION', 'RULE'))`,
  },
  {
    table: 'asset_files',
    contrainte: 'asset_files_type_source_check',
    temoin: 'RULE',
    definition: `CHECK (type_source IS NULL OR type_source IN
    ('AI', 'USER', 'REFERENCE_CORRECTION', 'RULE'))`,
  },
];

async function definitionActuelle(nom: string): Promise<string | null> {
  const [row] = await pgClient<{ def: string }[]>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${nom}
  `;
  return row?.def ?? null;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[fix] DATABASE_URL absente.');
    process.exit(1);
  }

  const dryRun = process.argv.includes('--dry-run');

  try {
    const cible = new URL(process.env.DATABASE_URL);
    console.log(`\n[fix] Cible : ${cible.username.split('.')[0]}@${cible.hostname}${cible.pathname}\n`);
  } catch { /* URL non analysable : on poursuit, le SQL parlera. */ }

  let corriges = 0;
  let dejaBons = 0;

  for (const c of CORRECTIFS) {
    const avant = await definitionActuelle(c.contrainte);

    if (avant === null) {
      console.log(`  · ${c.contrainte.padEnd(38)} absente — sera posée`);
    } else if (avant.includes(c.temoin)) {
      console.log(`  ✓ ${c.contrainte.padEnd(38)} accepte déjà « ${c.temoin} »`);
      dejaBons += 1;
      continue;
    } else {
      console.log(`  ✗ ${c.contrainte.padEnd(38)} REFUSE « ${c.temoin} »`);
    }

    if (dryRun) continue;

    // Retrait puis pose : `ADD CONSTRAINT` n'accepte pas `IF NOT EXISTS`.
    await pgClient.unsafe(
      `ALTER TABLE ${c.table} DROP CONSTRAINT IF EXISTS ${c.contrainte};`,
    );
    await pgClient.unsafe(
      `ALTER TABLE ${c.table} ADD CONSTRAINT ${c.contrainte} ${c.definition};`,
    );

    const apres = await definitionActuelle(c.contrainte);
    if (apres?.includes(c.temoin)) {
      console.log(`    → corrigée, accepte « ${c.temoin} »`);
      corriges += 1;
    } else {
      console.error(`    → ÉCHEC : la contrainte n'accepte toujours pas « ${c.temoin} »`);
      process.exit(1);
    }
  }

  if (dryRun) {
    console.log('\n[fix] Simulation — rien n\'a été écrit.');
    console.log('      Relancer sans --dry-run pour appliquer.\n');
    process.exit(0);
  }

  console.log(
    `\n[fix] ${corriges} contrainte(s) corrigée(s), ${dejaBons} déjà conforme(s).\n`,
  );
  if (corriges > 0) {
    console.log('      La création de compte devrait fonctionner. Réessayez.\n');
  }
  process.exit(0);
}

main()
  .catch((e) => {
    const cause = (e as { cause?: { message?: string } }).cause;
    console.error('[fix] échec :', (e as Error).message);
    if (cause?.message) console.error('[fix] cause :', cause.message);
    process.exit(1);
  })
  .finally(() => pgClient.end());
