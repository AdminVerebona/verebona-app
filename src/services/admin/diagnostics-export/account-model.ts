/**
 * Lots 88A, 91A — diagnostic : fonctions PURES (masquage d'une ligne,
 * statut par section du manifeste, guide d'analyse). Partagées par le
 * moteur unique (`collect.ts`, `engine.ts`) et les tests.
 */
import { createHash } from 'node:crypto';
import type { ExtractionStatus } from '@/services/admin/account-data/model';
import { exportMaskingRule, maskForExport, type DiagFileInfo } from './model';
import { DIAG_SECTIONS, DIAG_SECTION_ORDER, type DiagSectionCode, type DiagSectionStatus } from './coverage';
import { isRestrictedContentColumn } from './security';

type Row = Record<string, unknown>;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Compteurs (jetons consommés…) : jamais masqués — ce ne sont pas des secrets. */
const COUNTER_COLUMN = /(^|_)tokens$/i;

/**
 * Ligne d'une table du compte, masquée : contenu restreint → longueur et
 * SHA-256 ; compteurs conservés ; le reste par le masquage du diagnostic
 * (`maskForExport` : secrets, e-mails pseudonymisés, identité, adresse,
 * clés canoniques sensibles du registre). Les colonnes exclues par
 * `security.ts` ne sont jamais sélectionnées (absentes de `row`).
 */
export function maskDiagRow(row: Row, opts: { isSensitiveKey?: (k: string) => boolean; table?: string } = {}): Row {
  const kept: Row = {};
  const rest: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) { kept[k] = v ?? null; continue; }
    if (isRestrictedContentColumn(k, opts.table) || exportMaskingRule(k)?.content) {
      const text = typeof v === 'string' ? v : JSON.stringify(v);
      kept[k] = { $etat: 'masque', motif: 'contenu restreint (longueur et empreinte seules)', longueur: text.length, sha256: sha256(text) };
    } else if (COUNTER_COLUMN.test(k) && (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)))) {
      kept[k] = v;
    } else if (typeof v === 'string' && /^\s*[[{]/.test(v)) {
      // Lot 91A : JSON stocké en TEXTE (ex. `assets.key_characteristics`) — masqué comme un objet (clés sensibles du
      // registre, e-mails, secrets…), puis resérialisé : le type de la colonne est conservé.
      let parsed: unknown;
      try { parsed = JSON.parse(v); } catch { parsed = undefined; }
      if (parsed && typeof parsed === 'object') kept[k] = JSON.stringify(maskForExport(parsed, { isSensitiveKey: opts.isSensitiveKey }));
      else rest[k] = v;
    } else rest[k] = v;
  }
  const masked = maskForExport(rest, { isSensitiveKey: opts.isSensitiveKey }) as Row;
  const out: Row = {};
  for (const k of Object.keys(row)) out[k] = k in kept ? kept[k] : masked[k];
  return out;
}

