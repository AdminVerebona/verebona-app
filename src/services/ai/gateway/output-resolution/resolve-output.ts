/**
 * Résolution progressive d'une sortie modèle (partie DÉTERMINISTE) — lot 33D
 * (ticket « réussite malgré les désalignements », §19), ordre corrigé au lot
 * 34D (ticket « contrat runtime source unique de vérité ») :
 *
 *   0. contrat runtime : le contrat de validation EST celui de la génération
 *      (même identifiant, version et empreinte) — sinon RUNTIME_CONTRACT_MISMATCH
 *   1. réponse modèle
 *   2. parsing strict ; si échec → extraction / réparation JSON  (`json-repair`)
 *   3. normalisations déterministes SÛRES                       (`normalize`)
 *   4. validation avec le contrat canonique (+ champs non déclarés suspects)
 *   5. si échec → mappings de compatibilité EXPLICITES et versionnés
 *      (adaptateurs `contracts`, table `compat-mappings`, synonymes
 *      d'énumération) — jamais de rapprochement heuristique
 *   6. revalidation
 *   7. (passerelle) passe de réparation IA avec le contrat runtime exact
 *   8. validation champ par champ : retrait des champs facultatifs invalides
 *   9. si succès → application ; sinon → repli complet (même contrat)
 *
 * Même chaîne pour TOUS les modèles et tous les traitements (§22). Chaque
 * transformation est consignée ; un échec rend le diagnostic complet
 * (sous-type, étape, erreurs par chemin, chaîne de contrôles).
 */
import type { ZodError, ZodType } from 'zod';
import type {
  ControlChain, InvalidOutputSubtype, OutputRepairStep, ProviderCallMetadata, ValidationIssueDetail, AiFailureStage,
} from '../diagnostics/taxonomy';
import { emptyControlChain } from '../diagnostics/taxonomy';
import { isTruncated, issuesFromZod, mainSubtype, stageOfSubtype, boundedValue, jsonType, jsonPath } from '../diagnostics/classify';
import { redact, previewForLog } from '../redaction';
import { parseModelOutput } from './json-repair';
import { applyCompatAdapters } from './contracts';
import { applyFieldCompatMappings } from './compat-mappings';
import { normalizeToSchema } from './normalize';
import { describe } from './schema-introspect';
import { pruneInvalidFields, splitPipe } from './field-validation';
import { findUnknownFields, unknownFieldIssue, noteIgnoredUnknown, type UnknownField } from './unknown-fields';
import { compareStamps, contractStamp, type ContractMismatch, type ContractStamp, type RuntimeContract } from './runtime-contract';

export interface ResolveInput {
  raw: string;
  /** Schéma de validation — ignoré si `contract` est fourni (le contrat fait foi). */
  schema: ZodType;
  /** Nom du contrat (adaptateurs de compatibilité). */
  schemaName?: string | null;
  /**
   * Lot 34D — contrat runtime figé de l'exécution : schéma de validation,
   * nom (mappings de compatibilité). Prime sur `schema` / `schemaName`.
   */
  contract?: RuntimeContract;
  /**
   * Lot 34D — contrat avec lequel la sortie a été GÉNÉRÉE (schéma fournisseur,
   * bloc de priorité du prompt). Différent de `contract` : RUNTIME_CONTRACT_MISMATCH.
   */
  generationStamp?: ContractStamp;
  operationCode: string;
  format?: 'json' | 'text';
  expectedTask?: string;
  taskField?: 'task' | 'mode' | 'none';
  /** Mode JSON natif / structured output demandé au fournisseur. */
  jsonRequested?: boolean;
  /** Métadonnées fournisseur (détection de troncature). */
  provider?: Pick<ProviderCallMetadata, 'finishReason' | 'stopReason' | 'maxTokensReached' | 'tokenUsage' | 'configuredMaxOutputTokens'>;
  /** Étape 8 : retrait des champs facultatifs invalides. */
  allowPruning: boolean;
  /** Candidat déjà parsé (après réparation IA) : le parsing est sauté. */
  candidate?: { value: unknown; repairs: OutputRepairStep[] };
}

