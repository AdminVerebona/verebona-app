/**
 * SignalCollector, partie pure — CDC Mascotte §7 (catalogue V1 des signaux).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE CATALOGUE EST FERMÉ
 *
 * Chaque sujet possible est construit ici, par une fonction nommée d'après son
 * code. Un état qui n'a pas de ligne dans ce fichier ne devient jamais un
 * message de la mascotte (§7) : ni « votre dossier est complet », ni « vous
 * pouvez exporter » (REC-003).
 *
 * Les données viennent des sources de vérité existantes (collector.ts) : la
 * file « À traiter » telle que son service la rend, l'agenda tel que T4 l'a
 * construit. Rien n'est réévalué ici (GEN-003, ATP-002, DAT-008) — on
 * traduit un état déjà décidé en sujet présentable.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { ToProcessActionView } from '@/services/to-process/to-process-query.service';
import type { MascotAction, MascotFamily, MascotSubject } from './types';
import { MAX_ACTIONS_PER_SUBJECT } from './types';

export interface MascotDocRow { id: number; title: string; at: string }
export interface MascotExportRow { id: number; exportType: string; assetId: number; assetName: string; at: string }
export interface MascotAgendaRow {
  id: number;
  title: string;
  /** AAAA-MM-JJ */
  date: string | null;
  /** Occurrence prévisionnelle (DAT-002) : jamais présentée comme certaine. */
  forecast: boolean;
  /** Échéance à préciser avant de pouvoir être suivie (dépendance, MASC-BLOCKED). */
  requiresQualification: boolean;
  assetId: number | null;
  assetName: string | null;
}

/**
 * Données brutes, source par source. `null` = source indisponible : la
 * mascotte ne déduit jamais une absence d'une panne (§20, ERR-01).
 */
export interface MascotRawData {
  accountId: number;
  /** AAAA-MM-JJ, Europe/Paris. */
  today: string;
  processing: { uploads: MascotDocRow[]; analyses: MascotDocRow[]; exports: MascotExportRow[] } | null;
  onboarding: { activeAssets: Array<{ id: number; name: string }>; activeAssetCount: number; documentCount: number } | null;
  toProcess: ToProcessActionView[] | null;
  /** Échéances « action » actives (ni réalisées, ni annulées), horizon borné. */
  agenda: MascotAgendaRow[] | null;
  /** Acquittements « C'est fait » actifs du compte. */
  acknowledgments: Array<{ occurrenceKey: string; cycleKey: string }> | null;
}

export interface MascotCandidates {
  /** Dans l'ordre de la hiérarchie, puis dans l'ordre interne de chaque famille. */
  candidates: MascotSubject[];
  /** Une source au moins n'a pas pu être lue. */
  degraded: boolean;
  /** Faits d'éligibilité des questions T2 (annexe B). */
  hints: {
    hasToProcess: boolean;
    hasFutureDate: boolean;
    hasDocuments: boolean;
    hasProcessing: boolean;
  };
}

// ── Formats ──────────────────────────────────────────────────────────────────

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
  'septembre', 'octobre', 'novembre', 'décembre'];

/** « 25 septembre 2026 » — toujours absolue (DAT-005, T6-008). */
export function formatDateFr(day: string): string {
  const [y, m, d] = day.slice(0, 10).split('-').map(Number);
  return `${d === 1 ? '1er' : d} ${MOIS[m - 1]} ${y}`;
}

const q = (s: string) => `« ${s} »`;

const EXPORT_LABELS: Record<string, string> = {
  ASSET_SHEET: 'fiche du bien',
  CIL: 'carnet d’information du logement',
  DOSSIER: 'dossier du bien',
};

const action = (actionId: string, label: string, target: MascotAction['target']): MascotAction =>
  ({ actionId, label, target });

function subject(
  family: MascotFamily,
  s: Omit<MascotSubject, 'sourceFamily' | 'actions'> & { actions: MascotAction[] },
): MascotSubject {
  return { ...s, sourceFamily: family, actions: s.actions.slice(0, MAX_ACTIONS_PER_SUBJECT) };
}

// ── 1. Traitements en cours ──────────────────────────────────────────────────