/** Section d'un fichier de l'archive (repli : la section est normalement déclarée à la planification). */
export function sectionOfPath(path: string): DiagSectionCode {
  const m = /^donnees\/([a-z-]+)\//.exec(path);
  if (m && m[1] in DIAG_SECTIONS) return m[1] as DiagSectionCode;
  if (/^donnees\/fermeture\//.test(path) || /^controle\//.test(path) || /^couverture\//.test(path)) return 'controle';
  if (/^api-ui\//.test(path)) return 'api-ui';
  if (/^tracabilite\/identite-economique/.test(path)) return 'conflits-arbitrages';
  if (/^tracabilite\//.test(path)) return 'tracabilite';
  if (/^metier\//.test(path)) return 'etat-metier';
  if (/^logs\/historique-/.test(path)) return 'historique';
  if (/^ia\/rapports-execution-lignes/.test(path)) return 'ecritures';
  if (/^ia\/(appels|diagnostics-appels|captures-appels|operations-ia)/.test(path)) return 'technique';
  if (/^ia\//.test(path)) return 'extractions-ia';
  if (/^logs\//.test(path) || /^contexte-technique/.test(path) || /^technique\//.test(path)) return 'technique';
  return 'technique';
}

interface SectionFileRef {
  path: string;
  status: ExtractionStatus | undefined;
  expected: number | null | undefined;
  count: number | undefined;
  bytes: number | undefined;
  sha256: string | undefined;
  error: string | null | undefined;
}

export interface DiagSectionManifest {
  code: DiagSectionCode;
  label: string;
  status: DiagSectionStatus;
  /** Motif du statut (NOT_APPLICABLE, PARTIAL, ERROR). */
  motif: string | null;
  files: SectionFileRef[];
  /** Somme des attendus (compte SQL indépendant dans l'instantané) et des lignes écrites. */
  expected: number;
  exported: number;
  filters: string[];
  limitations: string[];
  truncations: string[];
  errors: string[];
}

interface SectionInputs {
  files: DiagFileInfo[];
  /** Section de chaque fichier (sinon `sectionOfPath`). */
  fileSections: ReadonlyMap<string, DiagSectionCode>;
  /** Manques constatés par l'auto-contrôle (références absentes, compteurs annoncés non détaillés…), par section. */
  issues: ReadonlyMap<DiagSectionCode, string[]>;
  /** Filtres, limitations et troncatures déclarés par section. */
  filters?: ReadonlyMap<DiagSectionCode, string[]>;
  limitations?: ReadonlyMap<DiagSectionCode, string[]>;
  truncations?: ReadonlyMap<DiagSectionCode, string[]>;
  /** Motif d'une section non produite pour ce périmètre (diagnostic FILTRÉ seulement). */
  notApplicableMotif: (code: DiagSectionCode) => string;
  /**
   * Lot 91A — « Ensemble de l'application » : AUCUNE section ne peut être
   * NOT_APPLICABLE (toute donnée de Verebona y est applicable) ; une section
   * sans fichier y est une anomalie du diagnostic → ERROR.
   */
  global?: boolean;
}

/**
 * Manifeste par section : COMPLETE seulement si chaque fichier l'est
 * (exporté = attendu, aucune erreur), sans troncature ni manque constaté ;
 * ERROR si un fichier a échoué ; PARTIAL si un fichier est partiel, tronqué,
 * ou si l'auto-contrôle a constaté un manque ; NOT_APPLICABLE si la section
 * n'a aucun fichier pour ce périmètre.
 */
export function computeSectionManifests(i: SectionInputs): DiagSectionManifest[] {
  const by = new Map<DiagSectionCode, DiagFileInfo[]>();
  for (const f of i.files) {
    const code = i.fileSections.get(f.path) ?? sectionOfPath(f.path);
    if (!by.has(code)) by.set(code, []);
    by.get(code)!.push(f);
  }
  const out: DiagSectionManifest[] = [];
  for (const code of DIAG_SECTION_ORDER) {
    const files = by.get(code) ?? [];
    const issues = i.issues.get(code) ?? [];
    const truncations = i.truncations?.get(code) ?? [];
    const errors = files.filter((f) => f.error).map((f) => `${f.path} : ${f.error}`);
    if (code === 'non-classees' && !files.length && !issues.length) continue;
    let status: DiagSectionStatus;
    let motif: string | null = null;
    if (!files.length && !issues.length && i.global) {
      status = 'ERROR';
      motif = 'section applicable sans aucun fichier dans « Ensemble de l’application » : anomalie du diagnostic (registre de couverture)';
    } else if (!files.length && !issues.length) {
      status = 'NOT_APPLICABLE';
      motif = i.notApplicableMotif(code);
    } else if (files.some((f) => f.status === 'FAILED')) {
      status = 'ERROR';
      motif = `${files.filter((f) => f.status === 'FAILED').length} fichier(s) en échec`;
    } else if (files.some((f) => f.status === 'PARTIAL') || issues.length || truncations.length) {
      status = 'PARTIAL';
      const parts: string[] = [];
      const partial = files.filter((f) => f.status === 'PARTIAL').length;
      if (partial) parts.push(`${partial} fichier(s) partiel(s)`);
      if (issues.length) parts.push(`${issues.length} manque(s) constaté(s) par l’auto-contrôle`);
      if (truncations.length) parts.push(`${truncations.length} troncature(s) déclarée(s)`);
      motif = parts.join(' ; ');
    } else status = 'COMPLETE';
    out.push({
      code, label: DIAG_SECTIONS[code].label, status, motif,
      files: files.map((f) => ({ path: f.path, status: f.status, expected: f.expected, count: f.count, bytes: f.bytes, sha256: f.sha256, error: f.error })),
      expected: files.reduce((n, f) => n + (f.expected ?? 0), 0),
      exported: files.reduce((n, f) => n + (f.expected !== undefined && f.expected !== null ? (f.count ?? 0) : 0), 0),
      filters: i.filters?.get(code) ?? [], limitations: i.limitations?.get(code) ?? [], truncations, errors: [...errors, ...issues, ...(status === 'ERROR' && !files.length && motif ? [motif] : [])],
    });
  }
  return out;
}

/** Statut global : jamais COMPLETE si une section est PARTIAL ou en ERROR. */
export function globalWithSections(base: ExtractionStatus, sections: readonly DiagSectionManifest[]): ExtractionStatus {
  if (base !== 'COMPLETE') return base;
  return sections.some((s) => s.status === 'PARTIAL' || s.status === 'ERROR') ? 'PARTIAL' : 'COMPLETE';
}

// ── Guide d'analyse (LISEZMOI-ANALYSE.md) ───────────────────────────────────

interface GuideInputs {
  scope: string;
  scopeLabel: string;
  target: string;
  generatedAt: string;
  sections: ReadonlyArray<{ code: DiagSectionCode; label: string; status: DiagSectionStatus; motif: string | null; files: number }>;
  /** Lot 91A : vrai pour « Ensemble de l'application » (niveau maximal). */
  global: boolean;
}

/** Guide d'analyse joint à l'archive : comment reconstruire une chaîne à partir du seul ZIP. */
export function buildAnalysisGuide(g: GuideInputs): string {
  const L: string[] = [];
  L.push('# Verebona — guide d’analyse du diagnostic', '');
  L.push(`Périmètre : **${g.scopeLabel}** — ${g.target}. Généré le ${g.generatedAt} (UTC).`, '');
  L.push('Ce guide explique comment répondre à « pourquoi Verebona affiche (ou n’affiche pas) cette valeur ? » à partir du SEUL contenu de cette archive, sans accès à la base ni export complémentaire.', '');
  if (g.global) {
    L.push('> **Ensemble de l’application** est le niveau maximal : toutes les données fonctionnelles de TOUS les comptes, toutes les données techniques et transversales (journaux, configuration IA par empreinte, référentiels, catalogue). Aucun autre diagnostic ni export n’est nécessaire.', '');
  } else {
    L.push('> Diagnostic **filtré** : même moteur que « Ensemble de l’application », volume réduit. Il ne contient AUCUNE information absente du diagnostic « Ensemble de l’application » (règle vérifiée automatiquement). Les tables transversales (multi-comptes) n’y figurent pas : voir `couverture/tables.json` › `horsFiltre`.', '');
  }
  L.push('## 1. Vérifier d’abord la complétude', '');
  L.push('- `manifeste.json` › `status` : COMPLETE seulement si chaque section est complète, chaque table couverte ou exclue avec motif, chaque compte couvert, attendus = exportés, références résolues et compteurs annoncés détaillés. Ne concluez jamais sur une section PARTIAL ou ERROR sans lire son `motif` et ses `errors`.');
  L.push('- `manifeste.json` › `sections[]` : statut par section (COMPLETE / PARTIAL / NOT_APPLICABLE / ERROR), fichiers, attendus (compte SQL indépendant, même instantané) vs exportés, filtres, limitations, troncatures, erreurs, SHA-256. Au global, NOT_APPLICABLE est interdit.');
  L.push('- `manifeste.json` › `autoControle` : références résolues / ajoutées par fermeture / absentes, compteurs annoncés vs lignes détaillées, comptes couverts (`controle/*.json` pour le détail de chaque manque).');
  L.push('- `manifeste.json` › `exclusionsVolontaires` : ce qui n’est PAS dans l’archive, et pourquoi (secrets, sessions, contenu conversationnel personnel). Une donnée absente et non déclarée est une anomalie du diagnostic.', '');
  L.push('## 2. Sections de cette archive', '');
  L.push('| Section | Statut | Fichiers | Motif |', '|---|---|---|---|');
  for (const s of g.sections) L.push(`| ${s.label} (\`${s.code}\`) | ${s.status} | ${s.files} | ${s.motif ?? ''} |`);
  L.push('');
  L.push('## 3. Où se trouve quoi', '');
  L.push('- `donnees/<section>/<table>.json` : toutes les lignes de chaque table du périmètre (toutes colonnes sauf exclusions de sécurité), triées par compte puis par clé primaire (les lignes d’un compte sont contiguës) ; découpage `…part-NNNN.json` au-delà de 50 000 lignes, toutes présentes.');
  L.push('- `donnees/fermeture/<table>.json` (diagnostics filtrés) : lignes hors filtre direct ajoutées parce qu’une ligne exportée les cite (fermeture transitive automatique).');
  L.push('- `controle/comptes.json` : chaque compte couvert, ses lignes exportées ; lignes rattachées à un compte supprimé (identifiant conservé).');
  L.push('- `tracabilite/proprietes.json` : UNE entrée par propriété (bien × champ) — valeur persistée, valeur renvoyée par l’API, champ affiché, décisions, preuves, faits, extractions, documents, traitements, conflits, écritures, reprises de propriétés manquantes.');
  L.push('- `api-ui/fiches.json` : réponse de `GET /api/assets/[id]/details` recalculée par la MÊME fonction que la route (`buildSections`), et champs effectivement rendus ; `api-ui/correspondance-champs.json` : table champ API → composant d’écran maintenue dans le code.');
  L.push('- `tracabilite/montants.json`, `tracabilite/tco.json` : chaque montant TCO tracé jusqu’à sa source ; `tracabilite/identite-economique.json` : candidats, sources, provenance, journal des séparations et rétablissements.');
  L.push('- `technique/chronologie.json` : anomalies, traitements, rapports, appels IA, opérations IA, historique des rapprochements, ordonnés par horodatage avec leurs corrélations.');
  L.push('- `couverture/tables.json` : chaque table de la base — section ou exclusion motivée, filtre, colonnes exclues ; `technique/versions.json` : version applicative, base, migrations appliquées, empreintes de configuration IA et des prompts, indicateurs.', '');
  L.push('## 4. Reconstruire une chaîne — cas général', '');
  L.push('Chaîne : **document → extraction → unité source → fait → preuve → candidat → décision → écriture → propriété → API → affichage**. Toutes les jointures se font par identifiant (jamais masqué).', '');
  L.push('1. **Affichage / API** — `tracabilite/proprietes.json`, entrée `{ bien, champ }` : `api.valeur` (renvoyée), `affichage` (section, libellé, condition), `verdict` : `VIDE_EN_BASE`, `PERSISTE_NON_RENVOYE` (backend), `RENVOYE_NON_AFFICHE` / `ATTENDU_PAR_ECRAN_NON_RENVOYE` (affichage), `COHERENT`.');
  L.push('2. **État persisté** — `persiste.fiche` (clé de `assets.key_characteristics`, origine, date, verrou `__userValidated`), `persiste.colonne` (colonne de repli), `persiste.canonique` (vue canonique) ; ligne complète dans `donnees/etat-metier/assets.json`.');
  L.push('3. **Écriture** — `ecritures[]` (`canonical_field_writes` : avant / après, résultat, trace) et `ecrituresRapport[]` (lignes FIELD des rapports T3 : écrite, non écrite et motif, échec). Une décision « apply » sans écriture WRITTEN = erreur de persistance ; pas de décision « apply » = erreur (ou abstention) de décision.');
  L.push('4. **Décision / arbitrage** — `decisions[]` (`reconciliation_decisions` : action, motif, confiance, preuves citées, passage et déclencheur), `conflits[]` (`inconsistency_registry`), `reprisesProprieteManquante[]` (`property_recovery_decisions` : décision ou abstention, cause, preuves).');
  L.push('5. **Candidats et preuves** — `preuves[]` : toutes les preuves du champ, y compris remplacées ou rejetées (`status`, `lifecycle_status`), avec document (`source_id`), page (`source_location`), extrait, confiance, analyse productrice.');
  L.push('6. **Faits et extraction** — `faits[]` (`document_facts` du même champ dans les documents du bien) → `donnees/extractions-ia/document_extractions.json` (modèle, version de prompt, trace) → `document_source_units.json` (entrée utile).');
  L.push('7. **Document et relations** — `donnees/documents/asset_files.json` (type, catégorie, date, statut, titre) ; rattachements actuels et retirés : `donnees/relations/document_asset_links.json`.');
  L.push('8. **Traitement** — `traitements[]` : rapports d’exécution T1 / T3 (`ai_execution_reports`, lignes dans `donnees/ecritures/ai_execution_report_entries.json`), file des traitements (`donnees/technique/ai_job_queue.json` : tentatives, erreurs, reprises), appels IA (`ai_usage_event` : modèle, rang, prompt maître et version, durée, coût).', '');
  L.push('## 5. Exemple : « le bien a une date d’achat mais pas de prix »', '');
  L.push('Cas général appliqué au champ `acquisitionPrice` (même démarche pour tout champ) :', '');
  L.push('- `tracabilite/proprietes.json` › `{ champ: "acquisitionPrice" }` : `persiste` vide ? `api.valeur` vide ? `verdict` ?');
  L.push('- `faits[]` : quels montants T1 a lus, dans quels documents et avec quel extrait ; `preuves[]` : lesquels ont été projetés sur le bien (comparer faits et preuves).');
  L.push('- `conflits[]` / `decisions[]` / `reprisesProprieteManquante[]` : candidats concurrents, action retenue (apply, create_conflict, ignore…) et motif ; abstention éventuelle.');
  L.push('- `ecritures[]` / `ecrituresRapport[]` : écriture tentée, résultat, valeur avant / après ; `persiste` : valeur réellement en base ; `api` / `affichage` : valeur renvoyée et affichée.');
  L.push('- Si un maillon manque, `controle/references.json` dit s’il est absent et le manifeste le signale : la section concernée n’est pas COMPLETE.', '');
  L.push('## 6. Autres questions types', '');
  L.push('- Classement / rattachement d’un document : `donnees/documents/asset_files.json`, `donnees/relations/document_asset_links.json` (+ `document_asset_resolutions`), `donnees/corrections-utilisateur/document_classification_feedback.json`, `donnees/historique/document_title_events.json`.');
  L.push('- Doublon ou fusion d’un rapprochement : `donnees/etat-metier/business_operations.json`, `donnees/relations/business_operation_sources.json`, `donnees/historique/business_operation_history.json`, `donnees/conflits-arbitrages/business_operation_identity_reviews.json`, `operation_semantic_reevaluations.json`.');
  L.push('- Échéance / date calculée : `donnees/etat-metier/agenda_items.json`, `donnees/relations/agenda_item_sources.json`, `donnees/rapprochements-agenda-controles/agenda_occurrence_events.json`.');
  L.push('- Suggestion T6 : `donnees/extractions-ia/t6_evaluation_runs.json`, `t6_interpellation_assessments.json`, `donnees/candidats/t6_candidate_examinations.json`, `home_mascot_generations.json`.');
  L.push('- Contrôle de cohérence / autoréparation : `donnees/rapprochements-agenda-controles/coherence_repairs.json`, `coherence_object_proofs.json`, `coherence_campaigns.json` ; propriétés manquantes : `donnees/conflits-arbitrages/property_recovery_runs.json`, `donnees/ecritures/property_recovery_decisions.json`.');
  L.push('- Omission documentaire T1 (COH-DOC-EXTRACT-CHAIN, lot 91D) : `coherence_object_proofs.json` (constat, `finding.detail.qualification`, valeurs et état de décision dans `finding.observed`), `donnees/extractions-ia/document_value_decisions.json` (décision T1 par valeur : unité, valeur normalisée, décision, motif, faits rattachés, validité, historique), `document_source_units.json`, `coherence_repairs.json` (réexamens `reviewDocumentValueDecisions`).');
  L.push('- Job échoué ou rejoué : `donnees/technique/ai_job_queue.json` (`attempts`, `attempt_history`, `last_error`, `recovered_count`), `ai_usage_event.json`, `admin_anomalies.json`, `technique/chronologie.json`.');
  L.push('- Configuration IA, modèles, routage : `donnees/referentiels/ai_config_versions.json`, `ai_config_revisions.json` (empreintes), `ai_master_prompt_versions.json` (empreinte `content_sha256`), `ai_model_catalog.json`, `ai_routing_promotions.json`.', '');
  L.push('## 7. Sécurité', '');
  L.push('Jamais exportés : mots de passe et empreintes, jetons, sessions, clés, secrets, emplacements de stockage, codes utilisables, contenu des conversations de l’assistant. Contenus restreints (texte intégral, prompts, sorties brutes du modèle) : longueur et SHA-256 seulement. Liste complète : `manifeste.json` › `exclusionsVolontaires`.');
  return `${L.join('\n')}\n`;
}