export type Resolution =
  | {
    ok: true;
    data: unknown;
    repairs: OutputRepairStep[];
    controls: ControlChain;
    parsed: unknown;
    extracted: string | null;
  }
  | {
    ok: false;
    subtype: InvalidOutputSubtype;
    stage: AiFailureStage;
    issues: ValidationIssueDetail[];
    issueCount: number;
    message: string;
    controls: ControlChain;
    repairs: OutputRepairStep[];
    parsed: unknown;
    extracted: string | null;
    /** Valeur la plus avancée (préparée, sans clés internes) — base de la réparation IA. */
    best: unknown;
    /** Valeur préparée complète (clés internes comprises). */
    prepared: unknown;
    /** Tous les chemins en erreur (500 au plus) — fusion verrouillée de la réparation. */
    allPaths: string[];
    /**
     * Lot 34D — chemins de champs facultatifs ABSENTS voisins d'un champ non
     * déclaré : repris de la réparation seulement s'ils y figurent.
     */
    optionalPaths: string[];
    /** Lot 34D — contrat de validation ≠ contrat de génération. */
    contractMismatch?: ContractMismatch;
    /** Une réparation de FORME peut-elle aboutir ? (jamais : vide, tronqué, mauvaise branche). */
    repairable: boolean;
    taskMismatch?: { expected: string; received: unknown; discriminant: 'TASK' | 'MODE' };
  };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Clés internes de préparation (`_normalisation` de T1) retirées avant réparation. */
function sansInterne(v: unknown): unknown {
  if (!isObj(v)) return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')));
}

/** Somme des compteurs de préparation d'un premier passage (rapport T1 conservé). */
export function reporterCompteurs(premier: unknown, final: unknown): void {
  if (!isObj(premier) || !isObj(final)) return;
  for (const [k, v] of Object.entries(premier)) {
    if (!k.startsWith('_') || !isObj(v) || !isObj(final[k])) continue;
    const cible = final[k] as Obj;
    for (const [ck, cv] of Object.entries(v)) {
      if (typeof cv === 'number' && typeof cible[ck] === 'number') cible[ck] = (cible[ck] as number) + cv;
    }
  }
}

function excerptOf(raw: string): string {
  return previewForLog(raw, 200);
}

/** Valide `value` contre le schéma (préparation comprise). */
function validate(schema: ZodType, value: unknown): { ok: true; data: unknown; prepared: unknown } | { ok: false; error: ZodError; prepared: unknown } | { ok: false; exception: Error } {
  const { pre, main } = splitPipe(schema);
  let prepared = value;
  try {
    if (pre) {
      const p = pre.safeParse(value);
      if (!p.success) return { ok: false, error: p.error, prepared: value };
      prepared = p.data;
    }
    const r = main.safeParse(prepared);
    return r.success ? { ok: true, data: r.data, prepared } : { ok: false, error: r.error, prepared };
  } catch (e) {
    return { ok: false, exception: e as Error };
  }
}