function processingSubjects(raw: MascotRawData): MascotSubject[] {
  const p = raw.processing;
  if (!p) return [];
  const out: Array<MascotSubject & { at: string }> = [];

  const docSubject = (
    code: 'PROC-DOC-UPLOAD' | 'PROC-DOC-ANALYSIS',
    rows: MascotDocRow[],
    enCours: string,
  ) => {
    if (rows.length === 0) return;
    const latest = [...rows].sort((a, b) => b.at.localeCompare(a.at))[0];
    const n = rows.length;
    const texte = n === 1
      ? `Le document ${q(latest.title)} est en cours ${enCours}.`
      : `${n} documents sont en cours ${enCours}, dont ${q(latest.title)}.`;
    out.push({
      ...subject('PROCESSING', {
        subjectId: `${code}:${latest.id}`,
        sourceCode: code,
        accountId: raw.accountId,
        targetType: 'DOCUMENT', targetId: latest.id,
        priority: null, requiresAttention: false, intent: 'inform',
        facts: { documentTitle: latest.title, documentCount: n, state: code === 'PROC-DOC-UPLOAD' ? 'envoi' : 'analyse' },
        actions: [action(`${code}:open`, 'Voir le document', {
          kind: 'drawer', drawer: 'document', id: latest.id,
        })],
        fallbackText: texte,
        allowedHighlight: latest.title,
        occurrenceKey: `${code}:${latest.id}`,
        dedupeKeys: [`document:${latest.id}`],
        secondaryLabel: `Voir ${q(latest.title)}`,
      }),
      at: latest.at,
    });
  };

  docSubject('PROC-DOC-UPLOAD', p.uploads, 'd’envoi');
  docSubject('PROC-DOC-ANALYSIS', p.analyses, 'd’analyse');

  if (p.exports.length > 0) {
    const e = [...p.exports].sort((a, b) => b.at.localeCompare(a.at))[0];
    const libelle = EXPORT_LABELS[e.exportType] ?? 'export';
    out.push({
      ...subject('PROCESSING', {
        subjectId: `PROC-EXPORT:${e.id}`,
        sourceCode: 'PROC-EXPORT',
        accountId: raw.accountId,
        targetType: 'EXPORT', targetId: e.id,
        priority: null, requiresAttention: false, intent: 'inform',
        facts: { exportLabel: libelle, assetName: e.assetName },
        actions: [action('PROC-EXPORT:open', 'Voir les exports', {
          kind: 'route', href: `/assets/${e.assetId}?tab=exports`,
        })],
        fallbackText: `L’export ${q(libelle)} de ${e.assetName} est en cours de préparation.`,
        allowedHighlight: e.assetName,
        occurrenceKey: `PROC-EXPORT:${e.id}`,
        dedupeKeys: [`export:${e.id}`],
        secondaryLabel: 'Voir les exports',
        assetId: e.assetId, assetName: e.assetName,
      }),
      at: e.at,
    });
  }

  // SEL-005 : le plus récent d'abord — celui que l'action de l'utilisateur
  // vient de déclencher.
  return out.sort((a, b) => b.at.localeCompare(a.at)).map(({ at: _at, ...s }) => s);
}

// ── 2. Onboarding (§8) ───────────────────────────────────────────────────────

/** Étape d'onboarding active, ou null. Une seule à la fois (ONB-003). */
export function onboardingStep(raw: MascotRawData): 'ONB-ASSET' | 'ONB-DOC' | null {
  const o = raw.onboarding;
  if (!o) return null;
  if (o.activeAssetCount === 0) return 'ONB-ASSET';
  if (o.documentCount === 0) return 'ONB-DOC';
  return null;
}

