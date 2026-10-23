/**
 * Lot 83D — CDC « Opérations, Agenda, Timeline, Sinistres v5 », lot O-8
 * (§15 à §18, AC35 à AC39, E12 à E16, E21) ; arbitrages PO V-Q1, V-Q2, V-Q8.
 *
 *   L83D-U01  V-Q1 / AC35 / AC36 : bloc « Sinistres » absent du bien, sans
 *             interrupteur ; aucun écran, formulaire, route ni service propre
 *             au bloc ne subsiste (desktop ET mobile : mêmes composants)
 *   L83D-U02  E13 : plus de « Voir le sinistre » ni de `highlight=claims` ;
 *             une source « sinistre » de l'assistant ouvre l'événement
 *             principal (tiroir) ou la fiche du bien
 *   L83D-U03  V-Q2 : plus aucune sous-rubrique « Sinistre » (claim_json) ni
 *             tâche de migration ; une écriture `claim` est refusée
 *   L83D-U04  E16 / AC39 : plus de hiérarchie parent / enfant (aucune écriture
 *             de `parent_operation_id`, anomalies PARENT_* retirées, cartes
 *             parent / dissociation retirées)
 *   L83D-U05  C-Q8 : point de restauration de moins de 24 h exigé (règle pure)
 *   L83D-U06  BO › Rattrapages : bloc « Sinistres : nettoyage de l'ancien
 *             modèle » (Simuler / Appliquer / Restaurer, filtre compte, rapport)
 *   L83D-U07  82E : nouvelles tables classées (export de recette) et conservées
 *             lors d'une restauration ; tables inertes documentées
 *   L83D-U08  dossier : plus de sous-rubrique ni de section « Actions » ;
 *             panneau de préparation sans formulaire (choix du sinistre seul)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const lire = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Fichiers de code de production (hors tests). */
function sources(dir = 'src'): string[] {
  const out: string[] = [];
  for (const n of readdirSync(join(ROOT, dir))) {
    const p = join(ROOT, dir, n);
    if (statSync(p).isDirectory()) {
      if (n === '__tests__' || n === 'test') continue;
      out.push(...sources(relative(ROOT, p)));
    } else if (/\.(ts|tsx)$/.test(n) && !/\.(test|e2e)\.tsx?$/.test(n)) {
      out.push(relative(ROOT, p));
    }
  }
  return out;
}
const PROD = sources();
const contenant = (re: RegExp, sauf: readonly string[] = []) => PROD.filter((f) => !sauf.includes(f) && re.test(sansCommentaires(lire(f))));

describe('L83D-U01 — V-Q1 : bloc « Sinistres » supprimé du bien, sans interrupteur ni remplacement', () => {
  it('composants, éditeur, vues, routes et services propres au bloc retirés', () => {
    for (const f of [
      'src/components/assets/claims/AssetClaimsSection.tsx', 'src/components/assets/claims/ClaimEditor.tsx', 'src/components/assets/claims/ClaimViews.tsx',
      'src/app/api/assets/[id]/claims/route.ts', 'src/app/api/assets/[id]/claims/[claimId]/route.ts',
      'src/services/business-operations/claims/claim-operation.service.ts', 'src/services/business-operations/claims/claim-route.ts',
      'src/services/business-operations/consolidation/claim-form.ts', 'src/services/business-operations/consolidation/claim-migration.ts',
      'src/lib/assets/claim-draft.ts',
    ]) expect(existsSync(join(ROOT, f)), f).toBe(false);
    expect(contenant(/AssetClaimsSection|ClaimEditor|ClaimViews|claim-operation\.service|claim-migration|claim-form|claim-draft|\/api\/assets\/\$\{[^}]+\}\/claims/)).toEqual([]);
  });

  it('fiche du bien (ordinateur et mobile : même composant) : aucune rubrique « Sinistres », aucun interrupteur', () => {
    const tab = sansCommentaires(lire('src/components/assets/AssetDetailsTab.tsx'));
    expect(tab).not.toMatch(/Sinistre|claims|highlightClaim/i);
    expect(sansCommentaires(lire('src/app/(dashboard)/assets/[id]/page.tsx'))).not.toMatch(/searchParams\.get\('claim'\)|highlightClaimId/);
    // Pas d'interrupteur temporaire (V-Q1) : ni drapeau OPERATIONS_V5, ni variable de bascule Sinistres.
    expect(contenant(/OPERATIONS_V5|SINISTRES_BLOCK|CLAIMS_SECTION_ENABLED/)).toEqual([]);
  });
});

