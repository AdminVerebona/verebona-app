/**
 * Lot 84A — CDC « Opérations v5 », lot O-10 : suppression définitive de
 * l'ancien modèle Sinistres comme ÉTAPE FINALE du rattrapage BO existant.
 * (Preuve sur PostgreSQL 16 : `l84a-sinistres-finalisation.e2e.ts`.)
 *
 *   L84A-U01  aucune migration du lot ne supprime l'ancien modèle (aucun DROP
 *             inconditionnel : la suppression est une action BO) ;
 *   L84A-U02  BO › Rattrapages : bloc 7 à deux étapes — « Finaliser » (simuler /
 *             appliquer, toute la plateforme, libellé, avertissement) ;
 *             compatibilité des demandes sans étape (nettoyage) ;
 *   L84A-U03  rapports lisibles : simulation possible / refusée, application,
 *             déjà supprimé ; nettoyage après finalisation ;
 *   L84A-U04  restauration d'un point ANTÉRIEUR à la finalisation : refus
 *             motivé (variante prudente) ; autre écart de schéma : motif général ;
 *   L84A-U05  export de recette : tables de l'ancien modèle tolérées absentes ;
 *   L84A-U06  code mort retiré : plus aucune lecture de l'ancien modèle hors du
 *             rattrapage, de sa finalisation, de la sonde et de la garde
 *             transitoire du transfert (conditionnée à la présence de la colonne) ;
 *   L84A-U07  motif « nettoyage incomplet » détaillé ;
 *   L84A-U08  routes « events » sans appelant et composant orphelin retirés
 *             (E25) ; ce que l'interface appelle encore existe.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const lire = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*--.*$/gm, '');

function sources(dir = 'src'): string[] {
  const out: string[] = [];
  for (const n of readdirSync(join(ROOT, dir))) {
    const p = join(ROOT, dir, n);
    if (statSync(p).isDirectory()) {
      if (n === '__tests__' || n === 'test') continue;
      out.push(...sources(relative(ROOT, p)));
    } else if (/\.(ts|tsx)$/.test(n) && !/\.(test|e2e)\.tsx?$/.test(n)) out.push(relative(ROOT, p));
  }
  return out;
}

describe('L84A-U01 — aucune suppression de l’ancien modèle dans une migration', () => {
  it('migrations 0680-0683 : ni DROP TABLE ni DROP COLUMN, seulement les modes du journal', () => {
    const fichiers = readdirSync(join(ROOT, 'src/db/migrations')).filter((f) => /^068[0-3]_/.test(f));
    expect(fichiers).toEqual(['0680_l84a_sinistres_finalisation.sql']);
    for (const f of fichiers) {
      const code = sansCommentaires(lire(`src/db/migrations/${f}`));
      expect(code, f).not.toMatch(/DROP\s+(TABLE|COLUMN|INDEX)/i);
      expect(code, f).not.toMatch(/business_operation_claim_actions|business_operation_claim_exchanges|parent_operation_id|claim_json/);
      expect(code).toMatch(/'FINALIZE_SIMULATE', 'FINALIZE'/);
    }
  });
});

describe('L84A-U02 — BO › Rattrapages : étape finale du MÊME bloc', () => {
  it('bloc 7 à deux étapes ; « Finaliser » : simuler / appliquer, plateforme entière', async () => {
    const d = await import('@/services/admin/ops/backfill/definitions');
    const def = d.backfillDefinition('claims-legacy-cleanup')!;
    expect(d.BACKFILL_DEFINITIONS.filter((x) => /sinistre/i.test(x.label)).map((x) => x.script)).toEqual(['claims-legacy-cleanup']);
    expect(def.steps!.map((s) => s.code)).toEqual(['cleanup', 'finalize']);
    expect(def.defaultStep).toBe('cleanup');
    expect(d.stepActions(def, 'cleanup')).toEqual(['simulate', 'apply', 'restore']);
    expect(d.stepActions(def, 'finalize')).toEqual(['simulate', 'apply']);
    expect(d.actionLabel(def, 'finalize', 'apply')).toBe('Finaliser');
    expect(d.actionLabel(def, 'finalize', 'simulate')).toBe('Simuler');
    expect(d.actionLabel(def, 'cleanup', 'apply')).toBe('Appliquer');
    expect(def.steps![1].warning).toMatch(/DÉFINITIVE, irréversible/);
  });

  it('validation : finaliser sans motif, avec un compte, ou « restaurer » : refusés ; ancienne demande sans étape = nettoyage', async () => {
    const { validateBackfillRequest } = await import('@/services/admin/ops/backfill/definitions');
    expect(validateBackfillRequest({ script: 'claims-legacy-cleanup', action: 'simulate', step: 'finalize' })).toMatchObject({ ok: true, value: { step: 'finalize', accountId: null } });
    expect(validateBackfillRequest({ script: 'claims-legacy-cleanup', action: 'apply', step: 'finalize', reason: 'Fin O-10' })).toMatchObject({ ok: true });
    expect(validateBackfillRequest({ script: 'claims-legacy-cleanup', action: 'apply', step: 'finalize' })).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(validateBackfillRequest({ script: 'claims-legacy-cleanup', action: 'apply', step: 'finalize', reason: 'Fin O-10', accountId: 7 })).toMatchObject({ ok: false, code: 'ACCOUNT_FILTER_NOT_SUPPORTED' });
    expect(validateBackfillRequest({ script: 'claims-legacy-cleanup', action: 'apply', reason: 'nettoyage', accountId: 7 })).toMatchObject({ ok: true, value: { step: 'cleanup', accountId: 7 } });
    expect(validateBackfillRequest({ script: 'claims-legacy-cleanup', action: 'simulate', step: 'inconnue' })).toMatchObject({ ok: false, code: 'INVALID_STEP' });
  });

  it('exécution : l’étape « finalize » passe par le service de finalisation ; la page suit les actions de chaque étape (desktop et mobile)', () => {
    const ex = sansCommentaires(lire('src/services/admin/ops/backfill/executors.ts'));
    expect(ex).toMatch(/req\.step === 'finalize'[\s\S]*runClaimLegacyFinalization/);
    const page = sansCommentaires(lire('src/app/admin/exploitation/_components/BackfillsPanel.tsx'));
    expect(page).toMatch(/const actions = stepActions\(def, step\)/);
    expect(page).toMatch(/\{actionLabel\(def, step, 'apply'\)\}/);
    expect(page).toMatch(/accountFilter === false/);
    expect(page).toMatch(/flex flex-wrap items-center gap-2/);
  });
});

describe('L84A-U03 — rapports lisibles', () => {
  const zero = { ACTIONS: 0, EXCHANGES: 0, CHILDREN: 0, LEGACY_FORM: 0, MIGRATION_MARKS: 0, CARDS: 0 };
  const objets = [
    { kind: 'TABLE', name: 'business_operation_claim_actions', present: true, rows: 0, with: [] },
    { kind: 'COLUMN', name: 'asset_additional_infos.claim_json', present: true, rows: 0, with: [] },
  ];
  const base = { kind: 'FINALIZE', runId: 'r1', status: 'succeeded', alreadyFinalized: false, finalizedAt: null, refusal: null, remaining: zero, remainingAccounts: [], restorePoint: null, objects: objets, dropped: [] };

  it('simulation possible / refusée, application, déjà supprimé', async () => {
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    const ok = summarizeBackfill('claims-legacy-cleanup', 'simulate', 'finalize', { result: { ...base, mode: 'SIMULATE', possible: true, blockers: [], restorePoint: { backupId: 'p1', finishedAt: 'x' } } });
    expect(ok.headline).toMatch(/finalisation POSSIBLE — 2 objet\(s\).*rien n’est modifié/);
    expect(ok.restorable).toBe(false);
    const ko = summarizeBackfill('claims-legacy-cleanup', 'simulate', 'finalize', {
      result: { ...base, mode: 'SIMULATE', possible: false, remaining: { ...zero, ACTIONS: 2 }, remainingAccounts: [7], blockers: [{ code: 'CLEANUP_INCOMPLETE', message: 'Nettoyage incomplet : 2 élément(s)' }] },
    });
    expect(ko.headline).toMatch(/REFUSÉE pour l’instant — Nettoyage incomplet/);
    expect(ko.conflicts.count).toBe(1);
    expect(ko.warnings.join('\n')).toMatch(/Reste à nettoyer : .* — 2[\s\S]*Comptes concernés : 7/);
    const fait = summarizeBackfill('claims-legacy-cleanup', 'apply', 'finalize', { result: { ...base, mode: 'APPLY', possible: true, blockers: [], dropped: ['business_operation_claim_actions', 'asset_additional_infos.claim_json'] } });
    expect(fait.headline).toMatch(/2 objet\(s\) de l’ancien modèle supprimé\(s\) définitivement\. Créez un nouveau point de restauration/);
    const deja = summarizeBackfill('claims-legacy-cleanup', 'apply', 'finalize', { result: { ...base, mode: 'APPLY', alreadyFinalized: true, finalizedAt: '2026-10-24T08:00:00.000Z', possible: false, blockers: [] } });
    expect(deja.headline).toMatch(/déjà supprimé \(finalisation du 2026-10-24\) : rien à faire/);
  });

  it('nettoyage après finalisation : « ancien modèle supprimé », non restaurable', async () => {
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    const s = summarizeBackfill('claims-legacy-cleanup', 'apply', 'cleanup', {
      result: { runId: 'r2', mode: 'APPLY', status: 'succeeded', refusal: null, restorePoint: null, accounts: [], counters: zero, byAccount: [], samples: [], journalRows: 0,
        coherence: { requested: false, campaignId: null, eligibleAccounts: [], skippedAccounts: [] }, finalized: { at: '2026-10-24T08:00:00.000Z', runId: 'f1' } },
    });
    expect(s).toMatchObject({ restorable: false, headline: expect.stringMatching(/ancien modèle supprimé définitivement le 2026-10-24 — rien à nettoyer/) });
  });
});

describe('L84A-U04 — restauration d’un point antérieur à la finalisation', () => {
  const avant = {
    business_operations: ['account_id:int4', 'id:int8', 'parent_operation_id:int8', 'status:text'],
    asset_additional_infos: ['asset_id:int4', 'claim_json:jsonb', 'commercial_json:jsonb'],
    business_operation_claim_actions: ['id:int8', 'title:text'],
    assets: ['id:int4'],
  };
  const apres = {
    business_operations: ['account_id:int4', 'id:int8', 'status:text'],
    asset_additional_infos: ['asset_id:int4', 'commercial_json:jsonb'],
    assets: ['id:int4'],
  };
  const point = (sig: Record<string, string[]>) => ({ version: 2, tables: Object.entries(sig).map(([name, columns]) => ({ name, columns })) });

  it('refusé (variante prudente, jamais partiel) avec un motif dédié ; même schéma : restaurable', async () => {
    const { checkRestoreCompatibility, PRE_FINALIZATION_RESTORE_REASON } = await import('@/services/backup/schema-signature');
    const r = checkRestoreCompatibility(point(avant), apres, []);
    expect(r).toMatchObject({ restorable: false, predatesClaimFinalization: true, restoredTables: [] });
    expect(r.reason!.startsWith(PRE_FINALIZATION_RESTORE_REASON)).toBe(true);
    expect(r.reason).toMatch(/ANTÉRIEUR à la suppression définitive de l’ancien modèle Sinistres/);
    expect(r.differences.map((d) => `${d.table}:${d.issue}`).sort()).toEqual([
      'asset_additional_infos:COLONNES_DIFFERENTES', 'business_operation_claim_actions:ABSENTE_AUJOURD_HUI', 'business_operations:COLONNES_DIFFERENTES']);
    expect(checkRestoreCompatibility(point(apres), apres, [])).toMatchObject({ restorable: true });
    expect(checkRestoreCompatibility(point(avant), avant, [])).toMatchObject({ restorable: true });
  });

  it('autre écart de schéma : motif général inchangé (L82E-E06)', async () => {
    const { checkRestoreCompatibility } = await import('@/services/backup/schema-signature');
    const r = checkRestoreCompatibility(point(apres), { ...apres, assets: ['id:int4', 'nouvelle:text'] }, []);
    expect(r).toMatchObject({ restorable: false, predatesClaimFinalization: false });
    expect(r.reason).toMatch(/Le schéma a changé depuis ce point/);
  });
});

describe('L84A-U05 — export de recette : ancien modèle toléré absent', () => {
  it('classement complet avant ET après la finalisation', async () => {
    const { classifyTables, RECETTE_RETIRABLE_TABLES, RECETTE_TABLES } = await import('@/services/admin/diagnostics-export/recette-catalog');
    const { LEGACY_CLAIM_TABLES } = await import('../legacy-schema');
    // Lot 86A : + `ai_corpus_baseline`, table de l'ancien harnais de mesure (créée à la volée, jamais par migration).
    expect([...RECETTE_RETIRABLE_TABLES].sort()).toEqual([...LEGACY_CLAIM_TABLES, 'ai_corpus_baseline'].sort());
    for (const t of LEGACY_CLAIM_TABLES) expect(RECETTE_TABLES[t]?.description, t).toMatch(/SUPPRIMÉE par sa finalisation/);
    const autres = ['assets', 'business_operations'];
    expect(classifyTables([...autres, ...LEGACY_CLAIM_TABLES]).included.map((x) => x.table)).toEqual(expect.arrayContaining([...LEGACY_CLAIM_TABLES]));
    expect(classifyTables(autres).missing.filter((t) => (LEGACY_CLAIM_TABLES as readonly string[]).includes(t))).toEqual([]);
    expect(classifyTables(autres).missing).toContain('accounts');
  });
});

describe('L84A-U06 — code mort retiré', () => {
  const PROD = sources();
  const contenant = (re: RegExp) => PROD.filter((f) => re.test(sansCommentaires(lire(f))));

  it('plus aucune lecture de l’ancien modèle hors rattrapage, finalisation, sonde et garde transitoire', () => {
    expect(contenant(/business_operation_claim_actions|business_operation_claim_exchanges/).sort()).toEqual([
      // Classement de l'export de recette : exportées tant qu'elles existent (absence tolérée après « Finaliser »).
      'src/services/admin/diagnostics-export/recette-catalog.ts',
      'src/services/business-operations/claims/legacy-cleanup.ts',
      'src/services/business-operations/claims/legacy-schema.ts',
    ]);
    expect(contenant(/parent_operation_id/).sort()).toEqual([
      'src/services/business-operations/asset-lifecycle.ts', 'src/services/business-operations/claims/legacy-cleanup.ts',
      'src/services/business-operations/claims/legacy-finalize.ts', 'src/services/business-operations/claims/legacy-schema.ts',
    ]);
    // Garde du transfert : conditionnée à la présence de la colonne (sonde sans cache), plus rien sur les actions de sinistre.
    const garde = sansCommentaires(lire('src/services/business-operations/asset-lifecycle.ts'));
    expect(garde).toMatch(/LEGACY_PARENT_COLUMN_PROBE_SQL[\s\S]*parentPresent \? await rows/);
    expect(garde).not.toMatch(/child_operation_id/);
    for (const f of ['src/services/security/cross-account/detection.ts', 'src/services/security/cross-account/remediation.ts',
      'src/services/security/cross-account/risk-catalog.ts']) {
      expect(sansCommentaires(lire(f)), f).not.toMatch(/CLAIM_ACTION_REF|CLAIM_EXCHANGE_DOCUMENT/);
    }
    expect(lire('docs/exploitation/relations-intercomptes.sql')).not.toMatch(/claim_actions|claim_exchanges/);
  });
});

describe('L84A-U07 — motif « nettoyage incomplet »', () => {
  it('détail par catégorie et comptes, consigne', async () => {
    const { cleanupIncompleteMessage } = await import('../legacy-finalize');
    const m = cleanupIncompleteMessage({ ACTIONS: 2, EXCHANGES: 0, CHILDREN: 1, LEGACY_FORM: 0, MIGRATION_MARKS: 0, CARDS: 0 }, [4, 9]);
    expect(m).toMatch(/^Nettoyage incomplet : 3 élément\(s\) de l’ancien modèle subsistent sur 2 compte\(s\) \(Actions de sinistre \(ancien modèle\) : 2 ; Interventions/);
    expect(m).toMatch(/SANS limiter à un compte/);
  });
});

describe('L84A-U08 — routes « events » historiques (E25), achevé au lot 85D', () => {
  it('routes et composant sans appelant retirés ; lot 85D : les dernières routes aussi, « Ajouter un document » passe par l’Agenda', async () => {
    for (const f of ['src/app/api/events/[eventId]/route.ts', 'src/app/api/events/[eventId]/suggestions/route.ts', 'src/app/api/events/agenda/route.ts',
      'src/app/api/events/prochaines-echeances/route.ts', 'src/components/documents/linked-events-section.tsx',
      // Lot 85D : GET / POST /api/events, POST /api/events/[eventId]/documents, /api/documents/[id]/events.
      'src/app/api/events/route.ts', 'src/app/api/events/[eventId]/documents/route.ts', 'src/app/api/documents/[id]/events/route.ts']) expect(existsSync(join(ROOT, f)), f).toBe(false);
    const PROD = sources();
    expect(PROD.filter((f) => /linked-events-section|LinkedEventsSection/.test(lire(f)))).toEqual([]);
    const dialogue = lire('src/components/documents/unified-document-dialog.tsx');
    expect(dialogue).not.toMatch(/\/api\/events/);
    expect(dialogue).toMatch(/linkUploadedDocumentsToAgendaItem\(/);
    // Aucun appel restant vers une route « events » (composants, pages).
    for (const f of PROD.filter((x) => x.startsWith('src/components/') || x.startsWith('src/app/') && !x.startsWith('src/app/api/'))) {
      expect(lire(f), f).not.toMatch(/\/api\/events\b|\/api\/documents\/[^'"`\s]*\/events\b/);
    }
  });
});
