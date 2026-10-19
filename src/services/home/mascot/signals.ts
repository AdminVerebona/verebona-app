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
import type { MascotAction, MascotFamily, MascotInterpellation, MascotPriority, MascotReminderRef, MascotSubject } from './types';
import { MAX_ACTIONS_PER_SUBJECT } from './types';
import type { AgendaDateRole } from '@/services/agenda/agenda-date-role';
import { deadlineBlockedText, deadlineButtonLabel, deadlineExtActionText, deadlineNextText, deadlineReminderText } from './deadline-label';
import { actionIsDistinct, actionSentence } from './t6-interpellation';

export interface MascotDocRow { id: number; title: string; at: string }
export interface MascotExportRow { id: number; exportType: string; assetId: number; assetName: string; at: string }
export interface MascotAgendaRow {
  id: number;
  title: string;
  /** AAAA-MM-JJ */
  date: string | null;
  /** Occurrence prévisionnelle (DAT-002) : jamais présentée comme certaine. */
  forecast: boolean;
  /**
   * Lot 50 : date à respecter (`DEADLINE`, action à prévoir) ou événement
   * réellement planifié (`SCHEDULED_EVENT`) — `agendaDateRole`, données
   * structurées. Distinct de `forecast` (certitude de la date). Absent :
   * DEADLINE (jamais présenté comme organisé par défaut).
   */
  dateRole?: AgendaDateRole;
  /** Échéance à préciser avant de pouvoir être suivie (dépendance, MASC-BLOCKED). */
  requiresQualification: boolean;
  assetId: number | null;
  assetName: string | null;
  /**
   * Famille (`assets.category`) et catégorie (`assets.subtype`) du bien —
   * lot 31 : seules données qui autorisent « de la Cupra » dans le texte
   * d'une échéance (genre du référentiel). Absentes : formulation neutre.
   */
  assetCategory?: string | null;
  assetSubtype?: string | null;
  /** Lot 60 : série de l'occurrence (`agenda_items.series_key`), portée « série » des rappels. */
  seriesKey?: string | null;
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
  /**
   * Nombre total d'actions actives de la file (lot 32, MASC2) — le MÊME que
   * la pastille du menu et l'en-tête de la page (`getToProcessPage().total`).
   * Absent : la longueur de `toProcess`.
   */
  toProcessTotal?: number | null;
  /** Échéances « action » actives (ni réalisées, ni annulées), horizon borné. */
  agenda: MascotAgendaRow[] | null;
  /** Acquittements « C'est fait » actifs du compte. */
  acknowledgments: Array<{ occurrenceKey: string; cycleKey: string }> | null;
  /**
   * Échéances portées par une action « À traiter » ouverte, au-delà des
   * seules actions lues (la lecture de la file est bornée, NFR-001) : aucune
   * ne doit revenir en « prochaine date » (ATP-004). Absent : déduit de
   * `toProcess`.
   */
  toProcessAgendaIds?: number[] | null;
  /**
   * Lot 61 (cohérence T6 / « À traiter ») : échéances PASSÉES issues d'un
   * document dont le moteur « À traiter » a décidé qu'aucune intervention
   * n'est attendue (information historique), ou dont l'intervention a été
   * tranchée par l'utilisateur (« C'est fait », « Pas nécessaire »). T6 ne
   * les relance pas (sujet clos) : jamais une relance qui contredit une
   * décision « À traiter ». Une échéance FUTURE n'est jamais concernée (un
   * report de carte n'est pas un rappel).
   */
  toProcessSettledAgendaIds?: number[] | null;
  /**
   * Offre et droits du compte (REC-005). Absent ou `null` (lecture en échec) :
   * aucune restriction n'est présumée — le parcours cible reste gardé côté
   * serveur (quota, lecture seule).
   */
  rights?: MascotRights | null;
  /**
   * Lot 53 (D25) : échéances « action » ouvertes à date dépassée, SANS la
   * fenêtre des sujets (identifiants et dates seuls, bornés). Absent :
   * non lu (comportement antérieur) ; `null` : lecture en échec (dégradé).
   */
  overdueAgenda?: Array<{ id: number; date: string }> | null;
}

/** Droits utiles aux recommandations (REC-005). */
export interface MascotRights {
  /** Écriture autorisée (compte ni en lecture seule, ni restreint). */
  canWrite: boolean;
  /** Un bien peut être ajouté (écriture + quota de biens non atteint). */
  canAddAsset: boolean;
  /** Un document peut être ajouté (écriture + quota documentaire non atteint). */
  canAddDocument: boolean;
}

