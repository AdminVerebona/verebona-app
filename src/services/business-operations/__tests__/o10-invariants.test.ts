/**
 * Lot 48 (O10) — invariants finaux C34 et critères ACC vérifiables par
 * l'architecture (contrôles statiques du code et du schéma). Les invariants
 * vérifiables sur données sont dans les scénarios e2e
 * `l48-o10-recette-jeux.e2e.ts` (7 jeux C30.1, anomalies dures à 0).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
function fichiers(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) return n === 'node_modules' || n === '__tests__' || n === '__fixtures__' || n === 'test' ? [] : fichiers(f);
    return /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [f] : [];
  });
}
const sources = fichiers(join(ROOT, 'src')).filter((f) => !f.includes(`${sep}db${sep}migrations${sep}`));
const rel = (f: string) => relative(ROOT, f).split(sep).join('/');
const sql = readdirSync(join(ROOT, 'src/db/migrations')).filter((f) => f.endsWith('.sql')).map((f) => readFileSync(join(ROOT, 'src/db/migrations', f), 'utf8')).join('\n');

/**
 * Seuls écrivains des tables `business_operation*` (avec le motif) : le
 * moteur T3 et les surfaces métier qui lui confient la reconsolidation.
 */
const ECRIVAINS: Record<string, string> = {
  'src/services/business-operations/repository.ts': 'API d’écriture unique (contrôles d’intégrité, historique)',
  'src/services/business-operations/write.ts': 'transaction + verrou du compte + événements après commit',
  'src/services/business-operations/events.ts': 'documentation (aucune écriture)',
  'src/services/business-operations/consolidation/consolidator.ts': 'T3 : candidats T1 → Opérations',
  'src/services/business-operations/consolidation/asset-data-consolidator.ts': 'T3 : données structurées (lot 43)',
  'src/services/business-operations/consolidation/agenda-source-consolidator.ts': 'T3 : agenda source (lot 47B)',
  'src/services/business-operations/consolidation/claim-form.ts': 'T3 : saisie Sinistre puis reconsolidation (lot 44)',
  'src/services/business-operations/consolidation/claim-migration.ts': 'T3 : migration de l’ancien formulaire (lot 44)',
  'src/services/business-operations/claims/claim-operation.service.ts': 'saisie Sinistre (source CLAIM_FORM) → écriture T3',
  'src/services/business-operations/asset-lifecycle.ts': 'cycle de vie des biens (suppression, transfert Duo)',
  'src/services/business-operations/agenda-projection/service.ts': 'T4 : seulement les suppressions de projection (C16.1)',
  'src/services/assets/asset-account-transfer.service.ts': 'transfert Duo : références de fichiers détachées',
  'src/services/to-process/operation-cards.ts': 'décision utilisateur « À traiter » (C6.3) → reconsolidation T3',
  'src/services/business-operations/consolidation/asset-exclusions.ts': 'T3 : exclusion mémorisée d’un bien retiré d’un sinistre (lot 53, Q17)',
  'src/services/to-process/agenda-projection-cards.ts': 'T4 : « ne rien ajouter à l’agenda » = suppression de projection (C16.1, lot 53 D14)',
  'src/services/business-operations/consolidation/identity-review.ts': 'T3 : journal des contrôles d’identité économique et rétablissement d’une séparation par décision M0 (lot 78A)',
};

describe('INV-FINAL-009 / INV-006 / INV-FINAL-013 / INV-031 — T3 seul moteur ; TCO et autres modules consommateurs seulement', () => {
  it('INV-FINAL-009 — aucun module hors de la liste fermée n’écrit une table business_operation* ni n’ouvre une écriture Opération', () => {
    const ecrit = sources.filter((f) => {
      const t = readFileSync(f, 'utf8');
      return /(INSERT INTO|UPDATE|DELETE FROM)\s+business_operation/.test(t) || /withBusinessOperationWrite|BusinessOperationRepository\(/.test(t);
    }).map(rel).sort();
    expect(ecrit.filter((f) => !(f in ECRIVAINS))).toEqual([]);
  });
  it('INV-FINAL-013 / INV-031 — aucun module TCO / finance ne persiste une vérité financière concurrente (aucune table tco*, aucune écriture de composante hors T3)', () => {
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS\s+\w*tco\w*/i);
    const tco = sources.filter((f) => /tco/i.test(rel(f)));
    for (const f of tco) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/business_operation_financial_components\s*\(|INSERT INTO business_operation/);
  });
});

describe('ACC-015 / ACC-016 / ACC-017 / ACC-019 / INV-048 / INV-033 / INV-035 — hors V1 confirmé (C33)', () => {
  const domaine = sources.filter((f) => rel(f).startsWith('src/services/business-operations/'));
  it('ACC-015 / INV-050 — aucun taux de change automatique : aucun appel BCE / API de change dans le domaine, aucune table de taux', () => {
    for (const f of domaine) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/ecb\.europa|exchangerate|fx_rates?|exchange_rates?|convertCurrency/i);
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS\s+\w*(exchange|fx)_rates?\b/i);
  });
  it('ACC-016 — aucun ledger de paiement : aucune table de paiements Opération, PAYMENT n’est pas une composante', async () => {
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS\s+business_operation_\w*payment/i);
    const { FINANCIAL_COMPONENT_KINDS } = await import('../model');
    expect(FINANCIAL_COMPONENT_KINDS).not.toContain('PAYMENT');
  });
  it('ACC-017 — aucune scission automatique générique : aucun « split » dans le domaine', () => {
    for (const f of domaine) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/\bsplit(Operation|Into)|SPLIT_OPERATION|scission automatique/i);
  });
  it('ACC-019 / INV-FINAL-026 / F-196 / F-197 — aucun mode shadow ni interrupteur fonctionnel du système Opération (variables ou code)', () => {
    const hits = sources.filter((f) => /OPERATIONS?_(ENABLED|SHADOW)|BUSINESS_OPERATIONS?_(ENABLED|DISABLED|SHADOW)|OPERATION_SHADOW_MODE|shadowMode/.test(readFileSync(f, 'utf8')));
    expect(hits.map(rel)).toEqual([]);
  });
  it('INV-048 / INV-047 — aucun graphe générique de relations : un seul parent (colonne), pas de table de relations Opération ↔ Opération', () => {
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS\s+business_operation_(relations?|links?|edges?)\b/);
    expect(sql).toMatch(/parent_operation_id\s+BIGINT/);
  });
});

describe('ACC-003 / INV-FINAL-004 — T3 ne dépend pas du fichier brut ; création toujours précédée d’une recherche', () => {
  const t3 = sources.filter((f) => rel(f).startsWith('src/services/business-operations/consolidation/'));
  it('ACC-003 — la consolidation lit les candidats persistés, jamais le fichier (stockage S3, texte extrait, appel T1)', () => {
    expect(t3.length).toBeGreaterThan(5);
    for (const f of t3) {
      expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/@\/lib\/(s3|storage)|getObject|services\/storage|analyseGroupWithMaster|raw_response_json|extracted_text/);
    }
  });
  it('INV-FINAL-004 — la décision CREATE_NEW n’existe qu’après le parcours des Opérations existantes (machine C5)', () => {
    const src = readFileSync(join(ROOT, 'src/services/business-operations/consolidation/matching.ts'), 'utf8');
    const decide = src.slice(src.indexOf('export function decideCandidate'));
    expect(decide.indexOf('for (const op of ctx.operations)')).toBeGreaterThan(0);
    expect(decide.indexOf('for (const op of ctx.operations)')).toBeLessThan(decide.indexOf("'CREATE_NEW'"));
  });
});
