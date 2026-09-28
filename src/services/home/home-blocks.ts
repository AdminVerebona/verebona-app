/**
 * Blocs de l'accueil Direction D v2 — « Ce que j'ai fait » (§3.4) et
 * « Documents récents » (§3.5). Module PUR : les lectures sont faites par
 * `HomeSummaryService`, la mise en forme ici, testée à part.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « CE QUE J'AI FAIT » NE DIT QUE CE QUI EST TRACÉ
 *
 * Trois sources existent, et elles seules :
 *   · `ai_field_updates` : champs d'un bien complétés par l'analyse ;
 *   · `agenda_items` d'origine `qualified_document` : échéances lues dans un
 *     document (et acceptées) ;
 *   · `asset_files.analysis_state` / `last_analysis_at` : documents analysés.
 *
 * Aucune trace ne dit QUI a rattaché un document à un bien : la frise
 * n'écrit donc jamais « j'ai rattaché », seulement « j'ai analysé … (bien) ».
 * ══════════════════════════════════════════════════════════════════════════
 */
import { formatDateFr } from './mascot/signals';

// ── Types ────────────────────────────────────────────────────────────────────

export type WorkTone = 'blue' | 'green' | 'violet' | 'amber';

export type WorkTarget =
  | { kind: 'asset'; assetId: number; fieldKey?: string | null }
  | { kind: 'agenda'; id: number }
  | { kind: 'document'; id: number };

export interface VerebonaWorkItem {
  id: string;
  kind: 'fields' | 'deadline' | 'document';
  /** Phrase à la 1re personne. */
  text: string;
  /** Instant de l'action, ISO. */
  at: string;
  tone: WorkTone;
  cta: string;
  target: WorkTarget;
}

export interface WorkFieldUpdateRow {
  assetId: number;
  assetName: string;
  fieldKey: string;
  /** Libellé lisible du champ (« immatriculation »). */
  fieldLabel: string;
  /** Document dont l'analyse a produit la valeur, s'il est connu. */
  assetFileId?: number | null;
  createdAt: string;
}

export interface WorkDeadlineRow {
  id: number;
  title: string;
  /** AAAA-MM-JJ ou null. */
  date: string | null;
  createdAt: string;
  documentId: number | null;
  documentTitle: string | null;
  assetName: string | null;
}

export interface WorkDocumentRow {
  id: number;
  title: string;
  assetName: string | null;
  analysisState: string | null;
  /** Dernière analyse (ou dépôt), ISO. */
  at: string;
}

export interface WorkRawData {
  fieldUpdates: WorkFieldUpdateRow[];
  deadlines: WorkDeadlineRow[];
  documents: WorkDocumentRow[];
}

// ── Phrases ─────────────────────────────────────────────────────────────────

