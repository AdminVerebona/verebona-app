/**
 * Diff de configuration — CDC BO IA VER-003 et WF-02.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « UN DIFF COMPLET AVEC L'ACTIVE » EST UNE CONDITION, PAS UN CONFORT
 *
 * Le VER-003 rend le diff obligatoire avant toute promotion. Le WF-02 précise
 * que les erreurs doivent être présentées « par traitement et par champ ».
 * Le diff est donc structuré de la même façon : un résultat par traitement,
 * chacun portant ses champs modifiés.
 *
 * Un diff textuel ligne à ligne, comme celui de `governance/diff.service.ts`,
 * ne conviendrait pas ici : il dirait qu'une accolade a bougé sans dire quel
 * modèle a changé. Le diff de prompt, lui, reste textuel — c'est le seul champ
 * dont la modification se lit ligne à ligne, et le service existant s'en charge.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * COMPARER DES LISTES SANS SE FIER À LEUR ORDRE
 *
 * Garde-fous et déclencheurs sont des listes. Les comparer par sérialisation
 * signalerait une modification dès qu'un administrateur réordonne l'affichage.
 * Ils sont donc comparés par code, ce qui distingue en plus les trois cas qui
 * intéressent vraiment : ajouté, retiré, modifié.
 */
import { TREATMENTS, type Treatment } from './treatments';
import {
  FIELD_LABELS,
  type ConfigFieldKey, type TreatmentConfig,
  type GuardrailSetting, type TriggerSetting,
} from './config-types';

export type ChangeKind = 'added' | 'removed' | 'modified';

export interface FieldChange {
  field: ConfigFieldKey;
  label: string;
  kind: ChangeKind;
  /** Rendu lisible, pour l'affichage. `null` = absent de ce côté. */
  before: string | null;
  after: string | null;
}

export interface TreatmentDiff {
  treatment: Treatment;
  changes: FieldChange[];
}

export interface ConfigDiff {
  treatments: TreatmentDiff[];
  /** Vrai quand rien n'a bougé : une promotion sans changement n'a pas de sens. */
  identical: boolean;
  changeCount: number;
}

/** Champs scalaires, comparés par égalité simple. */
const SCALAR_FIELDS: ConfigFieldKey[] = [
  'prompt', 'primaryModel', 'fallback1', 'fallback2',
  'reasoningPrimary', 'reasoningFallback1', 'reasoningFallback2',
  'maxOutputTokens',
];

function render(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function kindOf(before: unknown, after: unknown): ChangeKind {
  const avant = before !== null && before !== undefined && before !== '';
  const apres = after !== null && after !== undefined && after !== '';
  if (!avant && apres) return 'added';
  if (avant && !apres) return 'removed';
  return 'modified';
}

function diffScalars(base: TreatmentConfig, candidate: TreatmentConfig): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of SCALAR_FIELDS) {
    const before = base[field as keyof TreatmentConfig];
    const after = candidate[field as keyof TreatmentConfig];
    if (before === after) continue;
    out.push({
      field,
      label: FIELD_LABELS[field],
      kind: kindOf(before, after),
      before: render(before),
      after: render(after),
    });
  }
  return out;
}

/** Résumé lisible d'un garde-fou ou d'un déclencheur, pour l'affichage. */
function renderGuardrail(g: GuardrailSetting): string {
  return `${g.code} · seuil ${g.threshold} · ${g.reaction}`;
}

function renderTrigger(t: TriggerSetting): string {
  return `${t.code} · ${t.kind} · ${t.active ? 'actif' : 'inactif'}`;
}

/**
 * Compare deux listes par code, et non par position.
 *
 * Une comparaison positionnelle signalerait tout réordonnancement comme une
 * modification, et noierait le vrai changement dans le bruit.
 */