describe('L83D-U02 — E13 : navigation générique, plus de « Voir le sinistre »', () => {
  it('ni `highlight=claims` ni `claimSource` dans le code de production', () => {
    expect(contenant(/highlight=claims|claimSource\b/)).toEqual([]);
    expect(sansCommentaires(lire('src/components/agenda/AgendaItemDrawer.tsx'))).not.toContain('Voir le sinistre');
  });

  it('source « sinistre » de l’assistant : événement principal (tiroir), sinon la fiche du bien', async () => {
    const { hrefEntite } = await import('@/services/verebona-assistant/core/entity-ref');
    const avec = hrefEntite({ kind: 'asset', id: 20, sourceId: 'claim:20:9', claimId: 9 } as never, { agendaItemId: 34 });
    expect(avec).toContain('tiroir=echeance');
    expect(avec).toContain('34');
    const sans = hrefEntite({ kind: 'asset', id: 20, sourceId: 'claim:20:9', claimId: 9 } as never, {});
    expect(sans).toMatch(/\/assets\/20/);
    expect(`${avec}${sans}`).not.toMatch(/highlight=claims|claim=9/);
  });
});

describe('L83D-U03 — V-Q2 : ancien formulaire `claim_json` et sa migration retirés', () => {
  it('plus de sous-rubrique « Sinistre » : dictionnaire, familles, écriture refusée', async () => {
    const ai = await import('@/lib/assets/additional-infos');
    expect(ai.ADDITIONAL_INFO_SECTIONS).not.toContain('claim' as never);
    expect(Object.values(ai.SECTIONS_BY_FAMILY).flat()).not.toContain('claim' as never);
    expect(ai.ADDITIONAL_INFO_FIELDS.some((f) => (f.section as string) === 'claim')).toBe(false);
    const r = ai.validateAdditionalInfosPatch({ claim: { claimType: 'VOL' } }, 'IMMOBILIER');
    expect(r).toMatchObject({ ok: false, issues: [{ path: 'claim' }] });
  });

  it('aucune lecture ni écriture de `claim_json` hors du rattrapage de nettoyage', () => {
    // Lot 84A (O-10) : plus déclarée dans Drizzle ; lue seulement par le rattrapage, sa finalisation et la sonde de présence.
    expect(contenant(/claim_json|assetAdditionalInfos\.claim\b/, [
      'src/services/business-operations/claims/legacy-cleanup.ts', 'src/services/business-operations/claims/legacy-finalize.ts',
      'src/services/business-operations/claims/legacy-schema.ts',
    ])).toEqual([]);
  });

  it('tâche « operations-claim-migration » retirée', async () => {
    const { findTask } = await import('@/services/scheduling/scheduled-tasks.catalog');
    expect(findTask('operations-claim-migration')).toBeUndefined();
  });
});

