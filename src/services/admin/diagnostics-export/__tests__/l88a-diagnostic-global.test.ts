/**
 * Lot 88A — diagnostic global exhaustif et auto-suffisant (ticket P1) :
 * module pur et RÈGLES DE NON-RÉGRESSION.
 *
 *   · L88A-U01 couverture : chaque table du schéma Drizzle est déclarée au
 *     registre du diagnostic (section, ou exclusion motivée) — une table
 *     ajoutée sans déclaration fait ÉCHOUER ce test ; filtre par défaut
 *     (`account_id`) réellement porté par la table ;
 *   · L88A-U02 traitements IA : chaque opération de `AI_OPERATIONS` est
 *     déclarée (où lire entrée, sortie, décisions), tables citées couvertes ;
 *   · L88A-U03 références logiques et compteurs annoncés : tables et colonnes
 *     déclarées existantes (schéma Drizzle) ;
 *   · L88A-U04 sécurité : liste d'exclusion centralisée (mots de passe, hash,
 *     jetons, sessions, clés, secrets, stockage), compteurs non confondus,
 *     contenus restreints (longueur + SHA-256), e-mails pseudonymisés ;
 *   · L88A-U05 manifeste par section : COMPLETE / PARTIAL / NOT_APPLICABLE /
 *     ERROR — jamais COMPLETE avec un fichier partiel, une troncature
 *     déclarée ou un manque constaté ; statut global ;
 *   · L88A-U06 aucune troncature silencieuse dans les requêtes du diagnostic ;
 *   · L88A-U07 table de correspondance API → écran synchronisée avec l'écran
 *     et l'API (même fonction `buildSections`), verdicts donnée / backend /
 *     affichage ;
 *   · L88A-U08 guide d'analyse (chaîne, cas du prix d'achat comme cas
 *     général, sécurité) ; périmètre « account » accepté.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '@/db/schema';
import { AI_OPERATIONS } from '@/services/ai/registry/operations';
import {
  DIAG_AI_OPERATION_COVERAGE, DIAG_ANNOUNCED_COUNTS, DIAG_LOGICAL_REFERENCES, DIAG_SECTIONS, DIAG_TABLE_COVERAGE, DIAG_TABLE_EXCLUSIONS,
  accountPredicate, classifyDiagTables, coverageFilter, isExternalReferenceColumn,
} from '../coverage';
import { DIAG_SECURITY_NOTES, excludedColumnMotif, isRestrictedContentColumn } from '../security';
import { buildAnalysisGuide, computeSectionManifests, globalWithSections, maskDiagRow, sectionOfPath } from '../account-model';
import { parseDiagRequest, type DiagFileInfo } from '../model';
import { refMatch, runtimeFlags, tableSql } from '../engine';
import { canonical, filteredIncludedInGlobal } from '../inclusion';
import { apiUiMatch, propertyVerdict } from '../properties';
import {
  DETAILS_UI_COMMON_FIELDS, DETAILS_UI_FAMILY_SECTIONS, DETAILS_UI_SECTION_FIELDS, DETAILS_UI_SECTION_LABELS, detailsUiFieldFor,
} from '@/lib/assets/details-ui-map';
import { getCommonFields, sectionFieldDefs, SECTION_LABELS, FAMILY_SECTIONS } from '@/components/assets/AssetDetailsTab';
import { buildSections } from '@/services/assets/details-sections';

const ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const lire = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const drizzleTables = (): Map<string, Set<string>> => {
  const out = new Map<string, Set<string>>();
  for (const v of Object.values(schema)) {
    if (!is(v, PgTable)) continue;
    const t = v as PgTable;
    out.set(getTableName(t), new Set(Object.values(getTableColumns(t)).map((c) => c.name)));
  }
  return out;
};

describe('L88A-U01 couverture des tables (règle de non-régression)', () => {
  const tables = drizzleTables();
  it('chaque table du schéma Drizzle est couverte (section) ou exclue avec motif', () => {
    expect(tables.size).toBeGreaterThan(150);
    const nonDeclarees = [...tables.keys()].filter((t) => !DIAG_TABLE_COVERAGE[t] && !DIAG_TABLE_EXCLUSIONS[t]);
    expect(nonDeclarees, 'tables à déclarer dans src/services/admin/diagnostics-export/coverage.ts (section ou exclusion motivée)').toEqual([]);
  });
  it('aucune table à la fois couverte et exclue ; sections connues ; motifs non vides', () => {
    for (const t of Object.keys(DIAG_TABLE_COVERAGE)) {
      expect(DIAG_TABLE_EXCLUSIONS[t], t).toBeUndefined();
      expect(DIAG_SECTIONS[DIAG_TABLE_COVERAGE[t].section], t).toBeDefined();
    }
    for (const [t, x] of Object.entries(DIAG_TABLE_EXCLUSIONS)) expect(x.motif.length, t).toBeGreaterThan(5);
  });
  it('filtre par défaut : la table porte réellement account_id ; filtre explicite : référence le compte {{A}}', () => {
    for (const [t, c] of Object.entries(DIAG_TABLE_COVERAGE)) {
      const cols = tables.get(t);
      if (!c.filter) { if (cols) expect(cols.has('account_id'), `${t} : account_id absent, filtre explicite requis`).toBe(true); continue; }
      if (!c.global && !c.transversal) expect(c.filter, t).toContain('{{A}}');
    }
    expect(coverageFilter({ section: 'etat-metier' })).toBe('t.account_id = {{A}}');
  });
  it('une nouvelle table non déclarée est signalée (jamais ignorée en silence)', () => {
    const c = classifyDiagTables(['assets', 'revoked_tokens', 'nouvelle_table_l88a']);
    expect(c.unclassified).toEqual(['nouvelle_table_l88a']);
    expect(c.covered.map((x) => x.table)).toEqual(['assets']);
    expect(c.excluded.map((x) => x.table)).toEqual(['revoked_tokens']);
    expect(c.missing).toContain('field_evidence');
  });
  it('les tables de secrets et de sessions sont exclues pour SÉCURITÉ', () => {
    for (const t of ['revoked_tokens', 'user_session_revocations', 'auth_rate_limits', 'idempotency_keys', 'ai_provider_credential', 'withdrawal_verification_tokens', 'push_subscriptions']) {
      expect(DIAG_TABLE_EXCLUSIONS[t]?.category, t).toBe('SECURITE');
    }
  });
  it('requête d’export : colonnes listées, filtre, tri (compte puis clé primaire)', () => {
    expect(tableSql('field_evidence', { columns: ['id', 'value_json'], pk: ['id'], excluded: [] }, 't.account_id = {{A}}'))
      .toBe('SELECT t."id", t."value_json" FROM "field_evidence" t WHERE (t.account_id = {{A}}) ORDER BY t."id"');
    expect(tableSql('field_evidence', { columns: ['id'], pk: ['id'], excluded: [] }, 'TRUE', ['t."account_id"']))
      .toBe('SELECT t."id" FROM "field_evidence" t WHERE (TRUE) ORDER BY t."account_id", t."id"');
  });
  it('L91A : seules la SÉCURITÉ et le CONTENU PERSONNEL justifient une exclusion ; tables transversales exportées au global', () => {
    expect(new Set(Object.values(DIAG_TABLE_EXCLUSIONS).map((x) => x.category))).toEqual(new Set(['SECURITE', 'CONTENU_PERSONNEL']));
    for (const t of ['admin_audit_log', 'ai_model_catalog', 'ai_config_imports', 'email_logs', 'plan_limits', 'stripe_webhook_logs', 'ops_backfill_runs']) {
      expect(DIAG_TABLE_COVERAGE[t]?.transversal, t).toBeTruthy();
      expect(DIAG_TABLE_EXCLUSIONS[t], t).toBeUndefined();
    }
  });
});

describe('L88A-U02 traitements IA connus', () => {
  it('chaque opération IA est déclarée au diagnostic, et réciproquement', () => {
    expect(Object.keys(AI_OPERATIONS).filter((k) => !DIAG_AI_OPERATION_COVERAGE[k]), 'opérations IA à déclarer (DIAG_AI_OPERATION_COVERAGE)').toEqual([]);
    expect(Object.keys(DIAG_AI_OPERATION_COVERAGE).filter((k) => !AI_OPERATIONS[k])).toEqual([]);
  });
  it('les tables où lire entrée, sortie et décisions sont couvertes (exportées)', () => {
    for (const [op, c] of Object.entries(DIAG_AI_OPERATION_COVERAGE)) {
      expect(c.tables.length, op).toBeGreaterThan(0);
      for (const t of c.tables) expect(DIAG_TABLE_COVERAGE[t], `${op} → ${t}`).toBeDefined();
    }
  });
});

describe('L88A-U03 références logiques et compteurs annoncés', () => {
  const tables = drizzleTables();
  // Colonnes ajoutées par migration SQL sans déclaration Drizzle : recherchées dans les migrations.
  const migrations = readdirSync(resolve(ROOT, 'src/db/migrations')).filter((f) => f.endsWith('.sql')).map((f) => lire(`src/db/migrations/${f}`)).join('\n');
  const hasColumn = (cols: Set<string> | undefined, c: string) => !cols || cols.has(c) || new RegExp(`\\b${c}\\b`).test(migrations);
  it('tables déclarées (couvertes ou exclues) ; colonnes existantes quand la table est au schéma Drizzle', () => {
    for (const r of DIAG_LOGICAL_REFERENCES) {
      expect(DIAG_TABLE_COVERAGE[r.from], `${r.from} (source)`).toBeDefined();
      expect(DIAG_TABLE_COVERAGE[r.to] ?? DIAG_TABLE_EXCLUSIONS[r.to], `${r.to} (cible)`).toBeDefined();
      expect(hasColumn(tables.get(r.from), r.column), `${r.from}.${r.column}`).toBe(true);
      expect(hasColumn(tables.get(r.to), r.toColumn ?? 'id'), `${r.to}.${r.toColumn ?? 'id'}`).toBe(true);
    }
  });
  it('chaîne propriété → décision → preuve → document → traitement déclarée', () => {
    const has = (from: string, column: string, to: string) => DIAG_LOGICAL_REFERENCES.some((r) => r.from === from && r.column === column && r.to === to);
    expect(has('reconciliation_decisions', 'evidence_ids', 'field_evidence')).toBe(true);
    expect(has('inconsistency_registry', 'proposed_evidence_ids', 'field_evidence')).toBe(true);
    expect(has('field_evidence', 'source_id', 'asset_files')).toBe(true);
    expect(has('document_facts', 'extraction_id', 'document_extractions')).toBe(true);
    expect(has('ai_execution_reports', 'job_id', 'ai_job_queue')).toBe(true);
  });
  it('compteurs annoncés : identifiants uniques, compte {{A}}, colonnes id / annonce / present', () => {
    expect(new Set(DIAG_ANNOUNCED_COUNTS.map((c) => c.code)).size).toBe(DIAG_ANNOUNCED_COUNTS.length);
    for (const c of DIAG_ANNOUNCED_COUNTS) {
      expect(c.sql, c.code).toContain('{{A}}');
      expect(c.sql, c.code).toMatch(/AS annonce/);
      expect(c.sql, c.code).toMatch(/AS present/);
    }
    expect(DIAG_ANNOUNCED_COUNTS.find((c) => c.code === 'T1_FACTS_PERSISTED')?.strict).toBe(true);
  });
  it('références hors compte attendues : déclarées explicitement', () => {
    expect(isExternalReferenceColumn('asset_move_requests', 'copied_asset_id')).toMatch(/compte cible/);
    expect(isExternalReferenceColumn('cross_account_remediations', 'n_importe')).toMatch(/isolation/);
    expect(isExternalReferenceColumn('field_evidence', 'source_id')).toBeNull();
    expect(DIAG_TABLE_COVERAGE.users.externalRefs).toBeTruthy();
  });
});

describe('L88A-U04 sécurité : liste d’exclusion centralisée', () => {
  it('mots de passe, hash, jetons, sessions, clés, secrets, webhooks, stockage : jamais sélectionnés', () => {
    for (const [t, c] of [['users', 'password_hash'], ['accounts', 'calendar_share_token'], ['revoked_tokens', 'token_hash'], ['x', 'token'], ['x', 'access_token'],
      ['x', 'refresh_token'], ['accounts', 'checkout_session_id'], ['x', 'session_id'], ['ai_provider_credential', 'secret'], ['x', 'webhook_secret'],
      ['x', 'api_key'], ['x', 'private_key'], ['x', 'key_hash'], ['x', 'credentials'], ['export_generation', 'file_key'], ['x', 's3_key'], ['x', 'storage_path'],
      ['x', 'authorization'], ['x', 'cookie']]) {
      expect(excludedColumnMotif(t, c), `${t}.${c}`).not.toBeNull();
    }
  });
  it('compteurs et clés métier ne sont pas des secrets', () => {
    for (const c of ['input_tokens', 'output_tokens', 'max_output_tokens', 'total_input_tokens', 'dedupe_key', 'candidate_key', 'cache_key', 'signature', 'evaluation_signature', 'stripe_customer_id', 'field_key']) {
      expect(excludedColumnMotif('x', c), c).toBeNull();
    }
  });
  it('isolation : colonnes multi-comptes omises dans les diagnostics FILTRÉS seulement ; textes de prompt remplacés par l’empreinte partout', () => {
    expect(excludedColumnMotif('coherence_campaigns', 'scope_account_ids')?.motif).toMatch(/isolation/);
    expect(excludedColumnMotif('coherence_campaigns', 'error_sample')?.motif).toMatch(/isolation/);
    expect(excludedColumnMotif('coherence_campaigns', 'scope_account_ids', { global: true })).toBeNull();
    expect(excludedColumnMotif('ai_master_prompt_versions', 'content', { global: true })?.motif).toMatch(/empreinte/);
    expect(excludedColumnMotif('promo_codes', 'code', { global: true })?.motif).toMatch(/utilisable/);
    expect(excludedColumnMotif('ai_model_qualification', 'key_fingerprint', { global: true })).not.toBeNull();
    expect(excludedColumnMotif('legal_document_versions', 'html_storage_key', { global: true })).not.toBeNull();
    expect(isRestrictedContentColumn('content', 'ai_config_exports')).toBe(true);
    expect(isRestrictedContentColumn('payload', 'stripe_webhook_logs')).toBe(true);
    expect(isRestrictedContentColumn('content')).toBe(false);
    expect(excludedColumnMotif('ai_master_prompt_versions', 'content')?.motif).toMatch(/empreinte/);
    expect(excludedColumnMotif('ai_master_prompt_versions', 'content_sha256')).toBeNull();
  });
  it('ligne masquée : contenu restreint (longueur + SHA-256), compteurs conservés, e-mail pseudonymisé, IBAN masqué', () => {
    const r = maskDiagRow({ id: 7, prompt_text: 'Analyse le document de M. Dupont', response_raw: '{"total": 1}', full_text: 'TEXTE INTÉGRAL',
      input_tokens: 1200, output_tokens: '300', email: 'jean.dupont@example.fr', notes: 'IBAN FR76 3000 6000 0112 3456 7890 189 — contact jean.dupont@example.fr', amount_cents: 49000000 });
    expect(r.id).toBe(7);
    expect(r.prompt_text).toMatchObject({ $etat: 'masque', longueur: 32 });
    expect((r.prompt_text as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.response_raw).toMatchObject({ $etat: 'masque' });
    expect(r.full_text).toMatchObject({ $etat: 'masque', longueur: 14 });
    expect(r.input_tokens).toBe(1200);
    expect(r.output_tokens).toBe('300');
    expect(r.email).toMatchObject({ $etat: 'masque', motif: 'e-mail' });
    expect(JSON.stringify(r)).not.toMatch(/jean\.dupont@example\.fr|FR76 3000/);
    expect(r.amount_cents).toBe(49000000);
    expect(isRestrictedContentColumn('parsed_output')).toBe(true);
    expect(isRestrictedContentColumn('evidence_excerpt')).toBe(false);
  });
  it('L91A : JSON stocké en TEXTE (fiche du bien) masqué comme un objet, type conservé', () => {
    const r = maskDiagRow({ id: 1, key_characteristics: '{"address1":"12 rue des Lilas","acquisitionDate":"2021-09-14","contact":"jean@example.fr"}' }, { isSensitiveKey: (k) => k === 'address1' });
    expect(typeof r.key_characteristics).toBe('string');
    expect(String(r.key_characteristics)).not.toMatch(/Lilas|jean@example\.fr/);
    expect(JSON.parse(String(r.key_characteristics)).acquisitionDate).toBe('2021-09-14');
  });
  it('clé canonique sensible : valeurs de la ligne masquées', () => {
    const r = maskDiagRow({ id: 1, field_key: 'address1', value_json: '"12 rue des Lilas"', normalized_value: '12 rue des lilas' }, { isSensitiveKey: (k) => k === 'address1' });
    expect(JSON.stringify(r)).not.toMatch(/Lilas/i);
  });
  it('variables de fonctionnement : jamais un nom de secret ni une URL', () => {
    const f = runtimeFlags({ FEATURE_X_ENABLED: 'true', AI_PROVIDER_API_KEY: 'sk-secret', COHERENCE_T1_RELAUNCH_DAILY_MAX: '50', DATABASE_URL: 'postgres://u:p@h/db', T3_MODE: 'https://evil', NODE_ENV: 'production', STRIPE_WEBHOOK_SECRET: 'whsec_x' });
    expect(f).toEqual([
      { nom: 'COHERENCE_T1_RELAUNCH_DAILY_MAX', valeur: '50' },
      { nom: 'FEATURE_X_ENABLED', valeur: 'true' },
      { nom: 'NODE_ENV', valeur: 'production' },
      { nom: 'T3_MODE', valeur: '(présente — valeur non exportée)' },
    ]);
  });
  it('notes de sécurité du manifeste : exclusions déclarées', () => {
    expect(DIAG_SECURITY_NOTES.join(' ')).toMatch(/MOT_DE_PASSE.*JETON.*SESSION.*SECRET.*CLE/);
  });
});

describe('L88A-U05 manifeste par section', () => {
  const f = (path: string, status: DiagFileInfo['status'], expected: number | null = 2, count = 2, error: string | null = null): DiagFileInfo =>
    ({ path, description: '', status, expected, count, complete: status === 'COMPLETE', error, bytes: 10, sha256: 'a'.repeat(64) });
  const base = { fileSections: new Map(), issues: new Map(), notApplicableMotif: () => 'hors périmètre' };
  it('tous les fichiers complets → COMPLETE ; aucune donnée → NOT_APPLICABLE avec motif', () => {
    const s = computeSectionManifests({ ...base, files: [f('donnees/preuves/field_evidence.json', 'COMPLETE')] });
    expect(s.find((x) => x.code === 'preuves')).toMatchObject({ status: 'COMPLETE', expected: 2, exported: 2 });
    expect(s.find((x) => x.code === 'candidats')).toMatchObject({ status: 'NOT_APPLICABLE', motif: 'hors périmètre' });
    expect(s.find((x) => x.code === 'non-classees')).toBeUndefined();
    expect(globalWithSections('COMPLETE', s)).toBe('COMPLETE');
  });
  it('fichier partiel → PARTIAL ; fichier en échec → ERROR ; statut global jamais COMPLETE', () => {
    const s = computeSectionManifests({ ...base, files: [f('donnees/preuves/field_evidence.json', 'PARTIAL', 3, 2), f('donnees/candidats/document_operation_candidates.json', 'FAILED', null, 0, 'boom')] });
    expect(s.find((x) => x.code === 'preuves')?.status).toBe('PARTIAL');
    expect(s.find((x) => x.code === 'candidats')).toMatchObject({ status: 'ERROR', errors: ['donnees/candidats/document_operation_candidates.json : boom'] });
    expect(globalWithSections('COMPLETE', s)).toBe('PARTIAL');
  });
  it('manque constaté par l’auto-contrôle ou troncature déclarée → PARTIAL même si les fichiers sont complets', () => {
    const files = [f('donnees/conflits-arbitrages/reconciliation_decisions.json', 'COMPLETE'), f('ia/sorties-modele.json', 'COMPLETE')];
    const s = computeSectionManifests({ ...base, files, issues: new Map([['conflits-arbitrages', ['2 référence(s) absente(s)']]]), truncations: new Map([['extractions-ia', ['10 traces sur 12']]]) });
    expect(s.find((x) => x.code === 'conflits-arbitrages')).toMatchObject({ status: 'PARTIAL', errors: ['2 référence(s) absente(s)'] });
    expect(s.find((x) => x.code === 'extractions-ia')).toMatchObject({ status: 'PARTIAL', truncations: ['10 traces sur 12'] });
  });
  it('section des fichiers historiques', () => {
    expect(sectionOfPath('ia/appels.json')).toBe('technique');
    expect(sectionOfPath('ia/extractions.json')).toBe('extractions-ia');
    expect(sectionOfPath('tracabilite/identite-economique.json')).toBe('conflits-arbitrages');
    expect(sectionOfPath('metier/bien-12.json')).toBe('etat-metier');
    expect(sectionOfPath('donnees/fermeture/coherence_campaigns.json')).toBe('controle');
    expect(sectionOfPath('donnees/ecritures/canonical_field_writes.json')).toBe('ecritures');
  });
  it('L91A : « Ensemble de l’application » — une section sans fichier est une ERREUR, jamais NOT_APPLICABLE', () => {
    const s = computeSectionManifests({ ...base, global: true, files: [f('donnees/preuves/field_evidence.json', 'COMPLETE')] });
    expect(s.find((x) => x.code === 'candidats')).toMatchObject({ status: 'ERROR' });
    expect(s.find((x) => x.code === 'candidats')!.motif).toMatch(/Ensemble de l’application/);
    expect(s.some((x) => x.status === 'NOT_APPLICABLE')).toBe(false);
    expect(globalWithSections('COMPLETE', s)).toBe('PARTIAL');
  });
});

describe('L88A-U06 aucune troncature silencieuse', () => {
  it('requêtes du diagnostic : plus de coupure left() ; LIMIT réservé à la pagination en parties et à une sélection déclarée', () => {
    for (const p of ['src/services/admin/diagnostics-export/collect.ts', 'src/services/admin/diagnostics-export/trace.ts', 'src/services/admin/diagnostics-export/engine.ts', 'src/services/admin/diagnostics-export/properties.ts']) {
      const src = lire(p);
      expect(src, p).not.toMatch(/\bleft\(/);
      const limits = [...src.matchAll(/LIMIT [^`\n]*/g)].map((m) => m[0]);
      // Sélections (pas des troncatures), déclarées dans le manifeste : dernier motif de retrait d'une source ;
      // candidat rattaché à un montant tracé (trace.ts) — toutes les lignes restent exportées par ailleurs.
      for (const l of limits) expect(l, `${p} : ${l}`).toMatch(p.endsWith('trace.ts') ? /^LIMIT 1$/ : /^LIMIT \$\{partRows\} OFFSET|^LIMIT 1\) AS motif_retrait/);
    }
    const collect = lire('src/services/admin/diagnostics-export/collect.ts');
    expect(collect).toMatch(/motif_retrait : DERNIER motif de retrait/);
    expect(collect).toMatch(/candidat retenu pour un montant/);
  });
  it('L91A : jamais « n sur ? » (un attendu non calculé est une erreur du fichier)', () => {
    for (const p of ['collect.ts', 'engine.ts', 'model.ts']) expect(lire(`src/services/admin/diagnostics-export/${p}`), p).not.toMatch(/\?\? '\?'|sur \$\{[^}]*\?\? '\?'/);
  });
});

