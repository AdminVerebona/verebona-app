/**
 * Champs NON DÉCLARÉS par le contrat runtime — lot 34D (ticket « contrat
 * runtime source unique de vérité », cas 6).
 *
 * Un schéma Zod objet ignore (retire) les clés qu'il ne déclare pas : une
 * sortie `{"datePurchase": "2026-04-24"}` là où le contrat attend
 * `purchaseDate` serait « valide »… et la date perdue sans bruit. Le lot 33D
 * la rattrapait par ressemblance de noms : c'est interdit (aucune devinette).
 *
 * Règle déterministe, sans interprétation du nom :
 *   · une clé non déclarée, porteuse d'une valeur ACCEPTÉE par le schéma
 *     d'au moins un champ DÉCLARÉ ABSENT du même objet, est SUSPECTE (le
 *     modèle a
 *     pu mal nommer un champ du contrat) → passe de réparation avec le
 *     contrat exact, qui décide ; les chemins absents sont transmis comme
 *     chemins réparables ;
 *   · toute autre clé non déclarée est simplement ignorée (comportement du
 *     contrat), et consignée (`unknown_field_ignored`) ;
 *   · un objet ouvert (`looseObject`, `catchall`) n'a pas de clé inconnue ;
 *   · les clés internes de préparation (`_normalisation`) sont ignorées.
 * Si la réparation n'aboutit pas, la validation champ par champ accepte la
 * sortie sans ces clés (comportement historique), consigné
 * `unknown_field_dropped`.
 */
import type { ZodType } from 'zod';
import type { OutputRepairStep, ValidationIssueDetail } from '../diagnostics/taxonomy';
import { describe, resolveUnion, type FieldDesc } from './schema-introspect';
import { jsonType, boundedValue } from '../diagnostics/classify';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface UnknownField {
  /** Chemin JSONPath concret (`$.document.datePurchase`). */
  path: string;
  key: string;
  /** Chemins des champs FACULTATIFS déclarés absents du même objet (repris de la réparation s'ils y figurent). */
  absentOptional: string[];
  /** Noms de TOUS les champs déclarés absents du même objet (obligatoires compris). */
  absentDeclared: string[];
  suspicious: boolean;
  value: unknown;
}

/** La valeur pourrait-elle être celle de ce champ déclaré ? (forme seulement, jamais le nom.) */
function accepte(f: FieldDesc, v: unknown): boolean {
  try { return f.schema.safeParse(v).success; } catch { return false; }
}

const porteuse = (v: unknown) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);

/** Clés non déclarées de `value` au regard du schéma (au plus `max`). */
export function findUnknownFields(value: unknown, schema: ZodType, max = 50): UnknownField[] {
  const out: UnknownField[] = [];
  walk(value, describe(schema), '$', out, max);
  return out;
}

function walk(value: unknown, desc: FieldDesc, path: string, out: UnknownField[], max: number): void {
  if (out.length >= max) return;
  const d = resolveUnion(desc, value);
  const n = d.node;
  if (n.kind === 'object' && isObj(value)) {
    const known = Object.keys(n.shape);
    if (!n.open) {
      const declares = known.filter((k) => value[k] === undefined && !k.startsWith('_'));
      const absents = declares.filter((k) => n.shape[k].optional).map((k) => `${path}.${k}`);
      for (const k of Object.keys(value)) {
        if (known.includes(k) || k.startsWith('_')) continue;
        out.push({
          path: `${path}.${k}`, key: k, absentOptional: absents, absentDeclared: declares,
          suspicious: porteuse(value[k]) && declares.some((d) => accepte(n.shape[d], value[k])), value: value[k],
        });
        if (out.length >= max) return;
      }
    }
    for (const k of known) if (value[k] !== undefined) walk(value[k], n.shape[k], `${path}.${k}`, out, max);
    return;
  }
  if (n.kind === 'array' && Array.isArray(value)) {
    value.forEach((x, i) => walk(x, n.element, `${path}[${i}]`, out, max));
  }
}

/** Détail de validation d'une clé suspecte (même format que les erreurs du validateur). */
export function unknownFieldIssue(u: UnknownField): ValidationIssueDetail {
  const absents = u.absentDeclared;
  return {
    subtype: 'SCHEMA_VALIDATION_FAILED',
    path: u.path,
    expected: `champ déclaré par le contrat (absents : ${absents.slice(0, 12).join(', ')})`,
    received: jsonType(u.value),
    receivedValue: boundedValue(u.value),
    message: `Champ « ${u.key} » non déclaré par le contrat runtime : aucun mapping de compatibilité ne le prévoit (jamais deviné).`,
  };
}

/** Consigne les clés non déclarées ignorées (non suspectes, ou retirées faute de réparation). */
export function noteIgnoredUnknown(list: UnknownField[], report: OutputRepairStep[], rule: 'unknown_field_ignored' | 'unknown_field_dropped'): void {
  for (const u of list) report.push({ stage: rule === 'unknown_field_dropped' ? 'field_pruning' : 'normalization', rule, path: u.path });
}
