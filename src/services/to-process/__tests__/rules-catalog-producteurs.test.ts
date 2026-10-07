/**
 * Lot 28 (ticket P0) — le catalogue `PROCESSING_RULES` PILOTE la production
 * des actions « À traiter » :
 *   · toute règle déclare un producteur réel, dont le module existe et dont
 *     le point d'entrée est appelé HORS de son module (code de production) ;
 *   · un producteur générique lit le catalogue (aucune règle codée) ;
 *   · plus aucun code ne dépend des résidus V1 supprimés.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));
const { PROCESSING_RULES, RULE_PRODUCERS, checkRulesCatalog, documentBridgeRules } = await import('../rules-catalog');

const ROOT = process.cwd();
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

/** Fichiers de production (hors tests) de `src`. */
function sources(dir = join(ROOT, 'src')): string[] {
  const out: string[] = [];
  for (const nom of readdirSync(dir)) {
    const p = join(dir, nom);
    if (statSync(p).isDirectory()) {
      if (nom === '__tests__' || nom === 'e2e' || nom === 'node_modules') continue;
      out.push(...sources(p));
    } else if (/\.(ts|tsx)$/.test(nom) && !/\.(test|e2e)\.tsx?$/.test(nom)) {
      out.push(relative(ROOT, p).split('\\').join('/'));
    }
  }
  return out;
}
const SRC = sources();

describe('catalogue « À traiter » : chaque règle a un producteur réel', () => {
  it('contrôle d’intégrité du catalogue : aucune anomalie', () => {
    expect(checkRulesCatalog()).toEqual([]);
  });

  it.each(PROCESSING_RULES.map((r) => [r.code, r.producer] as const))('%s → producteur %s déclaré', (_code, producer) => {
    expect(RULE_PRODUCERS[producer]).toBeDefined();
  });

  it.each(Object.entries(RULE_PRODUCERS))('producteur %s : module présent, point d’entrée appelé ailleurs', (_nom, meta) => {
    expect(existsSync(join(ROOT, meta.module)), meta.module).toBe(true);
    const contenu = read(meta.module);
    for (const entree of meta.entries) {
      expect(contenu, `${entree} exporté par ${meta.module}`).toMatch(new RegExp(`export (async )?function ${entree}\\b`));
      const appelants = SRC.filter((f) => f !== meta.module && new RegExp(`\\b${entree}\\b`).test(read(f)));
      expect(appelants.length, `${entree} n’est appelé par aucun code de production`).toBeGreaterThan(0);
    }
  });

  it('producteurs dédiés : le code de chaque règle figure dans son module', () => {
    for (const rule of PROCESSING_RULES) {
      const meta = RULE_PRODUCERS[rule.producer];
      if (meta.generic) continue;
      expect(read(meta.module), `${rule.code} dans ${meta.module}`).toContain(rule.code);
    }
  });

  it('producteurs génériques : pilotés par le catalogue, sans code de règle en dur', () => {
    const pont = read(RULE_PRODUCERS.DOCUMENT_BRIDGE.module);
    expect(pont).toMatch(/documentBridgeRules\(\)/);
    for (const rule of documentBridgeRules()) {
      // Le pont ne connaît aucune règle par son code : il parcourt le catalogue.
      expect(pont.replace(/^\s*(\*|\/\/).*$/gm, '')).not.toContain(`'${rule.code}'`);
    }
    expect(read(RULE_PRODUCERS.RECONCILIATION_BRIDGE.module)).toMatch(/findRule\(/);
    expect(read(RULE_PRODUCERS.CLASSIFICATION.module)).toMatch(/decide\(/);
  });

  it('les quatre règles documentaires du ticket sont produites par le pont générique', () => {
    expect(documentBridgeRules().map((r) => r.code).sort())
      .toEqual(['DATA-CONTRACT-END', 'DATA-SUPPLIER', 'DATA-WARRANTY-END', 'LINK-ASSET']);
  });

  it('pertinence métier : fin de contrat et de garantie ne valent que pour leurs Types', () => {
    const r = (c: string) => PROCESSING_RULES.find((x) => x.code === c)!;
    expect(r('DATA-CONTRACT-END').relevantDocumentTypes).toContain('MAINTENANCE_CONTRACT');
    expect(r('DATA-WARRANTY-END').relevantDocumentTypes).toEqual(['WARRANTY_CERTIFICATE', 'EXTENDED_WARRANTY']);
    expect(r('LINK-ASSET').relevantDocumentTypes).toBeUndefined();
    expect(r('LINK-ASSET').cardinality).toBe('atLeastOne');
  });
});

describe('résidus V1 (lot 28) : supprimés, plus aucun consommateur', () => {
  it.each([
    'src/app/api/dashboard/a-traiter/route.ts',
    'src/app/api/dashboard/a-traiter/documents/[id]/ignore/route.ts',
    'src/services/to-process.service.ts',
    'src/types/to-process.ts',
    'src/services/to-process/legacy-migration.service.ts',
    'src/app/api/cron/to-process/migrate-legacy/route.ts',
  ])('%s n’existe plus', (f) => {
    expect(existsSync(join(ROOT, f))).toBe(false);
  });

  it('aucun import des modules V1, aucune lecture de l’ancienne route', () => {
    const fautifs = SRC.filter((f) => {
      // Les commentaires peuvent rappeler l'historique ; seul le code compte.
      const s = read(f).replace(/^\s*(\*|\/\/).*$/gm, '');
      return /from ['"]@\/types\/to-process['"]/.test(s)
        || /from ['"]@\/services\/to-process\.service['"]/.test(s)
        || /legacy-migration\.service/.test(s)
        || /['"`]\/api\/dashboard\/a-traiter/.test(s);
    });
    expect(fautifs).toEqual([]);
  });

  it('les services « À traiter » V2 ne manipulent que ARBITRATE / COMPLETE', () => {
    const dir = 'src/services/to-process';
    for (const f of SRC.filter((x) => x.startsWith(`${dir}/`))) {
      const code = read(f).replace(/^\s*(\*|\/\/).*$/gm, '');
      expect(code, f).not.toMatch(/family\s*:\s*['"](arbitrate|attach|confirm|complete)['"]/);
      expect(code, f).not.toMatch(/ToProcessFamily/);
    }
  });
});