describe('L83D-U04 — E16 / AC39 : plus d’intervention enfant d’un sinistre', () => {
  it('aucune écriture de `parent_operation_id` hors du rattrapage et de la garde de transfert', () => {
    // Lot 84A (O-10) : exceptions RÉDUITES — gardes de sécurité inter-comptes, de transfert (actions), dossier BO
    // « Données du compte », diagnostic et schéma Drizzle ne lisent plus l'ancien modèle.
    expect(contenant(/parent_operation_id\s*=|setParent\(|SET parent_operation_id/, [
      'src/services/business-operations/claims/legacy-cleanup.ts',
      // Garde TRANSITOIRE du transfert d'un bien (clé composée), exécutée seulement si la colonne existe encore (avant « Finaliser »).
      'src/services/business-operations/asset-lifecycle.ts',
    ])).toEqual([]);
    expect(contenant(/parent_operation_id/, [
      'src/services/business-operations/claims/legacy-cleanup.ts', 'src/services/business-operations/claims/legacy-finalize.ts',
      'src/services/business-operations/claims/legacy-schema.ts', 'src/services/business-operations/asset-lifecycle.ts',
    ])).toEqual([]);
    expect(contenant(/business_operation_claim_actions|business_operation_claim_exchanges|business_operation_claim_migration_marks/, [
      'src/services/business-operations/claims/legacy-cleanup.ts', 'src/services/business-operations/claims/legacy-schema.ts',
      // Classement « transfert de bien » (test DUO-06) tant que la table existe : texte seul, jamais lue ni déplacée.
      'src/services/assets/asset-account-transfer.service.ts',
      // Classement de recette (82E) : exportées tant qu'elles existent, absence tolérée après « Finaliser ».
      'src/services/admin/diagnostics-export/recette-catalog.ts',
    ])).toEqual([]);
  });

  it('anomalies PARENT_* et cartes parent / dissociation retirées', async () => {
    const { HARD_ANOMALY_CODES } = await import('@/services/business-operations/diagnostics/model');
    expect(HARD_ANOMALY_CODES.filter((c) => c.startsWith('PARENT_'))).toEqual([]);
    const cards = await import('@/services/to-process/operation-cards');
    expect(cards.OPERATION_CARD_RULES).not.toContain('OPERATION-CLAIM-PARENT' as never);
    expect(cards.OPERATION_CARD_RULES).not.toContain('OPERATION-CLAIM-DETACH' as never);
    expect(cards.isOperationCardRule('OPERATION-CLAIM-PARENT')).toBe(false);
    const { getRule } = await import('@/services/to-process/rules-catalog');
    expect(getRule('OPERATION-CLAIM-PARENT')).toBeUndefined();
    expect(getRule('OPERATION-CLAIM-DETACH')).toBeUndefined();
  });

  it('TCO : une intervention n’est plus jamais un coût de sinistre par filiation', async () => {
    const { tcoCategoryOf } = await import('@/services/business-operations/tco/model');
    expect(tcoCategoryOf({ typeCode: 'CLAIM' })).toBe('CLAIMS');
    expect(tcoCategoryOf({ typeCode: 'INTERVENTION' })).toBe('MAINTENANCE');
  });
});

describe('L83D-U05 — C-Q8 : point de restauration de moins de 24 h exigé avant d’appliquer', () => {
  const NOW = new Date('2026-10-23T12:00:00Z');
  it('aucun point, point trop ancien, format 1, point non restaurable : refus motivé', async () => {
    const { pickRecentRestorePoint } = await import('../legacy-cleanup');
    expect(pickRecentRestorePoint([], NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/Aucun point de restauration de moins de 24 h/) });
    expect(pickRecentRestorePoint([{ backupId: 'a', version: 2, finishedAt: '2026-10-22T11:59:00Z', restorable: true }], NOW).ok).toBe(false);
    expect(pickRecentRestorePoint([{ backupId: null, version: 1, finishedAt: '2026-10-23T11:00:00Z', restorable: false }], NOW).ok).toBe(false);
    expect(pickRecentRestorePoint([{ backupId: 'b', version: 2, finishedAt: '2026-10-23T11:00:00Z', restorable: false }], NOW))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/pas restaurable/) });
  });
  it('point de moins de 24 h restaurable : accepté (le plus récent)', async () => {
    const { pickRecentRestorePoint } = await import('../legacy-cleanup');
    expect(pickRecentRestorePoint([
      { backupId: 'old', version: 2, finishedAt: '2026-10-23T01:00:00Z', restorable: true },
      { backupId: 'new', version: 2, finishedAt: '2026-10-23T11:30:00Z', restorable: true },
    ], NOW)).toEqual({ ok: true, backupId: 'new', finishedAt: '2026-10-23T11:30:00Z', reason: null });
  });
});

describe('L83D-U06 — BO › Exploitation › Rattrapages : « Sinistres : nettoyage de l’ancien modèle »', () => {
  it('bloc 7 : Simuler / Appliquer / Restaurer, filtre compte, avertissement point de restauration', async () => {
    const { backfillDefinition, validateBackfillRequest } = await import('@/services/admin/ops/backfill/definitions');
    expect(backfillDefinition('operations-claims')).toBeNull();
    const d = backfillDefinition('claims-legacy-cleanup');
    expect(d).toMatchObject({ order: 7, actions: ['simulate', 'apply', 'restore'], accountFilter: true });
    expect(d!.warning).toMatch(/point de restauration/);
    expect(d!.description).toMatch(/REFUSÉ sans point de restauration de moins de 24 h/);
    expect(validateBackfillRequest({ script: 'claims-legacy-cleanup', action: 'apply', reason: 'nettoyage V-Q2', accountId: 7 })).toMatchObject({ ok: true });
    expect(validateBackfillRequest({ script: 'claims-legacy-cleanup', action: 'restore', reason: 'retour', runId: 'x' })).toMatchObject({ ok: false, code: 'INVALID_RUN_ID' });
  });

  it('rapport : simulation (à purger), application (journal, restaurable, cohérence), restauration', async () => {
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    const counters = { ACTIONS: 2, EXCHANGES: 1, CHILDREN: 1, LEGACY_FORM: 1, MIGRATION_MARKS: 1, CARDS: 0 };
    const base = { runId: '0b5c3a2e-1111-4222-8333-444455556666', status: 'succeeded', refusal: null, accounts: [7], counters, byAccount: [], samples: [{ accountId: 7, category: 'ACTIONS', label: 'Séchage' }], journalRows: 6 };
    const sim = summarizeBackfill('claims-legacy-cleanup', 'simulate', null, { result: { ...base, mode: 'SIMULATE', restorePoint: null, coherence: { requested: false, campaignId: null, eligibleAccounts: [], skippedAccounts: [] } } });
    expect(sim.headline).toBe('Simulation : 6 élément(s) de l’ancien modèle à purger sur 1 compte(s).');
    expect(sim.restorable).toBe(false);
    const app = summarizeBackfill('claims-legacy-cleanup', 'apply', null, { result: { ...base, mode: 'APPLY', restorePoint: { backupId: 'p1', finishedAt: 'x' }, coherence: { requested: true, campaignId: 42, eligibleAccounts: [7], skippedAccounts: [] } } });
    expect(app.headline).toMatch(/Application : 6 élément\(s\) de l’ancien modèle purgé\(s\) sur 1 compte\(s\) — 6 ligne\(s\) journalisée\(s\), restaurable par 0b5c3a2e/);
    expect(app.scriptRunId).toBe(base.runId);
    expect(app.restorable).toBe(true);
    expect(app.counters).toEqual(expect.arrayContaining([{ label: 'Point de restauration', value: 'p1' }, { label: 'Contrôle de cohérence (campagne)', value: 42 }]));
    const rest = summarizeBackfill('claims-legacy-cleanup', 'restore', null, { result: { runId: base.runId, restoreRunId: 'r2', restored: 6, conflicts: [] } });
    expect(rest.headline).toBe(`Restauration de ${base.runId} : 6 ligne(s) rétablie(s), 0 conflit(s).`);
  });
});