function onboardingSubjects(raw: MascotRawData): MascotSubject[] {
  const step = onboardingStep(raw);
  if (!step) return [];
  if (step === 'ONB-ASSET') {
    return [subject('ONBOARDING', {
      subjectId: 'ONB-ASSET',
      sourceCode: 'ONB-ASSET',
      accountId: raw.accountId,
      priority: null, requiresAttention: true, intent: 'onboard',
      facts: { step: 1, stepCount: 2, goal: 'ajouter un premier bien' },
      actions: [action('ONB-ASSET:create', 'Ajouter un bien', { kind: 'create_asset' })],
      fallbackText: 'Pour commencer, ajoutez votre premier bien : un logement, un véhicule ou un objet.',
      allowedHighlight: 'ajoutez votre premier bien',
      occurrenceKey: 'ONB-ASSET',
      dedupeKeys: ['onboarding'],
      secondaryLabel: 'Ajouter un bien',
    })];
  }
  const seul = raw.onboarding!.activeAssets.length === 1 ? raw.onboarding!.activeAssets[0] : null;
  return [subject('ONBOARDING', {
    subjectId: 'ONB-DOC',
    sourceCode: 'ONB-DOC',
    accountId: raw.accountId,
    priority: null, requiresAttention: true, intent: 'onboard',
    facts: { step: 2, stepCount: 2, goal: 'ajouter un premier document', assetName: seul?.name ?? null },
    actions: [action('ONB-DOC:upload', 'Ajouter un document', { kind: 'upload_document', assetId: seul?.id ?? null })],
    fallbackText: seul
      ? `Ajoutez maintenant votre premier document pour ${seul.name} : une facture, un contrat ou une garantie.`
      : 'Ajoutez maintenant votre premier document : une facture, un contrat ou une garantie.',
    allowedHighlight: 'votre premier document',
    occurrenceKey: 'ONB-DOC',
    dedupeKeys: ['onboarding'],
    secondaryLabel: 'Ajouter un document',
    assetId: seul?.id ?? null, assetName: seul?.name ?? null,
  })];
}

// ── 3. À traiter (§9) ────────────────────────────────────────────────────────

const PRIORITY_RANK = { DO_FIRST: 0, DO_NEXT: 1, CAN_WAIT: 2 } as const;

function toProcessSubjects(raw: MascotRawData): MascotSubject[] {
  // L'ordre est celui du service source (ATP-003, SEL-004) : il est conservé
  // tel quel, sans score concurrent.
  return (raw.toProcess ?? []).map((a) => {
    const cible = a.target.label;
    const bien = a.target.assetName && a.target.assetName !== cible ? a.target.assetName : null;
    const contexte = bien ? `${q(cible)} (${bien})` : q(cible);
    const verbe = a.actionKind === 'ARBITRATE' ? 'Choisir' : 'Compléter';
    const dedupe = [`to_process:${a.publicId}`];
    if (a.targetType === 'AGENDA_ITEM') dedupe.push(`agenda:${a.targetId}`);
    if (a.targetType === 'DOCUMENT') dedupe.push(`document-action:${a.targetId}`);
    return subject('TO_PROCESS', {
      subjectId: `ATP:${a.publicId}`,
      sourceCode: `ATP-${a.ruleCode}`,
      accountId: raw.accountId,
      targetType: a.targetType, targetId: a.targetId,
      priority: a.priority, requiresAttention: true, intent: 'act',
      facts: { question: a.question, targetLabel: cible, assetName: bien, actionKind: a.actionKind === 'ARBITRATE' ? 'arbitrage' : 'complément' },
      actions: [action(`ATP:${a.publicId}:open`, verbe, {
        kind: 'to_process', publicId: a.publicId, targetType: a.targetType, targetId: a.targetId,
        targetPublicId: a.target.publicId ?? null, field: a.fieldKey ?? a.relationKey ?? null,
      })],
      fallbackText: `${a.question} Cela concerne ${contexte}.`,
      allowedHighlight: cible,
      occurrenceKey: `ATP:${a.publicId}`,
      dedupeKeys: dedupe,
      secondaryLabel: `${verbe} ${q(cible)}`,
      assetId: a.target.assetId ?? null, assetName: a.target.assetName ?? null,
    });
  });
}

// ── 4. Prochaine date (§10) ──────────────────────────────────────────────────

/** Échéances déjà portées par une action « À traiter » : jamais en double (ATP-004). */
function agendaInToProcess(raw: MascotRawData): Set<number> {
  return new Set((raw.toProcess ?? []).filter((a) => a.targetType === 'AGENDA_ITEM').map((a) => a.targetId));
}