describe('L88A-U07 API → écran : correspondance maintenue et synchronisée', () => {
  it('la table de correspondance reflète exactement les définitions de l’écran', () => {
    for (const fam of ['IMMOBILIER', 'VEHICULE', 'OBJET'] as const) {
      expect(getCommonFields(fam).map((x) => [x.key, x.label]), fam).toEqual(DETAILS_UI_COMMON_FIELDS[fam].map((x) => [x.key, x.label]));
    }
    for (const s of Object.keys(SECTION_LABELS).filter((x) => x !== 'common')) {
      expect(sectionFieldDefs(s).map((x) => [x.key, x.label]), s).toEqual((DETAILS_UI_SECTION_FIELDS[s] ?? []).map((x) => [x.key, x.label]));
    }
    expect(DETAILS_UI_SECTION_LABELS).toEqual(SECTION_LABELS);
    expect(DETAILS_UI_FAMILY_SECTIONS).toEqual(FAMILY_SECTIONS);
  });
  it('chaque section renvoyée par l’API (même fonction que la route) a un libellé d’écran', () => {
    const row = { name: 'Maison', purchasePriceCents: 3_500_000, notes: null };
    for (const fam of ['IMMOBILIER', 'VEHICULE', 'OBJET']) {
      const sections = buildSections(fam, { acquisitionPrice: 350000 }, row) as Record<string, Record<string, unknown>>;
      for (const s of Object.keys(sections)) expect(DETAILS_UI_SECTION_LABELS[s], `${fam} › ${s}`).toBeDefined();
      expect(sections.common.acquisitionPrice).toBe(350000);
    }
    // Colonne de repli (prix en centimes) quand la fiche est vide : valeur renvoyée par l'API.
    expect((buildSections('IMMOBILIER', {}, row) as Record<string, Record<string, unknown>>).common.acquisitionPrice).toBe(35000);
  });
  it('un champ lu par l’écran dans une section qui ne le reçoit pas est détecté', () => {
    // Lot 89B : l'écart réel (`estimatedValue` renvoyé dans « common », lu dans « Valorisation ») est corrigé
    // à la source (`buildSections`) ; la détection reste vérifiée sur une réponse simulée présentant l'écart.
    const sections = buildSections('IMMOBILIER', { estimatedValue: 400000 }, { name: 'Maison' }) as Record<string, Record<string, unknown>>;
    expect(sections.valuation.estimatedValue).toBe(400000);
    expect('estimatedValue' in sections.common).toBe(false);
    expect(detailsUiFieldFor('IMMOBILIER', 'common', 'estimatedValue')).toBeNull();
    expect(detailsUiFieldFor('IMMOBILIER', 'valuation', 'estimatedValue')).toMatchObject({ sectionLabel: 'Valorisation' });
    const { valuation: { estimatedValue, ...valuation }, ...autres } = sections;
    const simule = { ...autres, common: { ...sections.common, estimatedValue }, valuation };
    const m = apiUiMatch(simule, 'IMMOBILIER', 'estimatedValue');
    expect(m).toMatchObject({ section: 'common', apiSent: true, uiExpects: true, uiConsumed: false });
    expect(propertyVerdict({ persisted: 400000, apiStatus: 200, apiSent: m.apiSent, apiValue: m.apiValue, uiExpects: m.uiExpects, uiConsumed: m.uiConsumed })).toBe('RENVOYE_NON_AFFICHE');
  });
  it('verdicts : donnée, backend, affichage', () => {
    const v = (o: Partial<Parameters<typeof propertyVerdict>[0]>) => propertyVerdict({ persisted: null, apiStatus: 200, apiSent: true, apiValue: null, uiExpects: true, uiConsumed: true, ...o });
    expect(v({})).toBe('VIDE_EN_BASE');
    expect(v({ persisted: 350000 })).toBe('PERSISTE_NON_RENVOYE');
    expect(v({ persisted: 350000, apiValue: 350000 })).toBe('COHERENT');
    expect(v({ persisted: 350000, apiValue: 350000, uiExpects: false, uiConsumed: false })).toBe('RENVOYE_NON_AFFICHE');
    expect(v({ apiSent: false })).toBe('ATTENDU_PAR_ECRAN_NON_RENVOYE');
    expect(v({ apiSent: false, uiExpects: false, uiConsumed: false, persisted: 'x' })).toBe('NON_EXPOSE_PAR_LA_FICHE');
    expect(v({ apiStatus: 403 })).toBe('API_INDISPONIBLE');
  });
});

