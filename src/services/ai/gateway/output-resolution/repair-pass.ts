/**
 * Passe de réparation IA ciblée — lot 33D (ticket « réussite malgré les
 * désalignements », §8 à §13 ; étape 8 de la résolution progressive).
 *
 * Quand la normalisation déterministe ne suffit pas mais que la sortie
 * contient l'information, le modèle est rappelé pour REFORMATER, jamais
 * pour réanalyser :
 *   · aucun document joint (pas de relecture de la source) ;
 *   · il reçoit la sortie précédente, les erreurs exactes et le CONTRAT
 *     RUNTIME EXACT de l'exécution (lot 34D : schéma JSON dérivé du contrat
 *     figé, identité du contrat) — jamais une représentation reconstruite ;
 *     la sortie réparée est revalidée avec ce même contrat ;
 *   · les champs déjà VALIDES sont verrouillés : la réponse n'est retenue
 *     qu'aux chemins en erreur (`mergeRepair`) — une réparation de
 *     `purchaseDate` ne peut pas modifier `amount`, `vendor`… ;
 *   · une sortie TRONQUÉE ou VIDE n'est jamais « réparée » : l'information
 *     manque, c'est un cas de repli (nouvel appel complet).
 */
import type { ValidationIssueDetail } from '../diagnostics/taxonomy';
import { valueAt } from '../diagnostics/classify';

/** Taille maximale de la sortie précédente transmise (caractères). */
export const REPAIR_MAX_INPUT_CHARS = 120_000;

/**
 * Passe de réparation activée ? `AI_OUTPUT_REPAIR_PASS=off` la coupe (défaut :
 * active). Jamais pour un appel à budget d'appels modèle (assistant, CA-07) :
 * la réparation serait un appel de plus que le budget n'autorise pas.
 */
export function repairPassEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(off|false|0|no|disabled)$/i.test((env.AI_OUTPUT_REPAIR_PASS ?? '').trim());
}

/** JSONPath (`$.document.facts[2].target`) → segments. */
export function parsePath(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  const re = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path.replace(/^\$/, ''))) !== null) {
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[2] !== undefined) out.push(Number(m[2]));
    else out.push(JSON.parse(`"${m[3]}"`) as string);
  }
  return out;
}

type Obj = Record<PropertyKey, unknown>;

function setAt(root: unknown, path: Array<string | number>, value: unknown): void {
  if (path.length === 0) return;
  let cur = root as Obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    let next = cur[seg];
    if (next === null || typeof next !== 'object') {
      next = typeof path[i + 1] === 'number' ? [] : {};
      cur[seg] = next;
    }
    cur = next as Obj;
  }
  const last = path[path.length - 1];
  if (value === undefined) {
    if (Array.isArray(cur) && typeof last === 'number') cur.splice(last, 1);
    else delete cur[last];
  } else cur[last] = value;
}

/**
 * Fusion VERROUILLÉE : copie de la sortie d'origine, dans laquelle seules
 * les valeurs aux chemins en erreur (et leurs parents manquants) sont prises
 * dans la réparation. Sans sortie d'origine exploitable (JSON illisible),
 * rien n'est verrouillable : la réparation est prise entière.
 */
