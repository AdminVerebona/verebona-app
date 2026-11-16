/**
 * Lot 114O (Trello #744, CDC « Opérations / Agenda V2.0 » §4, §16, §22 ;
 * AC40, AC61, AC64) — travaux F : GARDE qui empêche le rôle « principal »
 * de revenir.
 *
 * Le rôle `agenda_items.operation_role` n'est plus écrit ni lu par le
 * traitement T4, ses projections, le service unique de regroupement et les
 * lectures qui en dépendaient : le lien N↔N porte le FAIT
 * (`business_operation_agenda_links.fact_key`). La colonne historique reste EN
 * PLACE (retrait seulement après recette, §22) et n'est plus tenue que par son
 * SEUL déclencheur `agenda_items_operation_role_sync` (migration 0652) :
 * RELATED dès qu'un élément est rattaché, NULL quand il ne l'est plus.
 *
 * Lecteur de SOURCE, sans base de données (les scénarios sur PostgreSQL réel
 * sont dans `src/test/e2e/scenarios/l114or-abandon-role-non-regression.e2e.ts`).
 *
 *   L114OR-G01  migration 1721 : additive, rejouable, elle n'écrit aucun rôle,
 *               ne retire pas la colonne historique, et repose le déclencheur
 *               de 1716 À L'IDENTIQUE aux deux additions documentées près ;
 *   L114OR-G02  la projection T4 et le service de regroupement ne référencent
 *               plus la colonne de rôle ; le vocabulaire PRINCIPAL / RELATED
 *               reste un CONTRAT d'interface, jamais une valeur persistée ;
 *   L114OR-G03  garde de dépôt : la liste des fichiers qui référencent encore
 *               la colonne est FERMÉE et chaque entrée est justifiée. Un
 *               nouveau fichier qui lirait ou écrirait le rôle fait ÉCHOUER ce
 *               test.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const lire = (f: string): string => readFileSync(join(ROOT, f), 'utf8');

/** Code sans commentaires : un commentaire qui NOMME le rôle (pour l'expliquer) n'est pas une lecture. */
function sansCommentaires(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    .replace(/--.*$/gm, ' ');
}

/**
 * Références à la COLONNE de rôle (`operation_role`, `operation_role_origin`,
 * `operationRole`). Un ALIAS de sortie (`… END AS operation_role`) n'en est pas
 * une : c'est un nom de colonne de RÉSULTAT, que la valeur soit dérivée du lien
 * N↔N (contrat de sortie conservé) ou non.
 */
function referencesColonne(src: string): string[] {
  const code = sansCommentaires(src);
  const snake = [...code.matchAll(/(.{0,4})\boperation_role(?:_origin)?\b/g)]
    .filter((m) => !/\bas\s+$/i.test(m[1]))
    .map((m) => m[0].trim());
  const camel = [...code.matchAll(/\boperationRole(?:Origin)?\b/g)].map((m) => m[0]);
  return [...snake, ...camel];
}

// ── Périmètre de la garde de dépôt ───────────────────────────────────────────

/** Tout le code de production (ni tests, ni fixtures, ni migrations SQL). */
const RACINE_CODE = 'src';
const EXCLUS = /(__tests__|__fixtures__|\.test\.|\.e2e\.|^src\/test\/|^src\/db\/migrations\/)/;

/**
 * Lectures ENCORE ADMISES, avec leur justification. Toute autre est refusée.
 *
 *   · `src/db/schema.ts` : DÉCLARATION de la colonne historique, qui reste en
 *     place jusqu'au retrait d'après recette (§22) — avec sa contrainte CHECK
 *     et l'index unique devenu inerte (plus aucun écrivain ne pose PRINCIPAL) ;
 *   · `migration-744/inventory.ts` : l'inventaire de bascule MESURE
 *     DÉLIBÉRÉMENT l'ancien modèle encore présent en préproduction — c'est son
 *     objet même (« ce que la bascule doit reprendre ») ; lecture seule ;
 *   · `semantic/load.ts` : AUCUNE lecture de la colonne — le contexte T4 garde
 *     son vocabulaire de SORTIE (`AS operation_role`) mais la valeur est
 *     DÉRIVÉE du lien N↔N ; seules les lectures de cette colonne de RÉSULTAT
 *     (`x.operation_role`) subsistent ;
 *   · (plus aucune autre : la dépendance de `to-process/producers.service.ts`
 *     a été levée à l'intégration du 16/11/2026 — la carte DATA-AGENDA-DATE de
 *     l'élément porteur sans date lit maintenant le lien N↔N portant un fait).
 */