describe('L88A-U08 guide d’analyse et filtres', () => {
  it('guide : complétude, chaîne complète, prix d’achat comme cas général, sécurité ; global = niveau maximal', () => {
    const g = buildAnalysisGuide({ scope: 'global', scopeLabel: 'Ensemble de l’application', target: 'Ensemble de l’application — 2 compte(s)', generatedAt: '2026-10-25T10:00:00.000Z', global: true,
      sections: [{ code: 'preuves', label: 'Preuves et provenance', status: 'COMPLETE', motif: null, files: 1 }] });
    expect(g).toMatch(/document → extraction → unité source → fait → preuve → candidat → décision → écriture → propriété → API → affichage/);
    expect(g).toMatch(/acquisitionPrice/);
    expect(g).toMatch(/même démarche pour tout champ/);
    expect(g).toMatch(/exclusionsVolontaires/);
    expect(g).toMatch(/niveau maximal/);
    expect(g).toMatch(/\| Preuves et provenance \(`preuves`\) \| COMPLETE \| 1 \|/);
    const f = buildAnalysisGuide({ scope: 'asset', scopeLabel: 'Filtre : bien', target: 'Bien #1', generatedAt: 'x', global: false, sections: [] });
    expect(f).toMatch(/Diagnostic \*\*filtré\*\*/);
    expect(f).toMatch(/AUCUNE information absente/);
    expect(f).not.toMatch(/diagnostic \*\*Compte\*\*/);
  });
  it('filtre « account » : identifiant obligatoire', () => {
    expect(parseDiagRequest(new URLSearchParams({ scope: 'account' }))).toMatchObject({ ok: false, code: 'INVALID_ID' });
    expect(parseDiagRequest(new URLSearchParams({ scope: 'account', id: '12', period: 'all' }))).toMatchObject({ ok: true, value: { scope: 'account', id: 12 } });
  });
  it('règle documentée dans l’exploitation', () => {
    const doc = lire('docs/exploitation/diagnostic-global.md');
    expect(doc).toMatch(/Règle de non-régression/);
    expect(doc).toMatch(/coverage\.ts/);
    expect(doc).toMatch(/inclusion\.ts/);
    expect(doc).toMatch(/test:e2e:diagnostic/);
  });
});