export function mergeRepair(
  original: unknown, repaired: unknown, invalidPaths: string[],
  /**
   * Lot 34D — champs facultatifs ABSENTS voisins d'un champ non déclaré :
   * repris de la réparation s'ils y figurent, sans jamais remonter au parent.
   */
  optionalPaths: string[] = [],
): { value: unknown; replaced: string[] } {
  if (original === null || typeof original !== 'object' || repaired === null || typeof repaired !== 'object') {
    return { value: repaired, replaced: ['$'] };
  }
  const out = structuredClone(original);
  const replaced: string[] = [];
  // Chemins les plus courts d'abord : un parent remplacé englobe ses enfants.
  const chemins = [...new Set(invalidPaths)].map(parsePath).sort((a, b) => a.length - b.length);
  const faits: string[] = [];
  for (const p of chemins) {
    const key = JSON.stringify(p);
    if (faits.some((f) => key === f || key.startsWith(`${f.slice(0, -1)},`))) continue;
    // Un champ obligatoire manquant peut exiger son parent : on remonte tant
    // que la réparation n'a rien à ce chemin.
    let cible = p;
    while (cible.length > 1 && valueAt(repaired, cible) === undefined && valueAt(original, cible) === undefined) {
      cible = cible.slice(0, -1);
    }
    setAt(out, cible, structuredClone(valueAt(repaired, cible)));
    faits.push(JSON.stringify(cible));
    replaced.push('$' + cible.map((s) => (typeof s === 'number' ? `[${s}]` : `.${s}`)).join(''));
  }
  for (const path of [...new Set(optionalPaths)]) {
    const p = parsePath(path);
    const v = valueAt(repaired, p);
    if (v === undefined || valueAt(original, p) !== undefined) continue;
    setAt(out, p, structuredClone(v));
    replaced.push(path);
  }
  return { value: out, replaced };
}

/** Prompt de la passe de réparation (aucune donnée nouvelle ne doit apparaître). */
export function buildRepairPrompt(p: {
  previousOutput: string;
  issues: ValidationIssueDetail[];
  schemaJson: string | null;
  discriminant?: { field: string; value: string } | null;
  malformedJson: boolean;
  /** Lot 34D — identité du contrat runtime (`T1_ANALYZE_DOCUMENT v3 · … · empreinte`). */
  contractLabel?: string | null;
}): string {
  const erreurs = p.issues.slice(0, 20).map((i) => {
    const parts = [`- ${i.path} : ${i.subtype}`];
    if (i.expected) parts.push(`attendu ${i.expected}`);
    if (i.received) parts.push(`reçu ${i.received}`);
    if (i.allowedValues?.length) parts.push(`valeurs autorisées : ${i.allowedValues.slice(0, 30).join(' | ')}`);
    return parts.join(' ; ');
  }).join('\n');
  return [
    'Tu es un correcteur de FORMAT JSON. Tu ne disposes d’aucun document et tu ne dois rien analyser.',
    '',
    'La réponse précédente contient les bonnes informations mais ne respecte pas le schéma attendu.',
    p.malformedJson
      ? 'Elle n’est pas un JSON valide : corrige uniquement la syntaxe.'
      : 'Corrige UNIQUEMENT les chemins en erreur ci-dessous.',
    '',
    'RÈGLES ABSOLUES',
    '- N’ajoute aucune information absente de la réponse précédente : aucune date, valeur, entité ou preuve nouvelle.',
    '- Ne modifie aucune valeur valide : recopie à l’identique tout ce qui n’est pas en erreur.',
    '- Convertis seulement la FORME (type, format de date AAAA-MM-JJ, nom de champ, valeur d’énumération autorisée).',
    '- Un champ non déclaré par le contrat est renommé vers le champ du contrat qui porte la même information, ou supprimé : le contrat runtime est prioritaire.',
    '- Si une valeur ne peut pas être corrigée sans invention et que le champ est facultatif, supprime ce champ.',
    p.discriminant ? `- Le champ "${p.discriminant.field}" vaut obligatoirement "${p.discriminant.value}".` : '',
    '- Réponds uniquement par le JSON complet corrigé, sans texte autour.',
    '',
    ...(erreurs ? ['ERREURS DE VALIDATION', erreurs, ''] : []),
    ...(p.schemaJson ? [
      p.contractLabel ? `CONTRAT RUNTIME (${p.contractLabel}) — SCHÉMA ATTENDU (JSON Schema)` : 'SCHÉMA ATTENDU (JSON Schema)',
      p.schemaJson, '',
    ] : []),
    'RÉPONSE PRÉCÉDENTE',
    p.previousOutput,
  ].filter((l) => l !== '').join('\n');
}