const ADMIS: Record<string, string> = {
  'src/db/schema.ts': 'déclaration de la colonne historique (§22)',
  'src/services/business-operations/migration-744/inventory.ts': 'inventaire de bascule : mesure délibérée de l’ancien modèle',
  'src/services/business-operations/semantic/load.ts': 'colonne de RÉSULTAT dérivée du lien N↔N, pas la colonne de la table',
};

function fichiers(dir: string): string[] {
  const out: string[] = [];
  for (const nom of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${nom}`;
    if (EXCLUS.test(rel)) continue;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...fichiers(rel));
    else if (/\.(ts|tsx)$/.test(nom)) out.push(rel);
  }
  return out;
}

// ── L114OR-G01 : la migration 1721 ───────────────────────────────────────────

const SQL1716 = sansCommentaires(lire('src/db/migrations/1716_l114o_liens_evenement_reference_agenda.sql'));
const SQL1721 = sansCommentaires(lire('src/db/migrations/1721_l114o_fait_porte_lien_agenda.sql'));
const fonctionSync = (sql: string): string => {
  const debut = sql.indexOf('CREATE OR REPLACE FUNCTION agenda_items_operation_link_sync');
  expect(debut).toBeGreaterThan(-1);
  const fin = sql.indexOf('$fn$;', debut);
  expect(fin).toBeGreaterThan(debut);
  return sql.slice(debut, fin);
};
const normaliser = (s: string): string => s.replace(/\s+/g, ' ').trim();

describe('L114OR-G01 migration 1721 : additive, rejouable, aucun rôle écrit, colonne historique conservée', () => {
  it('aucune instruction destructrice ; colonne, contrainte et index sous IF NOT EXISTS / garde de nom', () => {
    expect(SQL1721).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|ALTER TABLE \w+ (DROP|RENAME)/i);
    expect(SQL1721).toMatch(/ALTER TABLE business_operation_agenda_links ADD COLUMN IF NOT EXISTS fact_key TEXT;/);
    for (const m of SQL1721.matchAll(/CREATE (UNIQUE )?INDEX\s+(?!IF NOT EXISTS)/g)) throw new Error(`1721 : CREATE INDEX sans IF NOT EXISTS (${m[0]})`);
    for (const m of SQL1721.matchAll(/ADD CONSTRAINT (\w+)/g)) expect(SQL1721, `1721 ${m[1]}`).toContain(`conname = '${m[1]}'`);
    for (const m of SQL1721.matchAll(/CREATE TRIGGER (\w+)/g)) expect(SQL1721, `1721 ${m[1]}`).toContain(`DROP TRIGGER IF EXISTS ${m[1]}`);
  });

  it('la colonne historique du rôle n’est NI écrite NI retirée ; la reprise ne touche aucun élément d’Agenda ni aucun rappel', () => {
    // Elle LIT le rôle une fois (reprise b : ne perdre aucune désignation existante) et ne l'écrit jamais.
    // Écriture = affectation (`SET …` ou `, …`) ; la reprise (b) le LIT dans son WHERE, ce qui est autorisé une fois.
    expect(SQL1721).not.toMatch(/\b(?:SET|,)\s+(?:\w+\.)?operation_role(?:_origin)?\s*=/);
    expect(SQL1721).not.toMatch(/DROP COLUMN operation_role/);
    expect((SQL1721.match(/i\.operation_role|ai\.operation_role/g) ?? []).length).toBe(1);
    expect(SQL1721).toMatch(/AND ai\.operation_role = 'PRINCIPAL'/);
    // Aucune écriture dans l'Agenda, aucun rappel, aucune suppression.
    expect(SQL1721).not.toMatch(/UPDATE agenda_items|INSERT INTO agenda_items|notification|reminder/i);
    // Chaque reprise est bornée par `fact_key IS NULL` (rejouable) et par le compte.
    const reprises = [...SQL1721.matchAll(/UPDATE business_operation_agenda_links l[\s\S]*?;/g)].map((m) => m[0]);
    expect(reprises.length).toBe(2);
    for (const r of reprises) {
      expect(r).toMatch(/l\.fact_key IS NULL/);
      expect(r).toMatch(/account_id = l\.account_id/);
    }
  });

  it('la reprise (a) lit le PRÉFIXE RÉEL des clés de projection T4 et ne peut pas violer la contrainte', async () => {
    const { projectionFunctionalKey } = await import('../../agenda-projection/model');
    const prefixe = projectionFunctionalKey(0, 'X').replace(/0:X$/, '');
    expect(prefixe).toBe('bo:v1:');
    expect(SQL1721).toContain(`'^${prefixe}' || l.operation_id`);
    // `NULLIF(…, '')` : une clé inattendue laisse le lien sans fait plutôt que d'échouer sur le CHECK.
    expect(SQL1721).toMatch(/NULLIF\(regexp_replace\(substring\(ai\.functional_key/);
    expect(SQL1721).toMatch(/CHECK \(fact_key IS NULL OR \(fact_key <> ''/);
  });

  it('le déclencheur de 1716 est reposé À L’IDENTIQUE, aux deux additions documentées du fait porté près', () => {
    const fn1716 = fonctionSync(SQL1716);
    const fn1721 = fonctionSync(SQL1721);
    expect(fn1721).not.toBe(fn1716);
    const sansFait = fn1721
      .replace(/fact_key = NULL,\s*/g, '')
      .replace(/fact_key = CASE WHEN business_operation_agenda_links\.state = 'REMOVED' THEN NULL ELSE business_operation_agenda_links\.fact_key END,\s*/g, '');
    expect(sansFait).not.toContain('fact_key');
    expect(normaliser(sansFait)).toBe(normaliser(fn1716));
    // Le déclencheur est bien reposé sur la table (sinon la compatibilité 1716 serait perdue).
    expect(SQL1721).toMatch(/CREATE TRIGGER agenda_items_operation_link_sync\s+AFTER INSERT OR UPDATE OF business_operation_id ON agenda_items/);
  });
});

// ── L114OR-G02 : T4 et le service de regroupement ────────────────────────────

const SOURCES_T4 = [
  'src/services/business-operations/agenda-projection/model.ts',
  'src/services/business-operations/agenda-projection/service.ts',
  'src/services/business-operations/agenda-projection/consolidation.ts',
  'src/services/business-operations/agenda-projection/queue.ts',
  'src/services/business-operations/semantic/apply.ts',
];
const SOURCES_REGROUPEMENT = fichiers('src/services/business-operations/grouping');

describe('L114OR-G02 la projection T4 et le service de regroupement ne référencent plus la colonne de rôle', () => {
  it('aucune référence à `operation_role` / `operationRole` dans la projection T4', () => {
    for (const f of SOURCES_T4) expect(referencesColonne(lire(f)), f).toEqual([]);
  });

  it('aucune référence à `operation_role` / `operationRole` dans le service unique de regroupement', () => {
    expect(SOURCES_REGROUPEMENT.length).toBeGreaterThanOrEqual(8);
    for (const f of SOURCES_REGROUPEMENT) expect(referencesColonne(lire(f)), f).toEqual([]);
  });

  it('PRINCIPAL / RELATED restent un CONTRAT d’interface : traduits du fait porté, jamais persistés', async () => {
    const { graphOriginOfRoleOrigin, roleOriginOfGraphOrigin } = await import('../model');
    const service = sansCommentaires(lire('src/services/business-operations/grouping/service.ts'));
    // La traduction existe et ne survit qu'EN MÉMOIRE : un porteur se dit PRINCIPAL, un membre RELATED.
    expect(service).toMatch(/const roleOfFact = \(op: number \| null, fact: string \| null\)[^;]*fact \? 'PRINCIPAL' : 'RELATED'/);
    // Elle n'alimente que des VALEURS DE RETOUR (`role:`), jamais une écriture.
    expect([...service.matchAll(/roleOfFact\(/g)].length).toBeGreaterThanOrEqual(3);
    for (const m of service.matchAll(/(.{12})roleOfFact\(/g)) expect(m[1], m[0]).toMatch(/(role:|=|return|\()\s*$/);
    // L'autorité voyage par l'origine du LIEN (vocabulaire fermé du graphe), pas par une colonne de rôle.
    expect(graphOriginOfRoleOrigin('T4')).toBe('AI');
    expect(roleOriginOfGraphOrigin('AI')).toBe('T4');
    // `'PRINCIPAL'` subsiste comme SUJET de décision mémorisée (retrait de la désignation) : vocabulaire antérieur,
    // porté par `business_operation_match_decisions`, sans rapport avec la colonne de rôle.
    expect(service).toMatch(/subject: 'PRINCIPAL'/);
  });

  it('le fait porté est la SEULE désignation écrite : le vocabulaire du lien est fermé (fact_key)', () => {
    const magasin = sansCommentaires(lire('src/services/business-operations/graph/store.ts'));
    expect(magasin).toMatch(/fact_key/);
    expect(referencesColonne(magasin)).toEqual([]);
  });
});

// ── L114OR-G03 : garde de dépôt ──────────────────────────────────────────────

describe('L114OR-G03 garde de dépôt : la liste des lectures restantes du rôle est fermée et justifiée', () => {
  const trouves = new Map<string, string[]>();
  for (const f of fichiers(RACINE_CODE)) {
    const refs = referencesColonne(lire(f));
    if (refs.length) trouves.set(f, refs);
  }

  it('aucun fichier de production ne référence le rôle en dehors de la liste admise', () => {
    const inattendus = [...trouves.keys()].filter((f) => !(f in ADMIS)).sort();
    expect(inattendus, `fichiers à migrer vers le fait porté (lien N↔N) : ${inattendus.join(', ')}`).toEqual([]);
  });

  it('la liste admise ne grandit pas : chaque entrée référence encore le rôle (sinon la retirer)', () => {
    const inutiles = Object.keys(ADMIS).filter((f) => !trouves.has(f)).sort();
    expect(inutiles, `entrées à SUPPRIMER de la liste admise (le rôle n’y est plus lu) : ${inutiles.join(', ')}`).toEqual([]);
  });

  it('`semantic/load.ts` dérive le contexte T4 du lien N↔N : aucune lecture de la colonne de la table', () => {
    const code = sansCommentaires(lire('src/services/business-operations/semantic/load.ts'));
    expect(code).toMatch(/fact_key/);
    expect(code).not.toMatch(/i\.operation_role|\b(?:SET|,)\s+(?:\w+\.)?operation_role(?:_origin)?\s*=/);
    // Les seules occurrences restantes sont la RELECTURE de la colonne de résultat (`x.operation_role…`).
    expect(referencesColonne(code).map((r) => r.slice(r.indexOf('x.')))).toEqual(['x.operation_role', 'x.operation_role_origin']);
  });

  it('l’inventaire de bascule est en LECTURE SEULE (il mesure l’ancien modèle, il ne le réécrit pas)', () => {
    const code = sansCommentaires(lire('src/services/business-operations/migration-744/inventory.ts'));
    expect(code).not.toMatch(/\b(UPDATE|INSERT INTO|DELETE FROM)\b/);
  });
});