describe('L91A-U01 moteur unique : filtres purs', () => {
  it('filtre de comptes : `= {{A}}` → comptes retenus ; global → vrai', () => {
    const f = coverageFilter(DIAG_TABLE_COVERAGE.duo_memberships);
    expect(accountPredicate(f, 'param')).toBe('t.duo_id IN (SELECT d.id FROM duo_accounts d WHERE d.account_id = ANY({{accounts}}::int[]))');
    expect(accountPredicate(f, 'all')).toBe('t.duo_id IN (SELECT d.id FROM duo_accounts d WHERE TRUE)');
    expect(accountPredicate('t.account_id = {{A}}', 'param')).toBe('t.account_id = ANY({{accounts}}::int[])');
    for (const [t, c] of Object.entries(DIAG_TABLE_COVERAGE)) expect(accountPredicate(coverageFilter(c), 'param'), t).not.toContain('{{A}}');
    for (const c of DIAG_ANNOUNCED_COUNTS) {
      expect(accountPredicate(c.sql, 'all'), c.code).not.toContain('{{A}}');
      expect(DIAG_TABLE_COVERAGE[c.table], c.code).toBeDefined();
    }
  });
  it('filtre fin générique : la ligne désigne un objet du filtre (valeur, tableau JSON, tableau PostgreSQL, condition polymorphe)', () => {
    const mem = (v: string) => `${v} = ANY({{eFilesT}}::text[])`;
    expect(refMatch({ column: 'file_id', kind: 'value' }, mem)).toBe('(t."file_id"::text = ANY({{eFilesT}}::text[]))');
    expect(refMatch({ column: 'target_id', kind: 'value', when: "lower(t.target_type) = 'asset_file'" }, mem)).toBe("((lower(t.target_type) = 'asset_file') AND t.\"target_id\"::text = ANY({{eFilesT}}::text[]))");
    expect(refMatch({ column: 'evidence_ids', kind: 'json-array' }, mem)).toMatch(/^\(EXISTS \(SELECT 1 FROM jsonb_array_elements_text\(.*\) x\(v\) WHERE x\.v = ANY/);
    expect(refMatch({ column: 'source_unit_ids', kind: 'pg-array' }, mem)).toMatch(/unnest\(t\."source_unit_ids"\) x\(v\) WHERE x\.v::text = ANY/);
  });
});

describe('L91A-U02 règle automatique « filtré ⊆ global » (inclusion.ts)', () => {
  const cov = JSON.stringify({ couvertes: [{ table: 'assets', clePrimaire: ['id'] }, { table: 'notes_sans_cle', clePrimaire: [] }] });
  const global = {
    'manifeste.json': '{}', 'couverture/tables.json': cov,
    'donnees/etat-metier/assets.part-0001.json': JSON.stringify([{ id: 1, name: 'A', account_id: 1, iso: 'x' }]),
    'donnees/etat-metier/assets.part-0002.json': JSON.stringify([{ id: 2, name: 'B', account_id: 2, iso: 'y' }]),
    'donnees/etat-metier/notes_sans_cle.json': JSON.stringify([{ a: 1 }]),
    'tracabilite/proprietes.json': JSON.stringify([{ bien: 1, cible: 'ASSET#1', champ: 'x', verdict: 'COHERENT' }, { bien: 2, cible: 'ASSET#2', champ: 'x', verdict: 'VIDE_EN_BASE' }]),
  };
  it('inclusion respectée : lignes (colonne d’isolation omise), parties, fermeture, entrées de traçabilité', () => {
    const filtered = {
      'manifeste.json': '{}', 'couverture/tables.json': cov,
      'donnees/etat-metier/assets.json': JSON.stringify([{ id: 1, name: 'A', account_id: 1 }]),
      'donnees/fermeture/assets.json': JSON.stringify([{ id: 2, name: 'B', account_id: 2 }]),
      'donnees/etat-metier/notes_sans_cle.json': JSON.stringify([{ a: 1 }]),
      'tracabilite/proprietes.json': JSON.stringify([{ verdict: 'COHERENT', champ: 'x', cible: 'ASSET#1', bien: 1 }]),
    };
    expect(filteredIncludedInGlobal(filtered, global)).toEqual([]);
  });
  it('toute divergence est une violation : ligne absente ou différente, entrée différente, fichier inconnu', () => {
    const v = filteredIncludedInGlobal({
      'couverture/tables.json': cov, 'rapport.txt': 'x',
      'donnees/etat-metier/assets.json': JSON.stringify([{ id: 1, name: 'AUTRE' }, { id: 9, name: 'Z' }]),
      'donnees/etat-metier/notes_sans_cle.json': JSON.stringify([{ a: 2 }]),
      'tracabilite/proprietes.json': JSON.stringify([{ bien: 1, cible: 'ASSET#1', champ: 'x', verdict: 'VIDE_EN_BASE' }]),
      'metier/dossier-1.json': '{}',
    }, global).join('\n');
    expect(v).toMatch(/assets › id=1 : colonne name différente/);
    expect(v).toMatch(/assets › id=9 : ligne absente du global/);
    expect(v).toMatch(/notes_sans_cle › ligne : ligne \(sans clé primaire\) absente du global/);
    expect(v).toMatch(/proprietes\.json › 1\|ASSET#1\|x : entrée différente du global/);
    expect(v).toMatch(/rapport\.txt : absent du global/);
    expect(v).toMatch(/metier\/dossier-1\.json : fichier d’une famille inconnue/);
  });
  it('comparaison profonde canonique (ordre des clés indifférent)', () => {
    expect(canonical({ b: [1, { d: 2, c: 3 }], a: null })).toBe(canonical({ a: null, b: [1, { c: 3, d: 2 }] }));
  });
});

describe('L91A-U03 BO : un seul diagnostic, raccourci depuis « Données du compte »', () => {
  it('« Données du compte » : simple raccourci vers Supervision › Diagnostics avec le filtre compte prérempli', () => {
    const src = lire('src/app/admin/accounts/[id]/_components/account-data/AccountDataSection.tsx');
    expect(src).toMatch(/href=\{`\/admin\/diagnostics\?scope=account&id=\$\{accountId\}`\}/);
    expect(src).not.toMatch(/Diagnostic global</);
  });
  it('page Diagnostics : « Ensemble de l’application » par défaut, filtres, plus de période ni de traitements', () => {
    const page = lire('src/app/admin/diagnostics/page.tsx');
    expect(page).toMatch(/key: 'global', label: 'Ensemble de l’application/);
    expect(page).toMatch(/Filtre : un compte/);
    expect(page).not.toMatch(/diag-from|diag-to|TREATMENTS|allHistory/);
    // Desktop et mobile : grille responsive, boutons pleine largeur sur mobile.
    expect(page).toMatch(/grid-cols-1 sm:grid-cols-2/);
    expect(page).toMatch(/w-full sm:w-auto/);
  });
});