function diffByCode<T extends { code: string }>(
  field: ConfigFieldKey,
  before: T[],
  after: T[],
  show: (item: T) => string,
): FieldChange[] {
  const avant = new Map(before.map((x) => [x.code, x]));
  const apres = new Map(after.map((x) => [x.code, x]));
  const codes = [...new Set([...avant.keys(), ...apres.keys()])].sort();

  const out: FieldChange[] = [];
  for (const code of codes) {
    const a = avant.get(code);
    const b = apres.get(code);
    if (a && b && show(a) === show(b)) continue;
    out.push({
      field,
      label: `${FIELD_LABELS[field]} — ${code}`,
      kind: !a ? 'added' : !b ? 'removed' : 'modified',
      before: a ? show(a) : null,
      after: b ? show(b) : null,
    });
  }
  return out;
}

export function diffTreatment(base: TreatmentConfig, candidate: TreatmentConfig): TreatmentDiff {
  return {
    treatment: candidate.treatment,
    changes: [
      ...diffScalars(base, candidate),
      ...diffByCode('guardrails', base.guardrails, candidate.guardrails, renderGuardrail),
      ...diffByCode('triggers', base.triggers, candidate.triggers, renderTrigger),
      ...diffCascade(base, candidate),
    ],
  };
}

/**
 * Diff complet entre deux versions.
 *
 * Un traitement absent d'un côté est traité comme une configuration vide plutôt
 * qu'ignoré : une version à laquelle il manque un traitement est un défaut, et
 * le diff doit le rendre visible au lieu de le taire.
 */
export function diffVersions(
  base: TreatmentConfig[],
  candidate: TreatmentConfig[],
): ConfigDiff {
  const parBase = new Map(base.map((e) => [e.treatment, e]));
  const parCandidat = new Map(candidate.map((e) => [e.treatment, e]));

  const treatments: TreatmentDiff[] = [];
  let changeCount = 0;

  for (const t of TREATMENTS) {
    const a = parBase.get(t);
    const b = parCandidat.get(t);
    if (!a && !b) continue;

    const vide = { ...emptyFor(t) };
    const d = diffTreatment(a ?? vide, b ?? vide);
    if (d.changes.length === 0) continue;

    treatments.push(d);
    changeCount += d.changes.length;
  }

  return { treatments, identical: changeCount === 0, changeCount };
}

/**
 * La cascade est comparée champ à champ, et non comme un bloc.
 *
 * Un diff qui dirait « cascade modifiée » obligerait à ouvrir la version pour
 * savoir quel seuil a bougé — or c'est précisément ce chiffre qui décide de la
 * dépense.
 */
function diffCascade(base: TreatmentConfig, candidate: TreatmentConfig): FieldChange[] {
  const a = base.cascade;
  const b = candidate.cascade;
  if (!a && !b) return [];

  const champs = ['database', 'text', 'semantic', 'semanticEnabled'] as const;
  const libelles: Record<typeof champs[number], string> = {
    database: 'base structurée', text: 'recherche textuelle',
    semantic: 'recherche sémantique', semanticEnabled: 'niveau sémantique disponible',
  };

  const out: FieldChange[] = [];
  for (const champ of champs) {
    const avant = a ? a[champ] : undefined;
    const apres = b ? b[champ] : undefined;
    if (avant === apres) continue;
    out.push({
      field: 'cascade',
      label: `${FIELD_LABELS.cascade} — ${libelles[champ]}`,
      kind: kindOf(avant, apres),
      before: render(avant),
      after: render(apres),
    });
  }
  return out;
}

function emptyFor(treatment: Treatment): TreatmentConfig {
  return {
    treatment,
    prompt: '',
    primaryModel: null, fallback1: null, fallback2: null,
    reasoningPrimary: null, reasoningFallback1: null, reasoningFallback2: null,
    maxOutputTokens: null, guardrails: [], triggers: [], cascade: null,
  };
}

/** Rendu texte du diff, pour les journaux et l'export d'un package. */
export function renderDiff(diff: ConfigDiff): string {
  if (diff.identical) return 'Aucune modification.';
  return diff.treatments
    .map((t) => [
      `── ${t.treatment} ──`,
      ...t.changes.map((c) => {
        const signe = c.kind === 'added' ? '+' : c.kind === 'removed' ? '-' : '~';
        return `  ${signe} ${c.label} : ${c.before ?? '∅'} → ${c.after ?? '∅'}`;
      }),
    ].join('\n'))
    .join('\n\n');
}