/**
 * Droits à partir des droits effectifs et des volumes du compte — mêmes
 * règles que les gardes serveur (`canCreateAsset`, `canAddDocument`).
 */
export function mascotRightsFrom(
  ent: { canWrite: boolean; quotas: { maxAssets: number; maxDocuments: number } },
  counts: { assets: number; documents: number },
): MascotRights {
  return {
    canWrite: ent.canWrite,
    canAddAsset: ent.canWrite && counts.assets < ent.quotas.maxAssets,
    canAddDocument: ent.canWrite && counts.documents < ent.quotas.maxDocuments,
  };
}

export interface MascotCandidates {
  /** Dans l'ordre de la hiérarchie, puis dans l'ordre interne de chaque famille. */
  candidates: MascotSubject[];
  /** Une source au moins n'a pas pu être lue. */
  degraded: boolean;
  // Lot 34 : plus de « faits d'éligibilité » des questions T2 ici
  // (`hasToProcess`…) — les questions viennent du catalogue unique
  // (`capability-registry`), avec ses préconditions explicites.
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
        // Lot 55A : intitulé, la carte porte déjà « Voir → ».
        secondaryLabel: latest.title,
        tileTitle: latest.title,
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
        secondaryLabel: `Export ${q(libelle)}`,
        tileTitle: libelle.charAt(0).toLocaleUpperCase('fr') + libelle.slice(1),
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
  // REC-005 : jamais « Ajouter un bien / un document » si l'offre ou les
  // droits du compte le refuseraient (lecture seule, quota atteint). Pas
  // d'upsell (hors périmètre) : l'étape est simplement tue.
  if (step === 'ONB-ASSET' && raw.rights && !raw.rights.canAddAsset) return [];
  if (step === 'ONB-DOC' && raw.rights && !raw.rights.canAddDocument) return [];
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
//
// Lot 32 (ticket MASC2) : les actions « À traiter » ne sont plus des SUJETS
// du discours (ni paragraphe T6, ni tuile, ni pastille « Compléter “…” ») :
// elles forment le niveau 2 de la bulle, construit directement à partir de la
// file (`todo-items.ts`, `MascotPresentation.todo`). La phrase de niveau 1 les
// compte sans les répéter. Le moteur ne garde de la file que ce qui sert à
// écarter les doublons (échéances déjà portées par une action, ATP-004) et
// l'éligibilité de la question « Que dois-je faire aujourd'hui ? ».

const PRIORITY_RANK = { DO_FIRST: 0, DO_NEXT: 1, CAN_WAIT: 2 } as const;

// ── 4. Prochaine date (§10) ──────────────────────────────────────────────────

/** Échéances déjà portées par une action « À traiter » : jamais en double (ATP-004). */
function agendaInToProcess(raw: MascotRawData): Set<number> {
  const ids = new Set((raw.toProcess ?? []).filter((a) => a.targetType === 'AGENDA_ITEM').map((a) => a.targetId));
  (raw.toProcessAgendaIds ?? []).forEach((id) => ids.add(id));
  return ids;
}

/** Lot 50 : rôle de la date d'une échéance lue (absent → DEADLINE). */
export const roleOf = (i: Pick<MascotAgendaRow, 'dateRole' | 'forecast'>): AgendaDateRole =>
  i.forecast ? 'DEADLINE' : i.dateRole ?? 'DEADLINE';

/** DATE-NEXT d'une échéance (pur) — historique et lot 60 (sujets décidés). */
function dateNextSubject(raw: MascotRawData, i: MascotAgendaRow, opts: { dedupeDateNext?: boolean } = {}): MascotSubject {
  const date = formatDateFr(i.date!);
  return subject('DATE', {
    subjectId: `DATE-NEXT:${i.id}`,
    sourceCode: 'DATE-NEXT',
    accountId: raw.accountId,
    targetType: 'AGENDA_ITEM', targetId: i.id,
    priority: null, requiresAttention: false, intent: 'deadline',
    facts: {
      title: i.title, date: i.date!, dateLabel: date,
      dateNature: i.forecast ? 'prévisionnelle' : 'confirmée', assetName: i.assetName,
      // Lot 50 : DEADLINE (date à respecter, action à prévoir) ou
      // SCHEDULED_EVENT (événement planifié) — jamais déduit du titre.
      dateRole: roleOf(i),
    },
    actions: [action(`DATE:${i.id}:open`, 'Voir l’échéance', { kind: 'drawer', drawer: 'echeance', id: i.id, mode: 'view' })],
    // Lot 31 (T6) : libellé naturel, jamais le titre technique brut ; le
    // texte doit être présentable tel quel si T6 ne s'exécute pas.
    // DAT-003 : une date prévisionnelle n'est jamais présentée comme certaine.
    fallbackText: deadlineNextText({ ...i, dateRole: roleOf(i) }, date),
    allowedHighlight: date,
    occurrenceKey: `DATE-NEXT:${i.id}`,
    // Lot 60 : plusieurs échéances décidées peuvent être présentées, chacune
    // sur sa carte — la clé « date-next » ne sert qu'au chemin historique.
    dedupeKeys: opts.dedupeDateNext === false ? [`agenda:${i.id}`] : [`agenda:${i.id}`, 'date-next'],
    // Lot 55A : intitulé métier (« Contrôle technique »), jamais « Voir l'échéance ».
    secondaryLabel: deadlineButtonLabel(i),
    tileTitle: deadlineButtonLabel(i),
    assetId: i.assetId, assetName: i.assetName,
  });
}

function dateSubjects(raw: MascotRawData): MascotSubject[] {
  const exclues = agendaInToProcess(raw);
  const futures = (raw.agenda ?? [])
    .filter((i) => i.date && i.date > raw.today && !exclues.has(i.id) && !i.requiresQualification)
    .sort((a, b) => a.date!.localeCompare(b.date!) || a.id - b.id);
  if (futures.length === 0) return [];

  // Lot 61 : plus de sujet composé DATE-NEXT-2 (DAT-004) — deux échéances
  // du même jour gardent chacune leur identifiant, leur intitulé, leur date,
  // leur action « Voir » et leur décision de rappel : deux cartes distinctes
  // (au plus deux, la place des sujets restant bornée par le sélecteur).
  const premiere = futures[0];
  const memeJour = futures.filter((i) => i.date === premiere.date).slice(0, 2);
  return memeJour.length === 2
    ? memeJour.map((i) => dateNextSubject(raw, i, { dedupeDateNext: false }))
    : [dateNextSubject(raw, premiere)];
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

/** MASC-BLOCKED d'une échéance à préciser (pur). */
function blockedSubject(raw: MascotRawData, i: MascotAgendaRow): MascotSubject {
  const date = formatDateFr(i.date!);
  return subject('MASCOT_RULE', {
    subjectId: `MASC-BLOCKED:${i.id}`,
    sourceCode: 'MASC-BLOCKED',
    accountId: raw.accountId,
    targetType: 'AGENDA_ITEM', targetId: i.id,
    priority: 'DO_NEXT', requiresAttention: true, intent: 'act',
    facts: { title: i.title, date: i.date!, dateLabel: date, assetName: i.assetName, dependency: 'préciser l’échéance' },
    actions: [action(`MASC-BLOCKED:${i.id}:qualify`, 'Préciser l’échéance', {
      kind: 'drawer', drawer: 'echeance', id: i.id, mode: 'edit',
    })],
    // Décision PO 20 (lot 32) : libellé naturel, jamais le titre technique.
    fallbackText: deadlineBlockedText(i, date),
    allowedHighlight: date,
    occurrenceKey: `MASC-BLOCKED:agenda:${i.id}`,
    dedupeKeys: [`agenda:${i.id}`],
    secondaryLabel: `Préciser ${q(deadlineButtonLabel(i))}`,
    assetId: i.assetId, assetName: i.assetName,
  });
}

/**
 * MASC-EXT-ACTION : action externe arrivée à date, que Verebona ne peut pas
 * constater (DONE-001). Le cycle est la date : une nouvelle date est une
 * nouvelle occurrence (DONE-002, DONE-005). Pur.
 */
function extActionSubject(raw: MascotRawData, i: MascotAgendaRow): MascotSubject {
  const date = formatDateFr(i.date!);
  const voir = action(`MASC:${i.id}:open`, 'Voir', { kind: 'drawer', drawer: 'echeance', id: i.id, mode: 'view' });
  const occurrenceKey = extActionOccurrenceKey(i.id);
  const cycleKey = i.date!;
  const passee = i.date! < raw.today;
  return subject('MASCOT_RULE', {
    subjectId: `MASC-EXT-ACTION:${i.id}`,
    sourceCode: 'MASC-EXT-ACTION',
    accountId: raw.accountId,
    targetType: 'AGENDA_ITEM', targetId: i.id,
    priority: 'DO_NEXT', requiresAttention: true, intent: 'act',
    facts: { title: i.title, date: i.date!, dateLabel: date, assetName: i.assetName, dateState: passee ? 'passée' : 'du jour', dateRole: roleOf(i) },
    actions: [voir, action(`MASC-EXT-ACTION:${i.id}:done`, 'C’est fait', {
      kind: 'done', occurrenceKey, cycleKey,
    })],
    // Décision PO 20 (lot 32) : libellé naturel, jamais le titre technique.
    fallbackText: deadlineExtActionText(i, date, passee),
    allowedHighlight: date,
    occurrenceKey,
    dedupeKeys: [`agenda:${i.id}`],
    secondaryLabel: `${deadlineButtonLabel(i)} : c’est fait ?`,
    // Lot 61 : intitulé métier de la carte quand l'échéance est retenue par
    // une décision IA (« Ramonage », jamais « Confirmer ou reporter »).
    tileTitle: deadlineButtonLabel(i),
    assetId: i.assetId, assetName: i.assetName,
  });
}

function mascotRuleSubjects(raw: MascotRawData): MascotSubject[] {
  // REC-005 : « C'est fait » et « Préciser l'échéance » écrivent ; un compte
  // en lecture seule se les verrait refuser — aucune recommandation propre.
  if (raw.rights && !raw.rights.canWrite) return [];
  const exclues = agendaInToProcess(raw);
  const acquittes = new Set((raw.acknowledgments ?? []).map((a) => `${a.occurrenceKey}|${a.cycleKey}`));
  const echues = (raw.agenda ?? [])
    .filter((i) => i.date && i.date <= raw.today && !i.forecast && !exclues.has(i.id)
      && daysBetween(i.date, raw.today) <= EXT_ACTION_LOOKBACK_DAYS)
    .sort((a, b) => a.date!.localeCompare(b.date!) || a.id - b.id);

  const out: MascotSubject[] = [];
  for (const i of echues) {
    // MASC-BLOCKED (REC-004) : l'échéance doit d'abord être précisée. Seule la
    // dépendance est recommandée — jamais « C'est fait » sur un objet flou.
    if (i.requiresQualification) { out.push(blockedSubject(raw, i)); continue; }
    // MASC-EXT-ACTION : action externe arrivée à date (DONE-001) ; une
    // occurrence déjà déclarée faite (même cycle) n'est plus proposée.
    if (acquittes.has(`${extActionOccurrenceKey(i.id)}|${i.date!}`)) continue;
    out.push(extActionSubject(raw, i));
  }
  // Même référentiel que « À traiter » : priorité, puis ancienneté.
  return out.sort((a, b) => PRIORITY_RANK[a.priority ?? 'CAN_WAIT'] - PRIORITY_RANK[b.priority ?? 'CAN_WAIT']);
}

// ── Assemblage ───────────────────────────────────────────────────────────────

/**
 * Lot 53 (D25) : nombre d'échéances dépassées encore ouvertes — hors celles
 * (lot 61 : donnée de SUPERVISION ; elle ne déclenche plus aucune phrase)
 * que l'utilisateur a déclarées faites (« C'est fait », même cycle). `null` :
 * inconnu (lecture absente ou en échec). Pure.
 */
export function openOverdueCount(raw: MascotRawData, notInterpellated?: ReadonlySet<number>): number | null {
  if (raw.overdueAgenda === undefined || raw.overdueAgenda === null) return null;
  const acquittes = new Set((raw.acknowledgments ?? []).map((a) => `${a.occurrenceKey}|${a.cycleKey}`));
  // Lot 60 : une échéance dépassée ÉCARTÉE ou DIFFÉRÉE par la décision T6
  // (aucune action restante, report ou refus de l'utilisateur) ne réapparaît
  // pas dans le texte libre (« Des échéances dépassées sont à vérifier »).
  // Lot 61 : échéance passée réglée par « À traiter » (aucune intervention attendue, ou tranchée).
  const regles = new Set(raw.toProcessSettledAgendaIds ?? []);
  return raw.overdueAgenda.filter((i) => !acquittes.has(`${extActionOccurrenceKey(i.id)}|${i.date}`) && !notInterpellated?.has(i.id) && !regles.has(i.id)).length;
}

// ── Lot 60 : échéances DÉCIDÉES par T6 ───────────────────────────────────────

/** Échéance retenue par `decideT6Interpellation` (SHOW_NOW), dans l'ordre d'affichage. */
export interface MascotDecidedAgenda {
  agendaItemId: number;
  interpellation: MascotInterpellation;
  /** Démarche attendue selon l'IA (null : rappel historique, ou non précisée). */
  action: string | null;
  reminder: MascotReminderRef;
}

const PRIORITE_T6: Readonly<Record<MascotInterpellation['priority'], MascotPriority>> = { HIGH: 'DO_FIRST', MEDIUM: 'DO_NEXT', LOW: 'CAN_WAIT' };

/**
 * Sujets des échéances décidées (pur) : UNE échéance = UN sujet, sa carte
 * et ses actions — jamais de sujet composé (fin de DATE-NEXT-2 et de ses
 * titres concaténés « X et Y »). Échéance à venir : DATE-NEXT ; arrivée à
 * date : MASC-EXT-ACTION (« C'est fait ») ou MASC-BLOCKED (à préciser).
 */
export function decidedAgendaSubjects(raw: MascotRawData, shown: readonly MascotDecidedAgenda[]): MascotSubject[] {
  if (raw.rights && !raw.rights.canWrite) {
    // REC-005 : en lecture seule, ni « C'est fait » ni « Préciser » ; les
    // échéances à venir restent présentables (lecture).
    shown = shown.filter((d) => {
      const i = (raw.agenda ?? []).find((x) => x.id === d.agendaItemId);
      return !!i?.date && i.date > raw.today;
    });
  }
  const out: MascotSubject[] = [];
  for (const d of shown) {
    const i = (raw.agenda ?? []).find((x) => x.id === d.agendaItemId);
    if (!i?.date) continue;
    const base = i.date > raw.today
      ? dateNextSubject(raw, i, { dedupeDateNext: false })
      : i.requiresQualification ? blockedSubject(raw, i) : extActionSubject(raw, i);
    const ia = d.interpellation.mode !== 'LEGACY';
    // Lot 68 — rappel informatif (SHOW_NOW + INFORMATION) : le fait seul, une
    // fois ; ni action, ni attention prioritaire, ni « à prévoir ». Toujours
    // une échéance À VENIR (le contrat refuse un rappel d'échéance passée).
    if (d.interpellation.mode === 'INFORM') {
      if (i.date <= raw.today) continue;
      out.push({
        ...base,
        requiresAttention: false,
        priority: 'CAN_WAIT',
        intent: 'inform',
        facts: { ...base.facts, interpellation: 'rappel informatif' },
        fallbackText: deadlineReminderText({ ...i, dateRole: roleOf(i) }, formatDateFr(i.date)),
        interpellation: d.interpellation,
        reminder: d.reminder,
      });
      continue;
    }
    // Lot 68 : l'action attendue n'est conservée que si elle apporte une
    // information DISTINCTE du sujet (jamais « préparer la visite … » quand
    // le texte dit déjà la visite, le bien et la date) — et sans préfixe.
    const distincte = ia && actionIsDistinct(d.action, { title: i.title, assetName: i.assetName, dateLabel: formatDateFr(i.date) });
    const phrase = distincte ? actionSentence(d.action) : null;
    out.push({
      ...base,
      // Interpellation décidée : le sujet mérite l'attention (tuile, phrase).
      requiresAttention: true,
      priority: ia ? PRIORITE_T6[d.interpellation.priority] : base.priority,
      facts: {
        ...base.facts,
        ...(ia ? { interpellation: d.interpellation.mode === 'ANTICIPATE' ? 'à anticiper' : 'à traiter maintenant' } : {}),
        ...(phrase && d.action ? { expectedAction: d.action } : {}),
      },
      fallbackText: phrase ? `${base.fallbackText} ${phrase}` : base.fallbackText,
      interpellation: d.interpellation,
      reminder: d.reminder,
    });
  }
  return out;
}

export interface BuildCandidatesOptions {
  /**
   * Lot 60 : échéances décidées par T6. Présent : elles REMPLACENT les
   * familles Date et Recommandation (prochaine date, échéance arrivée à
   * date) — rien n'est présenté sans décision. Absent : chemin historique.
   */
  interpellation?: { shown: readonly MascotDecidedAgenda[] } | null;
}

export function buildCandidates(raw: MascotRawData, opts: BuildCandidatesOptions = {}): MascotCandidates {
  const candidates = [
    ...processingSubjects(raw),
    ...onboardingSubjects(raw),
    ...(opts.interpellation
      ? decidedAgendaSubjects(raw, opts.interpellation.shown)
      : [...dateSubjects(raw), ...mascotRuleSubjects(raw)]),
  ];
  const degraded = raw.processing === null || raw.onboarding === null || raw.toProcess === null
    || raw.agenda === null || raw.acknowledgments === null
    // Lot 53 (D25) : sans savoir s'il reste des échéances dépassées, jamais « tout est à jour ».
    || raw.overdueAgenda === null;
  return { candidates, degraded };
}