export function resolveOutput(input: ResolveInput): Resolution {
  if (input.contract) input = { ...input, schema: input.contract.schema, schemaName: input.contract.schemaName };
  const controls = emptyControlChain();
  const repairs: OutputRepairStep[] = [...(input.candidate?.repairs ?? [])];
  const raw = String(input.raw ?? '');
  controls.providerResponse = 'passed';
  controls.structuredOutput = input.jsonRequested ? 'not_run' : 'not_applicable';
  const truncated = input.provider ? isTruncated(input.provider) : false;
  const fail = (
    subtype: InvalidOutputSubtype, message: string,
    extra: Partial<Extract<Resolution, { ok: false }>> = {},
  ): Resolution => ({
    ok: false, subtype, stage: extra.stage ?? stageOfSubtype(subtype), issues: [], issueCount: 0, message,
    controls, repairs, parsed: undefined, extracted: null, best: undefined, prepared: undefined, repairable: false,
    allPaths: (extra.issues ?? []).map((i) => i.path), optionalPaths: [], ...extra,
  });

  // ── 0. Contrat runtime : validation = génération (RTC-07) ────────────────
  if (input.contract && input.generationStamp) {
    const mm = compareStamps(input.generationStamp, contractStamp(input.contract));
    if (mm) {
      controls.schema = 'not_run';
      return fail('RUNTIME_CONTRACT_MISMATCH', mm.message, {
        stage: 'schema_validation', contractMismatch: mm,
        issues: [{ subtype: 'RUNTIME_CONTRACT_MISMATCH', path: '$', expected: `${mm.generation.schemaVersion} (${mm.generation.schemaHash})`,
          received: `${mm.validation.schemaVersion} (${mm.validation.schemaHash})`, receivedValue: null, message: mm.message }],
        issueCount: 1,
      });
    }
  }

  // ── Format texte : la réponse brute est validée telle quelle ─────────────
  if (input.format === 'text') {
    controls.structuredOutput = 'not_applicable';
    controls.json = 'not_applicable';
    if (raw.trim() === '') {
      controls.schema = 'not_run';
      return fail(truncated ? 'OUTPUT_TRUNCATED' : 'EMPTY_RESPONSE', truncated ? 'Sortie tronquée (limite de génération)' : 'Réponse vide');
    }
    const v = validate(input.schema, raw);
    if (v.ok) { controls.schema = 'passed'; return { ok: true, data: v.data, repairs, controls, parsed: raw, extracted: null }; }
    controls.schema = 'failed';
    if ('exception' in v) {
      return fail('PARSER_ERROR', `Erreur du parseur : ${redact(v.exception.message)}`, {
        issues: [{ subtype: 'PARSER_ERROR', path: '$', expected: null, received: 'string', receivedValue: null, message: redact(v.exception.message) }],
        issueCount: 1,
      });
    }
    const { issues, total } = issuesFromZod(v.error, raw);
    const subtype = truncated ? 'OUTPUT_TRUNCATED' : mainSubtype(issues);
    return fail(subtype, `Sortie non conforme au schéma. ${resume(issues)}`, { issues, issueCount: total, parsed: raw });
  }

  // ── 2-3. Parsing strict, extraction, réparation JSON ─────────────────────
  let parsed: unknown;
  let extracted: string | null = null;
  if (input.candidate) {
    parsed = input.candidate.value;
    controls.structuredOutput = input.jsonRequested ? 'repaired' : 'not_applicable';
    controls.json = 'repaired';
  } else {
    const p = parseModelOutput(raw);
    repairs.push(...p.repairs);
    extracted = p.extracted;
    if (!p.ok) {
      controls.json = 'failed';
      controls.structuredOutput = input.jsonRequested ? 'absent' : 'not_applicable';
      if (p.empty) {
        return fail(truncated ? 'OUTPUT_TRUNCATED' : 'EMPTY_RESPONSE',
          // Format historique conservé : l'assistant reconnaît la sortie vide à ce message.
          truncated ? 'Sortie tronquée (limite de génération) : aucune réponse exploitable.' : 'Sortie non parsable : Aucune structure JSON détectée. Extrait : ',
          { stage: 'response_reception', extracted });
      }
      if (truncated || (p.incomplete && truncatedByTokens(input.provider))) {
        return fail('OUTPUT_TRUNCATED',
          `Sortie tronquée (limite de génération) : ${p.error}. Extrait : ${excerptOf(raw)}`,
          { stage: 'response_reception', extracted });
      }
      return fail('MALFORMED_JSON', `Sortie non parsable : ${p.error}. Extrait : ${excerptOf(raw)}`,
        // JSON illisible mais non tronqué : une réparation de syntaxe est possible.
        { extracted, best: raw, repairable: !p.incomplete });
    }
    parsed = p.value;
    controls.json = p.strict ? 'passed' : 'repaired';
    controls.structuredOutput = input.jsonRequested ? (p.strict ? 'passed' : 'absent') : 'not_applicable';
  }

  // ── 3. Normalisations déterministes SÛRES ───────────────────────────────
  const discField = input.taskField === 'none' ? null : (input.taskField ?? 'task');
  const disc = input.expectedTask !== undefined && discField ? { discriminant: { field: discField, value: input.expectedTask } } : {};
  const parseRepairs = [...repairs];
  let value = normalizeToSchema(parsed, input.schema, repairs, disc);

  // Branche imposée par le serveur (CDC 15 §22.2) : jamais « réparée ».
  const brancheRefusee = (v: unknown): Resolution | null => {
    if (input.expectedTask === undefined || !discField) return null;
    const recu = isObj(v) ? v[discField] : undefined;
    if (recu === input.expectedTask) return null;
    controls.schema = 'failed';
    const issue: ValidationIssueDetail = {
      subtype: 'INVALID_ENUM', path: `$.${discField}`, expected: `branche ${input.expectedTask}`,
      received: jsonType(recu), receivedValue: boundedValue(recu), allowedValues: [input.expectedTask],
      message: `Sortie de la branche ${JSON.stringify(recu ?? null)} au lieu de ${discField === 'mode' ? 'MODE' : 'TASK'}=${input.expectedTask}`,
    };
    return fail('INVALID_ENUM', issue.message, {
      issues: [issue], issueCount: 1, parsed, extracted, stage: 'schema_validation',
      taskMismatch: { expected: input.expectedTask, received: recu, discriminant: discField === 'mode' ? 'MODE' : 'TASK' },
    });
  };
  const refus = brancheRefusee(value);
  if (refus) return refus;

  // ── 4. Validation avec le contrat canonique ─────────────────────────────
  const { main } = splitPipe(input.schema);
  const suspects = (prepared: unknown): UnknownField[] => findUnknownFields(prepared, main).filter((u) => u.suspicious);
  let v = validate(input.schema, value);
  let inconnus = v.ok ? suspects(v.prepared) : [];

  // ── 5-6. Mappings de compatibilité explicites, puis revalidation ────────
  if (!(v.ok && inconnus.length === 0) && !('exception' in v)) {
    const compat: OutputRepairStep[] = [];
    let c = applyCompatAdapters(structuredCloneSafe(parsed), input.schemaName, compat);
    c = applyFieldCompatMappings(c, input.schemaName, compat);
    const appliques = compat.length > 0;
    c = normalizeToSchema(c, input.schema, compat, { ...disc, compat: true });
    if (appliques || compat.some((r) => r.stage === 'compat_mapping')) {
      const refus2 = brancheRefusee(c);
      const v2 = refus2 ? null : validate(input.schema, c);
      const inconnus2 = v2?.ok ? suspects(v2.prepared) : [];
      const mieux = v2 && !('exception' in v2) && (v2.ok
        ? inconnus2.length < inconnus.length || !v.ok
        : !v.ok && (v2.error.issues.length < (v as { error: ZodError }).error.issues.length));
      if (v2 && mieux) {
        repairs.length = 0;
        repairs.push(...parseRepairs, ...compat);
        value = c; v = v2; inconnus = inconnus2;
      }
    }
  }

  if (v.ok && inconnus.length === 0) {
    controls.schema = repairs.some((r) => ['normalization', 'compat_adapter', 'compat_mapping'].includes(r.stage)) ? 'repaired' : 'passed';
    return { ok: true, data: v.data, repairs, controls, parsed, extracted };
  }
  if ('exception' in v) {
    controls.schema = 'failed';
    return fail('PARSER_ERROR', `Erreur du parseur de sortie : ${redact(v.exception.message)}`, {
      parsed, extracted, stage: 'result_mapping',
      issues: [{ subtype: 'PARSER_ERROR', path: '$', expected: null, received: jsonType(value), receivedValue: null, message: redact(v.exception.message) }],
      issueCount: 1,
    });
  }

  // ── 8. Validation champ par champ (retrait des champs facultatifs invalides) ─
  if (input.allowPruning) {
    if (v.ok) {
      // Seuls des champs non déclarés suspects : sans réparation, ils sont ignorés (consigné).
      noteIgnoredUnknown(inconnus, repairs, 'unknown_field_dropped');
      controls.schema = 'repaired';
      return { ok: true, data: v.data, repairs, controls, parsed, extracted };
    }
    const pr = pruneInvalidFields(v.prepared, main, repairs, { protectedKeys: discField ? [discField] : [] });
    if (pr.success) {
      noteIgnoredUnknown(suspects(v.prepared), repairs, 'unknown_field_dropped');
      reporterCompteurs(v.prepared, pr.data);
      controls.schema = 'repaired';
      return { ok: true, data: pr.data, repairs, controls, parsed, extracted };
    }
  }

  controls.schema = 'failed';
  const prepared = v.prepared;
  const inconnusTous = v.ok ? inconnus : suspects(prepared);
  const issuesInconnus = inconnusTous.map(unknownFieldIssue);
  const zod = v.ok ? null : issuesFromZod(v.error, prepared, 20, describe(main));
  const issues = [...(zod?.issues ?? []), ...issuesInconnus].slice(0, 20);
  const total = (zod?.total ?? 0) + issuesInconnus.length;
  const subtype = truncated ? 'OUTPUT_TRUNCATED' : mainSubtype(issues);
  // Format historique du message conservé (« Sortie non conforme au schéma. chemin : message | … ») :
  // des appelants le lisent ; le sous-type voyage dans le diagnostic.
  return fail(subtype, `Sortie non conforme au schéma. ${resume(issues)}`, {
    issues, issueCount: total, parsed, extracted, stage: truncated ? 'response_reception' : stageOfSubtype(subtype),
    best: sansInterne(prepared), prepared, repairable: !truncated,
    allPaths: [
      ...(v.ok ? [] : v.error.issues.slice(0, 500).map((i) => jsonPath(i.path as PropertyKey[]))),
      ...inconnusTous.map((u) => u.path),
    ],
    optionalPaths: [...new Set(inconnusTous.flatMap((u) => u.absentOptional))],
  });
}

function structuredCloneSafe<T>(v: T): T {
  try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)) as T; }
}

function truncatedByTokens(p: ResolveInput['provider']): boolean {
  if (!p) return false;
  const max = p.configuredMaxOutputTokens;
  return Boolean(max && (p.tokenUsage?.output ?? 0) >= max * 0.98);
}

/** `$.claims[0].text` → `claims.0.text` (format historique des messages). */
function dotted(path: string): string {
  return path.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1').replace(/^\./, '');
}

/** Message compact (compatible avec l'ancien format « chemin : message | … »). */
function resume(issues: ValidationIssueDetail[]): string {
  return issues.slice(0, 5)
    .map((i) => `${dotted(i.path) || '(racine)'} : ${i.message}`)
    .join(' | ');
}