describe('L83D-U07 — périmètre de recette (82E) et restauration', () => {
  it('nouvelles tables classées ; tables inertes documentées comme telles', () => {
    const cat = lire('src/services/admin/diagnostics-export/recette-catalog.ts');
    for (const t of ['claim_legacy_cleanup_runs', 'claim_legacy_cleanup_journal']) expect(cat).toContain(`  ${t}: { domain: 'operations'`);
    for (const t of ['business_operation_claim_actions', 'business_operation_claim_exchanges', 'business_operation_claim_migration_marks']) {
      expect(cat).toMatch(new RegExp(`  ${t}: \\{ domain: 'operations', description: '[^']*INERTES`));
    }
  });
  it('journal du nettoyage conservé lors d’une restauration complète (comme les autres journaux de rattrapage)', async () => {
    const { RESTORE_KEEP_CURRENT_TABLES } = await import('@/services/backup/schema-signature');
    expect(RESTORE_KEEP_CURRENT_TABLES).toEqual(expect.arrayContaining(['claim_legacy_cleanup_runs', 'claim_legacy_cleanup_journal', 'ops_backfill_runs']));
  });
  it('migration 0672 : tables de journal seulement, aucune suppression, aucun DROP TABLE ; index CONCURRENTLY à part', () => {
    // Clauses de clé étrangère (« ON DELETE CASCADE ») hors du contrôle : seules les instructions comptent.
    const m = lire('src/db/migrations/0672_l83d_sinistres_nettoyage.sql').replace(/--.*$/gm, '').replace(/\bON DELETE (CASCADE|SET NULL)\b/gi, '').replace(/'[^']*'/g, "''");
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS claim_legacy_cleanup_runs/);
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS claim_legacy_cleanup_journal/);
    expect(m).not.toMatch(/\bDROP\b|\bDELETE\b|\bUPDATE\b|\bTRUNCATE\b|CONCURRENTLY/i);
    expect(lire('src/db/migrations/0672_l83d_sinistres_nettoyage_idx_1.sql')).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS claim_legacy_cleanup_journal_run_idx/);
  });
});

describe('L83D-U08 — dossier Assurance-sinistre : aucune saisie dédiée (V-Q8)', () => {
  it('plus de sous-rubrique ni de section « Actions » ; Pièces / équipements dans la synthèse', async () => {
    const { DOSSIER_ADDITIONAL_SECTIONS } = await import('@/services/exports/catalog');
    expect(DOSSIER_ADDITIONAL_SECTIONS.ASSURANCE_SINISTRE).toEqual([]);
    const { PREP_SECTIONS } = await import('@/services/exports/v12/preparation/sections');
    expect(PREP_SECTIONS.ASSURANCE_SINISTRE.map((s) => s.id)).not.toContain('actions');
    const { DEFAULT_SECTIONS } = await import('@/services/exports/v12/data/choices');
    expect(Object.keys(DEFAULT_SECTIONS.ASSURANCE_SINISTRE)).not.toContain('actions');
    const tpl = lire('src/services/exports/v12/templates/assurance-sinistre.ts');
    expect(tpl).toContain("'Pièces concernées'");
    expect(tpl).toContain("'Équipements concernés'");
    expect(tpl).not.toContain('Actions déjà réalisées');
  });
  it('préparation (ordinateur et mobile) : choix du sinistre seulement, aucun formulaire ni création', () => {
    const p = sansCommentaires(lire('src/components/exports/preparation/ClaimExportPanel.tsx'));
    expect(p).not.toMatch(/ClaimEditor|apiClient|\.post\(|Ajouter un sinistre/);
    expect(p).toContain('w-full');
    expect(p).toContain('break-words');
  });
});
