/**
 * Lot 88A — diagnostic global : fonctions PURES (masquage d'une ligne,
 * statut par section du manifeste, guide d'analyse). Partagées par le
 * moteur (`collect.ts`, `account.ts`) et les tests.
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
export function maskDiagRow(row: Row, opts: { isSensitiveKey?: (k: string) => boolean } = {}): Row {
  const kept: Row = {};
  const rest: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) { kept[k] = v ?? null; continue; }
    if (isRestrictedContentColumn(k) || exportMaskingRule(k)?.content) {
      const text = typeof v === 'string' ? v : JSON.stringify(v);
      kept[k] = { $etat: 'masque', motif: 'contenu restreint (longueur et empreinte seules)', longueur: text.length, sha256: sha256(text) };
    } else if (COUNTER_COLUMN.test(k) && (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)))) {
      kept[k] = v;
    } else rest[k] = v;
  }
  const masked = maskForExport(rest, { isSensitiveKey: opts.isSensitiveKey }) as Row;
  const out: Row = {};
  for (const k of Object.keys(row)) out[k] = k in kept ? kept[k] : masked[k];
  return out;
}

/** Section d'un fichier des périmètres historiques (bien, document, Opération, utilisateur, global). */
export function sectionOfPath(path: string): DiagSectionCode {
  const m = /^compte\/([a-z-]+)\//.exec(path);
  if (m && m[1] in DIAG_SECTIONS) return m[1] as DiagSectionCode;
  if (/^compte\/fermeture\//.test(path) || /^controle\//.test(path) || /^couverture\//.test(path)) return 'controle';
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
  /** Motif d'une section non produite pour ce périmètre. */
  notApplicableMotif: (code: DiagSectionCode) => string;
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
    if (!files.length && !issues.length) {
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
      filters: i.filters?.get(code) ?? [], limitations: i.limitations?.get(code) ?? [], truncations, errors: [...errors, ...issues],
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
  accountScope: boolean;
}

/** Guide d'analyse joint à l'archive : comment reconstruire une chaîne à partir du seul ZIP. */
export function buildAnalysisGuide(g: GuideInputs): string {
  const L: string[] = [];
  L.push('# Verebona — guide d’analyse du diagnostic', '');
  L.push(`Périmètre : **${g.scopeLabel}** — ${g.target}. Généré le ${g.generatedAt} (UTC).`, '');
  L.push('Ce guide explique comment répondre à « pourquoi Verebona affiche (ou n’affiche pas) cette valeur ? » à partir du SEUL contenu de cette archive, sans accès à la base.', '');
  L.push('## 1. Vérifier d’abord la complétude', '');
  L.push('- `manifeste.json` › `status` : COMPLETE seulement si chaque section est complète. Ne concluez jamais sur une section PARTIAL ou ERROR sans lire son `motif` et ses `errors`.');
  L.push('- `manifeste.json` › `sections[]` : statut par section (COMPLETE / PARTIAL / NOT_APPLICABLE / ERROR), fichiers, attendus (compte SQL indépendant, même instantané) vs exportés, filtres, limitations, troncatures, erreurs, SHA-256.');
  L.push('- `manifeste.json` › `autoControle` : références résolues / ajoutées par fermeture / absentes, compteurs annoncés vs lignes détaillées (`controle/*.json` pour le détail de chaque manque).');
  L.push('- `manifeste.json` › `exclusionsVolontaires` : ce qui n’est PAS dans l’archive, et pourquoi (secrets, contenu personnel, journaux multi-comptes). Une donnée absente et non déclarée est une anomalie du diagnostic.', '');
  L.push('## 2. Sections de cette archive', '');
  L.push('| Section | Statut | Fichiers | Motif |', '|---|---|---|---|');
  for (const s of g.sections) L.push(`| ${s.label} (\`${s.code}\`) | ${s.status} | ${s.files} | ${s.motif ?? ''} |`);
  L.push('');
  if (!g.accountScope) {
    L.push('> Ce périmètre est ciblé (objet ou application). Le diagnostic **Compte** (BO › Supervision › Diagnostics techniques, périmètre « Un compte ») exporte TOUTES les tables du compte et la chaîne complète de chaque propriété : utilisez-le pour une analyse auto-suffisante.', '');
  }
  L.push('## 3. Où se trouve quoi', '');
  L.push('- `compte/<section>/<table>.json` : toutes les lignes de chaque table du compte (toutes colonnes sauf exclusions de sécurité), triées par clé primaire ; découpage `…part-NNNN.json` au-delà de 50 000 lignes, toutes présentes.');
  L.push('- `compte/fermeture/<table>.json` : lignes hors périmètre direct (référentiels, campagnes, configuration) ajoutées parce qu’une ligne du compte les cite (fermeture transitive automatique).');
  L.push('- `tracabilite/proprietes.json` : UNE entrée par propriété (bien × champ) — valeur persistée, valeur renvoyée par l’API, champ affiché, décisions, preuves, faits, extractions, documents, traitements, conflits, écritures.');
  L.push('- `api-ui/fiches.json` : réponse de `GET /api/assets/[id]/details` recalculée par la MÊME fonction que la route (`buildSections`), et champs effectivement rendus ; `api-ui/correspondance-champs.json` : table champ API → composant d’écran maintenue dans le code.');
  L.push('- `couverture/tables.json` : chaque table de la base — section ou exclusion motivée, filtre, colonnes exclues ; `technique/versions.json` : version applicative, migrations appliquées, empreintes de configuration IA, indicateurs.');
  L.push('- Les fichiers historiques des diagnostics ciblés (`logs/`, `ia/`, `metier/`, `tracabilite/montants.json`) restent présents et décrits dans le manifeste.', '');
  L.push('## 4. Reconstruire une chaîne — cas général', '');
  L.push('Chaîne : **source → extraction → fait → preuve → relation → candidat → décision → arbitrage → écriture → état métier → API → affichage**. Toutes les jointures se font par identifiant (jamais masqué).', '');
  L.push('1. **Affichage / API** — `tracabilite/proprietes.json`, entrée `{ bien, champ }` : `api.valeur` (renvoyée), `ui` (section, libellé, condition), `verdict` : `VIDE_EN_BASE`, `PERSISTE_NON_RENVOYE` (backend), `RENVOYE_NON_AFFICHE` / `ATTENDU_PAR_ECRAN_NON_RENVOYE` (affichage), `COHERENT`.');
  L.push('2. **État persisté** — `persiste.fiche` (clé de `assets.key_characteristics`, origine, date, verrou `__userValidated`), `persiste.colonne` (colonne de repli), `persiste.canonique` (vue canonique) ; ligne complète dans `compte/etat-metier/assets.json`.');
  L.push('3. **Écriture** — `ecritures[]` (`canonical_field_writes` : avant / après, résultat, trace) et `ecrituresRapport[]` (lignes FIELD des rapports T3 : écrite, non écrite et motif, échec). Une décision « apply » sans écriture WRITTEN = erreur de persistance ; pas de décision « apply » = erreur (ou abstention) de décision.');
  L.push('4. **Décision / arbitrage** — `decisions[]` (`reconciliation_decisions` : action, motif, confiance, preuves citées, passage et déclencheur), `conflits[]` (`inconsistency_registry` : valeur existante / proposée, preuves de chaque côté, résolution).');
  L.push('5. **Candidats et preuves** — `preuves[]` : toutes les preuves du champ, y compris remplacées ou rejetées (`status`, `lifecycle_status`), avec document (`source_id`), page (`source_location`), extrait, confiance, analyse productrice. Les preuves sont les valeurs candidates comparées par T3.');
  L.push('6. **Faits et extraction** — `faits[]` (`document_facts` du même champ dans les documents du bien : valeur, extrait, unités sources) → `compte/extractions-ia/document_extractions.json` (modèle, version de prompt, trace) → `document_source_units.json` (entrée utile : texte de la page, longueur et empreinte pour le texte intégral).');
  L.push('7. **Document et relations** — `compte/documents/asset_files.json` (type, catégorie, date, statut, titre) ; rattachements actuels et retirés : `compte/relations/document_asset_links.json` (origine, statut, `removed_at`).');
  L.push('8. **Traitement** — `traitements[]` : rapports d’exécution T1 / T3 (`ai_execution_reports`, lignes dans `compte/ecritures/ai_execution_report_entries.json`), file des traitements (`compte/technique/ai_job_queue.json` : tentatives, erreurs, reprises), appels IA (`ai_usage_event` : modèle, rang, prompt maître et version, durée, coût).', '');
  L.push('## 5. Exemple : « le bien a une date d’achat mais pas de prix »', '');
  L.push('Cas général appliqué au champ `acquisitionPrice` (même démarche pour tout champ) :', '');
  L.push('- `tracabilite/proprietes.json` › `{ champ: "acquisitionPrice" }` : `persiste` vide ? `api.valeur` vide ? `verdict` ?');
  L.push('- `faits[]` : quels montants T1 a lus, dans quels documents (acte, compromis, offre de prêt) et avec quel extrait ; `preuves[]` : lesquels ont été projetés sur le bien (et ceux qui ne l’ont pas été : comparer faits et preuves).');
  L.push('- `conflits[]` / `decisions[]` : candidats concurrents (prix de l’acte vs montant du prêt), action retenue (apply, create_conflict, ignore…) et motif ; abstention éventuelle.');
  L.push('- `ecritures[]` / `ecrituresRapport[]` : écriture tentée, résultat, valeur avant / après ; `persiste` : valeur réellement en base ; `api` / `ui` : valeur renvoyée et affichée.');
  L.push('- Si un maillon manque, `controle/references.json` dit s’il est absent (supprimé ou hors compte) et le manifeste le signale : la section concernée n’est pas COMPLETE.', '');
  L.push('## 6. Autres questions types', '');
  L.push('- Classement / rattachement d’un document : `compte/documents/asset_files.json`, `compte/relations/document_asset_links.json` (+ `document_asset_resolutions`), `compte/corrections-utilisateur/document_classification_feedback.json`, `compte/historique/document_title_events.json`.');
  L.push('- Doublon ou fusion d’un rapprochement : `compte/etat-metier/business_operations.json` (`merged_into_operation_id`, `invalidated_at`), `compte/relations/business_operation_sources.json`, `compte/historique/business_operation_history.json`, `compte/conflits-arbitrages/business_operation_identity_reviews.json`, `operation_semantic_reevaluations.json`.');
  L.push('- Échéance / date calculée : `compte/etat-metier/agenda_items.json`, `compte/relations/agenda_item_sources.json` (preuve source), `compte/rapprochements-agenda-controles/agenda_occurrence_events.json`, `agenda_intervention_consolidations.json`.');
  L.push('- Suggestion T6 : `compte/extractions-ia/t6_evaluation_runs.json`, `t6_interpellation_assessments.json`, `compte/candidats/t6_candidate_examinations.json`, `home_mascot_generations.json`.');
  L.push('- Correction utilisateur conservée ou écrasée : origine et verrou dans la fiche (`__origin`, `__userValidated`), `compte/ecritures/canonical_field_writes.json` (origin, outcome), `compte/corrections-utilisateur/*.json`.');
  L.push('- Contrôle de cohérence / autoréparation : `compte/rapprochements-agenda-controles/coherence_repairs.json` (avant / après, service, résultat), `coherence_object_proofs.json`, campagnes dans `coherence_campaigns.json`.');
  L.push('- Job échoué ou rejoué : `compte/technique/ai_job_queue.json` (`attempts`, `attempt_history`, `last_error`, `recovered_count`), `ai_usage_event.json`, `admin_anomalies.json`, `logs/chronologie.json`.', '');
  L.push('## 7. Sécurité', '');
  L.push('Jamais exportés : mots de passe et empreintes, jetons, sessions, clés, secrets, emplacements de stockage, contenu des conversations de l’assistant. Contenus restreints (texte intégral, prompts, sorties brutes du modèle) : longueur et SHA-256 seulement. Liste complète : `manifeste.json` › `exclusionsVolontaires`.');
  return `${L.join('\n')}\n`;
}
