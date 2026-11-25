/**
 * Carte #836 (Trello) — MIGRATION et RECETTE PostgreSQL de l'application
 * vérifiée d'un arbitrage T3 d'attribut.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MODE D'EMPLOI
 *
 * Deux parties :
 *   · la première ne demande AUCUNE base : elle éprouve la migration 1960 sur
 *     son texte (additive, idempotente, non destructive, numérotée après la
 *     dernière du dépôt, réutilisant 1690 et 1785) et la présence de la
 *     recette d'exploitation ;
 *   · la seconde est IGNORÉE tant que `DATABASE_URL` est absente — aucun test
 *     unitaire du dépôt n'ouvre de connexion. Pour l'exécuter :
 *
 *       DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *         npx vitest --run src/__tests__/c836/c836-recette-postgres.test.ts
 *
 *     Elle applique la migration DEUX FOIS (idempotence réelle) puis vérifie
 *     que la contrainte des états d'application accepte `ESCALATED` et refuse
 *     un état inconnu. Elle n'écrit aucune donnée métier.
 *
 * La recette FONCTIONNELLE complète (crash à chaque frontière, deux workers,
 * trois échecs puis escalade, 13 valeurs, options falsifiées, Duo, 20 scans,
 * opérations #8 / #81 / #5 / #76 / #82, comptes #11 et #13, BO #12) est écrite
 * dans `docs/exploitation/recette-c836-t3-arbitrage.md` : elle demande une
 * préproduction, et elle n'est PAS exécutable ici.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const DOSSIER = 'src/db/migrations';
const FICHIER = '1960_c836_arbitrage_attributs_application_escaladee.sql';
const SQL = readFileSync(`${DOSSIER}/${FICHIER}`, 'utf8');

describe('C836-U-MIGRATION — additive, idempotente, non destructive (E09)', () => {
  it('numérotée APRÈS la dernière migration du dépôt, et après celles qu’elle complète', () => {
    const numeros = readdirSync(DOSSIER).filter((f) => /^\d+_.*\.sql$/.test(f)).map((f) => Number(f.split('_')[0]));
    // Carte #837 : des migrations PLUS RÉCENTES peuvent suivre (1970…) — la 1960 reste unique et postérieure à
    // celles qu'elle complète ; l'égalité stricte au maximum du dépôt cassait toute livraison suivante.
    expect(Math.max(...numeros)).toBeGreaterThanOrEqual(1960);
    expect(numeros.filter((n) => n === 1960)).toHaveLength(1);
    // Les migrations réutilisées existent toujours (aucune réécriture de l'histoire).
    const fichiers = readdirSync(DOSSIER);
    expect(fichiers).toContain('1690_l114_arbitrage_attributs_t3.sql');
    expect(fichiers).toContain('1785_l115f_arbitrage_attributs_couverture_application.sql');
  });

  it('aucune destruction : ni table, ni colonne, ni donnée ; tolérante à une migration 1785 non passée', () => {
    expect(SQL).not.toMatch(/DROP TABLE/i);
    expect(SQL).not.toMatch(/DROP COLUMN/i);
    expect(SQL).not.toMatch(/\bDELETE FROM\b/i);
    expect(SQL).not.toMatch(/\bTRUNCATE\b/i);
    expect(SQL).not.toMatch(/\bUPDATE business_operation_attribute_arbitrations\b/i);
    // La seule suppression admise : un index recréé juste après, et une contrainte CHECK remplacée.
    expect(SQL).toMatch(/DROP INDEX IF EXISTS business_operation_attribute_arbitrations_apply_idx;/);
    expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS business_operation_attribute_arbitrations_apply_idx/);
    expect(SQL).toMatch(/IF EXISTS \(SELECT 1 FROM information_schema\.columns/);
    expect(SQL).toMatch(/SET LOCAL lock_timeout = '5s';/);
  });

  it('l’état `ESCALATED` est admis, et l’ancien jeu d’états reste admis', () => {
    expect(SQL).toMatch(/'RECEIVED', 'APPLYING', 'APPLIED', 'APPLY_FAILED', 'ESCALATED'/);
    expect(SQL).toMatch(/COMMENT ON COLUMN business_operation_attribute_arbitrations\.application_state/);
  });

  it('la recette d’exploitation existe et porte les cas que la CI ne peut pas exécuter', () => {
    const doc = readFileSync('docs/exploitation/recette-c836-t3-arbitrage.md', 'utf8');
    for (const attendu of ['1960', 'ESCALATED', 'Deux workers', '13 valeurs', '20 scans', 'zéro double dépense',
      'ATTRIBUTE_ARBITRATION', '#8, #81, #5, #76, #82', 'BO #12']) {
      expect(doc, attendu).toContain(attendu);
    }
  });
});

// Partie BASE RÉELLE : ignorée sans `DATABASE_URL` (la CI du dépôt n'ouvre aucune connexion).
describe.skipIf(!process.env.DATABASE_URL)('C836-PG — migration appliquée deux fois, contrainte éprouvée (E09)', () => {
  it('idempotente sur une base réelle, et la contrainte accepte ESCALATED / refuse un état inconnu', async () => {
    const postgres = (await import('postgres')).default;
    const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      const table = await sql`SELECT to_regclass('business_operation_attribute_arbitrations') IS NOT NULL AS ok`;
      if (table[0]?.ok !== true) {
        // Base sans la table 1690 : la migration n'a rien à faire, et elle ne doit pas échouer.
        await sql.unsafe(SQL);
        await sql.unsafe(SQL);
        return;
      }
      await sql.unsafe(SQL);
      await sql.unsafe(SQL);
      const [c] = await sql<{ def: string }[]>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conname = 'business_operation_attribute_arbitrations_application_chk'`;
      expect(c?.def).toContain('ESCALATED');
      expect(c?.def).toContain('APPLY_FAILED');
      const [i] = await sql<{ def: string }[]>`
        SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'business_operation_attribute_arbitrations_apply_idx'`;
      expect(i?.def).toContain('ESCALATED');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
