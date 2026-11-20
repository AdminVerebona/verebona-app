/**
 * Carte #806 (lot 116C, seconde partie) — audit du stock : règles PURES et
 * gardes de code (le comportement réel est prouvé par `l116cb-audit-stock.e2e.ts`).
 *
 *   L116CB-M-U01  chaque anomalie a un devenir déclaré ; UNE seule correction automatique
 *   L116CB-M-U02  dates d'un même fait : divergence et présomption de propagation, avec la règle existante de la synchronisation
 *   L116CB-M-U03  garde-fou de volumétrie : toute perte et toute création indue sont détectées
 *   L116CB-M-U04  synthèse anonymisée : des codes et des nombres
 *   L116CB-M-U05  le module ne supprime rien et s'appuie sur le contrôle du graphe existant (aucun second mécanisme)
 *   L116CB-M-U06  la colonne historique `agenda_items.operation_role` n'est LUE que par l'inventaire de migration existant
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const audit = await import('../stock-audit');
type Lien = import('../stock-audit').FactLinkRow;
type Rapport = import('../stock-audit').StockAuditReport;

const RACINE = resolve(__dirname, '..', '..', '..', '..', '..');
const lire = (p: string) => readFileSync(resolve(RACINE, p), 'utf8').replace(/\r\n?/g, '\n');

const lien = (o: Partial<Lien> & { id: number }): Lien => ({
  operationId: 1, agendaItemId: o.id, factKey: null, typeCode: 'INTERVENTION', status: 'REALIZED',
  realizedDate: '2024-03-10', plannedDate: null, startDate: '2024-03-10', automatic: false, ...o,
});

describe('L116CB-M — audit du stock des opérations (#806)', () => {
  it('L116CB-M-U01 — devenir de chaque anomalie ; une seule correction automatique', () => {
    expect(Object.keys(audit.STOCK_ANOMALY_DESCRIPTIONS).sort()).toEqual([...audit.STOCK_ANOMALY_CODES].sort());
    const parDevenir = (d: string) => audit.STOCK_ANOMALY_CODES.filter((c) => audit.STOCK_ANOMALY_DESCRIPTIONS[c].disposition === d);
    expect(parDevenir('CERTAIN_FIX')).toEqual(['LEGACY_LINK_RESTORABLE']);
    // Tout ce qui touche une décision de l'utilisateur ou l'identité d'une opération reste à ARBITRER.
    for (const c of ['OPERATION_CREATED_BY_SIMPLE_LINK', 'OPERATIONS_MERGED_BY_SIMPLE_LINK', 'INSURANCE_CLAIM_MERGED', 'FINANCING_ACQUISITION_MERGED',
      'FINANCING_ACQUISITION_WITHOUT_RELATION', 'FACT_DATE_DIVERGENT', 'LEGACY_LINK_BLOCKED_BY_DECISION'] as const) {
      expect(audit.STOCK_ANOMALY_DESCRIPTIONS[c].disposition, c).toBe('ARBITRATION');
    }
    for (const c of audit.STOCK_ANOMALY_CODES) expect(audit.STOCK_ANOMALY_DESCRIPTIONS[c].label.length, c).toBeGreaterThan(20);
  });

  it('L116CB-M-U02 — dates d’un même fait : règle de la synchronisation, jamais une règle propre', () => {
    const r = audit.classifyFactDates([
      // Porteur aligné : rien.
      lien({ id: 1, operationId: 1, factKey: 'INTERVENTION' }),
      // Autre événement de la même opération, automatique, non porteur, même date : présomption de propagation.
      lien({ id: 2, operationId: 1, automatic: true }),
      // Même chose mais modifié ou saisi par l'utilisateur : jamais présumé.
      lien({ id: 3, operationId: 1, automatic: false }),
      // Autre date : ce n'est pas une propagation.
      lien({ id: 4, operationId: 1, automatic: true, startDate: '2024-02-01' }),
      // Porteur dont la date diffère de celle de l'opération : divergence.
      lien({ id: 5, operationId: 2, factKey: 'INTERVENTION', startDate: '2024-03-12' }),
      // … et aucun autre événement de cette opération n'est présumé propagé (le fait n'a pas de date commune).
      lien({ id: 6, operationId: 2, automatic: true }),
      // Intervention envisagée : le même fait est la date PRÉVUE.
      lien({ id: 7, operationId: 3, factKey: 'INTERVENTION', status: 'ENVISAGED', realizedDate: null, plannedDate: '2025-01-01', startDate: '2025-01-02' }),
      // Faits jamais synchronisés (contrat, fin de contrat, fait d'un autre type) : jamais une divergence.
      lien({ id: 8, operationId: 4, factKey: 'CONTRACT:END', typeCode: 'CONTRACT', startDate: '2030-01-01' }),
      lien({ id: 9, operationId: 5, factKey: 'CLAIM', typeCode: 'INTERVENTION', startDate: '2030-01-01' }),
      // Une date absente d'un côté n'est pas une divergence (rien n'est inventé).
      lien({ id: 10, operationId: 6, factKey: 'INTERVENTION', startDate: null }),
      lien({ id: 11, operationId: 7, factKey: 'INTERVENTION', realizedDate: null }),
    ]);
    expect(r).toEqual({ divergent: [5, 7], presumedPropagated: [2] });
    expect(audit.classifyFactDates([])).toEqual({ divergent: [], presumedPropagated: [] });
  });

  it('L116CB-M-U03 — garde-fou : perte ou création indue détectée', () => {
    const base = { operations: 5, relations: 2, liens_agenda: 4, liens_agenda_actifs: 3, liens_directs: 6, justificatifs: 9, evenements: 7, rappels: 1, cartes_ouvertes: 2 };
    expect(audit.volumetryViolations(base, base)).toEqual([]);
    // La seule évolution permise : des liens du graphe EN PLUS.
    expect(audit.volumetryViolations(base, { ...base, liens_agenda: 5, liens_agenda_actifs: 4 })).toEqual([]);
    expect(audit.volumetryViolations(base, { ...base, liens_directs: 5 })).toEqual(['liens_directs:6->5']);
    expect(audit.volumetryViolations(base, { ...base, justificatifs: 8 })).toEqual(['justificatifs:9->8']);
    expect(audit.volumetryViolations(base, { ...base, liens_agenda_actifs: 2 })).toEqual(['liens_agenda_actifs:3->2']);
    // Ni rappel, ni carte, ni opération, ni relation créés par l'audit.
    expect(audit.volumetryViolations(base, { ...base, rappels: 2, cartes_ouvertes: 3, operations: 6, relations: 3 }).sort())
      .toEqual(['cartes_ouvertes:2->3', 'operations:5->6', 'rappels:1->2', 'relations:2->3']);
    for (const k of ['liens_directs', 'justificatifs', 'evenements', 'operations', 'relations']) {
      expect(audit.NEVER_DECREASING, k).toContain(k);
      expect(audit.NEVER_CHANGING, k).toContain(k);
    }
  });

  it('L116CB-M-U04 — synthèse : des codes et des nombres', () => {
    const rapport = (accountId: number, n: number, restaures: number): Rapport => ({
      accountId, mode: 'APPLIED', graphFindings: n ? [{ code: 'LEGACY_LINK_MISSING', count: n, sample: [1] }] : [],
      anomalies: audit.STOCK_ANOMALY_CODES.map((code) => ({
        code, ...audit.STOCK_ANOMALY_DESCRIPTIONS[code], count: code === 'FACT_DATE_DIVERGENT' ? n : 0, sample: [],
      })),
      volumetryBefore: {}, volumetryAfter: {}, fixes: { legacyLinksToRestore: restaures, legacyLinksRestored: restaures }, arbitration: n,
    });
    const s = audit.summarizeStockAudit([rapport(1, 2, 1), rapport(2, 0, 0), rapport(3, 1, 3)], [9, 4], 'APPLIED');
    expect(s).toMatchObject({ mode: 'APPLIED', accounts: 5, accountsWithAnomalies: 2, failedAccounts: [4, 9], legacyLinksToRestore: 4, legacyLinksRestored: 4, arbitration: 3 });
    expect(s.totals.FACT_DATE_DIVERGENT).toBe(3);
    expect(s.graphTotals).toEqual({ LEGACY_LINK_MISSING: 3 });
    expect(Object.keys(s.totals).sort()).toEqual([...audit.STOCK_ANOMALY_CODES].sort());
    // Rien d'autre que des nombres dans les totaux.
    expect(Object.values(s.totals).every((v) => typeof v === 'number')).toBe(true);
  });

  it('L116CB-M-U05 — aucune suppression, aucun second mécanisme', () => {
    const code = lire('src/services/business-operations/migration-744/stock-audit.ts');
    const sansCommentaires = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(sansCommentaires).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sansCommentaires).not.toMatch(/\bTRUNCATE\b|\bDROP\b/i);
    // Le module n'écrit AUCUNE table lui-même (invariant INV-FINAL-009) : la seule écriture passe par l'unique écrivain du
    // graphe, qui pose le lien et le journalise.
    expect(sansCommentaires).not.toMatch(/\bINSERT INTO\b/i);
    expect(sansCommentaires).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(sansCommentaires).toContain("restoreMissingLegacyAgendaLink(r, accountId, {");
    const depot = lire('src/services/business-operations/graph/store.ts');
    const pose = depot.slice(depot.indexOf('export async function restoreMissingLegacyAgendaLink'), depot.indexOf('export async function resyncLegacyAgendaLinks'));
    expect(pose.match(/\bINSERT INTO\s+(\w+)/g)).toEqual(['INSERT INTO business_operation_agenda_links']);
    expect(pose).not.toMatch(/\bUPDATE\b|\bDELETE\b/);
    expect(pose).toContain('ON CONFLICT (operation_id, agenda_item_id) DO NOTHING');
    expect(pose).toContain("d.decision = 'REJECTED' AND d.active");
    expect(pose).toContain('await journalGraph(r, accountId, {');
    // Les écarts du graphe viennent du contrôle existant ; la règle des dates, de la synchronisation existante.
    expect(sansCommentaires).toContain('auditOperationGraph(r, accountId)');
    expect(sansCommentaires).toContain("import { syncedOperationDateField } from '../graph/fact-date-sync'");
    // Simulation : transaction en lecture seule ; application : verrou du compte et garde-fou avant de valider.
    expect(sansCommentaires).toContain("'ISOLATION LEVEL REPEATABLE READ READ ONLY'");
    expect(sansCommentaires).toContain('lockGroupingAccount(r, accountId)');
    expect(sansCommentaires).toContain('STOCK_AUDIT_INVARIANT');
    // Aucune IA, aucune carte, aucun rappel.
    expect(sansCommentaires).not.toMatch(/upsertAction|notification_outbox\s*\(|callAi|ai-gateway/);
    const script = lire('scripts/audit-806-stock-operations.ts');
    expect(script).toContain("const apply = process.argv.includes('--apply');");
    expect(script).not.toMatch(/\bDELETE\b|\bUPDATE\b/);
  });

  it('L116CB-M-U06 — la colonne historique `operation_role` n’est lue que par l’inventaire de migration existant', () => {
    const fichiers: string[] = [];
    const parcourir = (dossier: string) => {
      for (const nom of readdirSync(dossier)) {
        if (nom === '__tests__' || nom === 'node_modules' || nom === 'migrations' || nom === 'test') continue;
        const p = join(dossier, nom);
        if (statSync(p).isDirectory()) parcourir(p);
        else if (/\.(ts|tsx)$/.test(nom) && !/\.test\.tsx?$/.test(nom)) fichiers.push(p);
      }
    };
    parcourir(resolve(RACINE, 'src'));
    // Lecture ou écriture SQL de la colonne : `i.operation_role`, `operation_role =`, `SET operation_role`… — hors
    // `operation_role_origin` (autre colonne) et hors alias calculés depuis le graphe (`AS operation_role`).
    const lecteurs = fichiers.filter((f) => {
      const sans = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
        .replace(/operation_role_origin/g, '').replace(/AS operation_role\b/g, '').replace(/x\.operation_role\b/g, '');
      return /\boperation_role\b/.test(sans);
    }).map((f) => f.slice(RACINE.length + 1)).sort();
    // L'audit du stock ne lit pas la colonne lui-même : il reprend la mesure de l'inventaire existant (garde L114OR-G03).
    expect(lecteurs).toEqual([
      'src/db/schema.ts',
      'src/services/business-operations/migration-744/inventory.ts',
    ]);
    const audit806 = lire('src/services/business-operations/migration-744/stock-audit.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(audit806).toContain("INVENTORY_MEASURES.find((m) => m.key === 'principal')");
  });
});