function dateSubjects(raw: MascotRawData): MascotSubject[] {
  const exclues = agendaInToProcess(raw);
  const futures = (raw.agenda ?? [])
    .filter((i) => i.date && i.date > raw.today && !exclues.has(i.id) && !i.requiresQualification)
    .sort((a, b) => a.date!.localeCompare(b.date!) || a.id - b.id);
  if (futures.length === 0) return [];

  const premiere = futures[0];
  const memeJour = futures.filter((i) => i.date === premiere.date).slice(0, 2);
  const date = formatDateFr(premiere.date!);
  const out: MascotSubject[] = [];

  const voir = (i: MascotAgendaRow, label: string) => action(`DATE:${i.id}:open`, label, {
    kind: 'drawer', drawer: 'echeance', id: i.id, mode: 'view',
  });

  if (memeJour.length === 2) {
    // DATE-NEXT-2 (DAT-004) : un seul sujet composé, qui ne consomme qu'une place.
    const [a, b] = memeJour;
    const prevision = a.forecast || b.forecast;
    out.push(subject('DATE', {
      subjectId: `DATE-NEXT-2:${a.id}:${b.id}`,
      sourceCode: 'DATE-NEXT-2',
      accountId: raw.accountId,
      priority: null, requiresAttention: false, intent: 'deadline',
      facts: {
        date: premiere.date!, dateLabel: date,
        dateNature: prevision ? 'prévisionnelle' : 'confirmée',
        firstTitle: a.title, firstAssetName: a.assetName,
        secondTitle: b.title, secondAssetName: b.assetName,
      },
      actions: [voir(a, `Voir ${q(a.title)}`), voir(b, `Voir ${q(b.title)}`)],
      fallbackText: prevision
        ? `Deux échéances sont prévues autour du ${date} (date estimée) : ${q(a.title)} et ${q(b.title)}.`
        : `Deux échéances tombent le ${date} : ${q(a.title)} et ${q(b.title)}.`,
      allowedHighlight: date,
      occurrenceKey: `DATE-NEXT-2:${a.id}:${b.id}`,
      dedupeKeys: [`agenda:${a.id}`, `agenda:${b.id}`, 'date-next'],
      secondaryLabel: `Voir ${q(a.title)}`,
      assetId: a.assetId && a.assetId === b.assetId ? a.assetId : null,
      assetName: a.assetId && a.assetId === b.assetId ? a.assetName : null,
    }));
  } else {
    const i = premiere;
    const pour = i.assetName ? ` pour ${i.assetName}` : '';
    out.push(subject('DATE', {
      subjectId: `DATE-NEXT:${i.id}`,
      sourceCode: 'DATE-NEXT',
      accountId: raw.accountId,
      targetType: 'AGENDA_ITEM', targetId: i.id,
      priority: null, requiresAttention: false, intent: 'deadline',
      facts: {
        title: i.title, date: i.date!, dateLabel: date,
        dateNature: i.forecast ? 'prévisionnelle' : 'confirmée', assetName: i.assetName,
      },
      actions: [voir(i, 'Voir l’échéance')],
      // DAT-003 : une date prévisionnelle n'est jamais présentée comme certaine.
      fallbackText: i.forecast
        ? `Votre prochaine échéance, ${q(i.title)}${pour}, est prévue autour du ${date} (date estimée).`
        : `Votre prochaine échéance est ${q(i.title)}${pour}, le ${date}.`,
      allowedHighlight: date,
      occurrenceKey: `DATE-NEXT:${i.id}`,
      dedupeKeys: [`agenda:${i.id}`, 'date-next'],
      secondaryLabel: 'Voir la prochaine échéance',
      assetId: i.assetId, assetName: i.assetName,
    }));
  }
  return out;
}

// ── 5. Recommandations propres à la mascotte (§11, annexe A) ─────────────────

/** Au-delà, une action passée relève de l'agenda, plus d'un rappel d'accueil. */
export const EXT_ACTION_LOOKBACK_DAYS = 60;