const NOMBRES = ['aucune', 'une', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix'];

/** « a », « a et b », « a, b et c », « a, b, c et 2 autres ». */
export function joinLabels(labels: string[], max = 3): string {
  const l = [...new Set(labels)];
  if (l.length <= 1) return l[0] ?? '';
  if (l.length <= max) return `${l.slice(0, -1).join(', ')} et ${l[l.length - 1]}`;
  const reste = l.length - max;
  return `${l.slice(0, max).join(', ')} et ${reste} autre${reste > 1 ? 's' : ''}`;
}

function minusculeInitiale(t: string): string {
  // Un sigle (« CT ») ou un nom propre en tête garde sa casse.
  return /^[A-ZÀ-Ý][a-zà-ÿ]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

const q = (s: string) => `« ${s} »`;

function jourDe(iso: string): string {
  return iso.slice(0, 10);
}

/** Champs complétés : un événement par bien et par jour. */
function fieldEvents(rows: WorkFieldUpdateRow[]): VerebonaWorkItem[] {
  const groupes = new Map<string, WorkFieldUpdateRow[]>();
  for (const r of rows) {
    const k = `${r.assetId}|${jourDe(r.createdAt)}`;
    groupes.set(k, [...(groupes.get(k) ?? []), r]);
  }
  return [...groupes.values()].map((g) => {
    const recent = [...g].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    // Libellés dans l'ordre où les champs ont été complétés.
    const labels = [...new Set([...recent].reverse().map((r) => r.fieldLabel))];
    const n = labels.length;
    const combien = n === 1 ? 'une information' : `${NOMBRES[n] ?? n} informations`;
    const a = recent[0];
    return {
      id: `fields:${a.assetId}:${jourDe(a.createdAt)}`,
      kind: 'fields' as const,
      text: `J’ai complété ${combien} sur ${a.assetName} : ${joinLabels(labels)}.`,
      at: a.createdAt,
      tone: 'blue' as const,
      cta: 'Voir les modifications',
      target: { kind: 'asset' as const, assetId: a.assetId, fieldKey: n === 1 ? a.fieldKey : null },
    };
  });
}

function deadlineEvents(rows: WorkDeadlineRow[]): VerebonaWorkItem[] {
  return rows.map((r) => {
    const ou = r.documentTitle ? `dans ${q(r.documentTitle)}` : r.assetName ? `pour ${r.assetName}` : 'dans vos documents';
    const quand = r.date ? ` le ${formatDateFr(r.date)}` : ', date à préciser';
    return {
      id: `deadline:${r.id}`,
      kind: 'deadline' as const,
      text: `J’ai identifié une nouvelle échéance ${ou} : ${minusculeInitiale(r.title)}${quand}.`,
      at: r.createdAt,
      tone: 'green' as const,
      cta: 'Voir dans l’agenda',
      target: { kind: 'agenda' as const, id: r.id },
    };
  });
}

function documentEvents(rows: WorkDocumentRow[]): VerebonaWorkItem[] {
  const out: VerebonaWorkItem[] = [];
  for (const r of rows) {
    const pour = r.assetName ? `, rattaché à ${r.assetName}` : '';
    let text: string | null = null;
    let tone: WorkTone = 'violet';
    switch (r.analysisState) {
      case 'ANALYZED': text = `J’ai analysé ${q(r.title)}${pour}.`; break;
      case 'ANALYZING':
      case 'UPLOADED': text = `J’analyse ${q(r.title)}${pour}.`; break;
      case 'VALIDATION_REQUIRED': text = `J’ai analysé ${q(r.title)} : des informations attendent votre validation.`; tone = 'amber'; break;
      case 'CONFLICT_DETECTED': text = `J’ai relevé une incohérence dans ${q(r.title)} : elle vous attend dans « À traiter ».`; tone = 'amber'; break;
      default: text = null; // échec ou document non analysé : rien que Verebona ait fait
    }
    if (!text) continue;
    out.push({ id: `document:${r.id}`, kind: 'document', text, at: r.at, tone, cta: 'Ouvrir le document', target: { kind: 'document', id: r.id } });
  }
  return out;
}

export const MAX_WORK_ITEMS = 4;

/**
 * Frise « Ce que j'ai fait » : les trois sources, du plus récent au plus
 * ancien, `max` entrées. Un document dont l'analyse a produit des champs
 * n'est pas répété : l'événement « champs complétés » le dit déjà mieux.
 */
export function deriveVerebonaWork(raw: WorkRawData, max = MAX_WORK_ITEMS): VerebonaWorkItem[] {
  const dejaDits = new Set(raw.fieldUpdates.map((r) => r.assetFileId).filter((x): x is number => typeof x === 'number'));
  const docs = raw.documents.filter((d) => !(d.analysisState === 'ANALYZED' && dejaDits.has(d.id)));
  const all = [...fieldEvents(raw.fieldUpdates), ...deadlineEvents(raw.deadlines), ...documentEvents(docs)];
  return all
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
    .slice(0, max);
}

/** « Aujourd'hui », « Hier », « Il y a 3 jours », « Il y a 2 semaines », « 12 sept. ». */
export function relativeAgo(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const jour = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const n = Math.round((jour(now) - jour(d)) / 86_400_000);
  if (n <= 0) return 'Aujourd’hui';
  if (n === 1) return 'Hier';
  if (n < 7) return `Il y a ${n} jours`;
  if (n < 28) {
    const s = Math.floor(n / 7);
    return s === 1 ? 'Il y a 1 semaine' : `Il y a ${s} semaines`;
  }
  const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  return `${d.getDate()} ${MOIS[d.getMonth()]}${d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ''}`;
}

// ── Documents récents (§3.5) ────────────────────────────────────────────────

export type DocTone = 'slate' | 'green' | 'blue' | 'violet' | 'amber';

export interface HomeRecentDocument {
  id: number;
  title: string;
  assetId: number | null;
  assetName: string | null;
  /** Type ou rubrique lisible (« Assurance »). */
  typeLabel: string;
  /** Date utile, AAAA-MM-JJ. */
  date: string | null;
  /** Statut éventuel (« En analyse »). */
  status: string | null;
  tone: DocTone;
}

/** Couleur de l'icône par rubrique (assurance verte, contrôle bleu…). */
const RUBRIC_TONES: Record<string, DocTone> = {
  INSURANCE_CLAIMS: 'green',
  COMPLIANCE_CONTROLS: 'blue',
  MAINTENANCE_WORKS: 'blue',
  CONTRACTS_WARRANTIES_DOCS: 'violet',
  PROPERTY_MANAGEMENT: 'slate',
};

export function docTone(rubricCode: string | null | undefined): DocTone {
  return (rubricCode && RUBRIC_TONES[rubricCode]) || 'slate';
}

/** Statut affiché sur la tuile : seulement ce qui appelle un regard. */
export function docStatus(analysisState: string | null | undefined): string | null {
  switch (analysisState) {
    case 'UPLOADING':
    case 'UPLOADED':
    case 'ANALYZING': return 'En analyse';
    case 'VALIDATION_REQUIRED': return 'À valider';
    case 'CONFLICT_DETECTED': return 'À vérifier';
    default: return null;
  }
}

// ── Prochaines échéances (prototype Direction D v2, décision produit) ───────

export type UpcomingTone = 'red' | 'amber' | 'green';

export interface UpcomingRow {
  id: number;
  title: string;
  /** AAAA-MM-JJ. */
  date: string;
  assetName: string | null;
  /** Occurrence prévisionnelle d'une récurrence : jamais présentée comme certaine. */
  forecast: boolean;
  /** Échéance d'ACTION (une information passée n'est pas « en retard »). */
  action: boolean;
}

export interface HomeUpcomingItem {
  id: number;
  title: string;
  assetName: string | null;
  date: string;
  /** Pastille de date : « 12 » / « oct. ». */
  day: string;
  month: string;
  /** « En retard (2 j) », « Aujourd'hui », « Dans 3 semaines »… */
  rel: string;
  tone: UpcomingTone;
  forecast: boolean;
}

export const MAX_UPCOMING = 5;
/** Au-delà, une action passée relève de l'agenda, plus de l'accueil (comme la mascotte). */
export const UPCOMING_OVERDUE_DAYS = 60;
/** Une échéance à moins de 30 jours est « proche » (amber). */
export const UPCOMING_SOON_DAYS = 30;

const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

function ecart(from: string, to: string): number {
  return Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

/** Délai lisible depuis `today` (négatif : en retard). */
export function relativeDue(days: number): string {
  if (days < 0) return `En retard (${-days} j)`;
  if (days === 0) return 'Aujourd’hui';
  if (days === 1) return 'Demain';
  if (days < 14) return `Dans ${days} jours`;
  if (days < 60) return `Dans ${Math.round(days / 7)} semaines`;
  const mois = Math.round(days / 30);
  return mois >= 12 && mois < 18 ? 'Dans 1 an' : mois >= 18 ? `Dans ${Math.round(mois / 12)} ans` : `Dans ${mois} mois`;
}

/**
 * « Prochaines échéances » : les actions en retard (60 jours au plus), puis
 * les échéances à venir, par date croissante — la plus urgente en tête.
 * Rouge = en retard, amber = moins de 30 jours, vert = plus tard.
 */
export function deriveUpcoming(rows: UpcomingRow[], today: string, max = MAX_UPCOMING): HomeUpcomingItem[] {
  return rows
    .map((r) => ({ r, d: ecart(today, r.date) }))
    .filter(({ r, d }) => (d >= 0 ? true : r.action && !r.forecast && -d <= UPCOMING_OVERDUE_DAYS))
    .sort((a, b) => a.d - b.d || a.r.id - b.r.id)
    .slice(0, max)
    .map(({ r, d }) => {
      const [, m, j] = r.date.slice(0, 10).split('-').map(Number);
      return {
        id: r.id, title: r.title, assetName: r.assetName, date: r.date.slice(0, 10),
        day: String(j), month: MOIS_COURTS[m - 1],
        rel: `${relativeDue(d)}${r.forecast ? ' (estimée)' : ''}`,
        tone: d < 0 ? 'red' : d <= UPCOMING_SOON_DAYS ? 'amber' : 'green',
        forecast: r.forecast,
      };
    });
}