export function extActionOccurrenceKey(agendaItemId: number): string {
  return `MASC-EXT-ACTION:agenda:${agendaItemId}`;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function mascotRuleSubjects(raw: MascotRawData): MascotSubject[] {
  const exclues = agendaInToProcess(raw);
  const acquittes = new Set((raw.acknowledgments ?? []).map((a) => `${a.occurrenceKey}|${a.cycleKey}`));
  const echues = (raw.agenda ?? [])
    .filter((i) => i.date && i.date <= raw.today && !i.forecast && !exclues.has(i.id)
      && daysBetween(i.date, raw.today) <= EXT_ACTION_LOOKBACK_DAYS)
    .sort((a, b) => a.date!.localeCompare(b.date!) || a.id - b.id);

  const out: MascotSubject[] = [];
  for (const i of echues) {
    const date = formatDateFr(i.date!);
    const pour = i.assetName ? ` pour ${i.assetName}` : '';
    const voir = action(`MASC:${i.id}:open`, 'Voir', { kind: 'drawer', drawer: 'echeance', id: i.id, mode: 'view' });

    // MASC-BLOCKED (REC-004) : l'échéance doit d'abord être précisée. Seule la
    // dépendance est recommandée — jamais « C'est fait » sur un objet flou.
    if (i.requiresQualification) {
      out.push(subject('MASCOT_RULE', {
        subjectId: `MASC-BLOCKED:${i.id}`,
        sourceCode: 'MASC-BLOCKED',
        accountId: raw.accountId,
        targetType: 'AGENDA_ITEM', targetId: i.id,
        priority: 'DO_NEXT', requiresAttention: true, intent: 'act',
        facts: { title: i.title, date: i.date!, dateLabel: date, assetName: i.assetName, dependency: 'préciser l’échéance' },
        actions: [action(`MASC-BLOCKED:${i.id}:qualify`, 'Préciser l’échéance', {
          kind: 'drawer', drawer: 'echeance', id: i.id, mode: 'edit',
        })],
        fallbackText: `L’échéance ${q(i.title)}${pour} du ${date} doit être précisée avant de pouvoir être suivie.`,
        allowedHighlight: i.title,
        occurrenceKey: `MASC-BLOCKED:agenda:${i.id}`,
        dedupeKeys: [`agenda:${i.id}`],
        secondaryLabel: `Préciser ${q(i.title)}`,
        assetId: i.assetId, assetName: i.assetName,
      }));
      continue;
    }

    // MASC-EXT-ACTION : action externe arrivée à date, que Verebona ne peut
    // pas constater (DONE-001). Le cycle est la date : une nouvelle date est
    // une nouvelle occurrence (DONE-002, DONE-005).
    const occurrenceKey = extActionOccurrenceKey(i.id);
    const cycleKey = i.date!;
    if (acquittes.has(`${occurrenceKey}|${cycleKey}`)) continue;
    const passee = i.date! < raw.today;
    out.push(subject('MASCOT_RULE', {
      subjectId: `MASC-EXT-ACTION:${i.id}`,
      sourceCode: 'MASC-EXT-ACTION',
      accountId: raw.accountId,
      targetType: 'AGENDA_ITEM', targetId: i.id,
      priority: 'DO_NEXT', requiresAttention: true, intent: 'act',
      facts: { title: i.title, date: i.date!, dateLabel: date, assetName: i.assetName, dateState: passee ? 'passée' : 'du jour' },
      actions: [voir, action(`MASC-EXT-ACTION:${i.id}:done`, 'C’est fait', {
        kind: 'done', occurrenceKey, cycleKey,
      })],
      fallbackText: passee
        ? `L’échéance ${q(i.title)}${pour} était prévue le ${date}. Si c’est fait, vous pouvez l’indiquer.`
        : `L’échéance ${q(i.title)}${pour} est prévue le ${date}. Une fois que c’est fait, vous pouvez l’indiquer.`,
      allowedHighlight: i.title,
      occurrenceKey,
      dedupeKeys: [`agenda:${i.id}`],
      secondaryLabel: `${i.title} : c’est fait ?`,
      assetId: i.assetId, assetName: i.assetName,
    }));
  }
  // Même référentiel que « À traiter » : priorité, puis ancienneté.
  return out.sort((a, b) => PRIORITY_RANK[a.priority ?? 'CAN_WAIT'] - PRIORITY_RANK[b.priority ?? 'CAN_WAIT']);
}

// ── Assemblage ───────────────────────────────────────────────────────────────

export function buildCandidates(raw: MascotRawData): MascotCandidates {
  const candidates = [
    ...processingSubjects(raw),
    ...onboardingSubjects(raw),
    ...toProcessSubjects(raw),
    ...dateSubjects(raw),
    ...mascotRuleSubjects(raw),
  ];
  const degraded = raw.processing === null || raw.onboarding === null || raw.toProcess === null
    || raw.agenda === null || raw.acknowledgments === null;
  const exclues = agendaInToProcess(raw);
  return {
    candidates,
    degraded,
    hints: {
      hasToProcess: (raw.toProcess?.length ?? 0) > 0,
      hasFutureDate: (raw.agenda ?? []).some((i) => i.date && i.date > raw.today && !exclues.has(i.id)),
      hasDocuments: (raw.onboarding?.documentCount ?? 0) > 0,
      hasProcessing: !!raw.processing && (raw.processing.uploads.length + raw.processing.analyses.length) > 0,
    },
  };
}
