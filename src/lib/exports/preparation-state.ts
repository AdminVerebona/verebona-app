/**
 * Machine d'états de l'écran de préparation d'un dossier — CDC V12 §5.3,
 * §2.1 (statuts de préparation), §6.1 (SEL-GEN-002/008/009/010/011),
 * ALT-002 (confirmation « PDF seul »), ALT-003 (seuil bloquant), §15.3
 * (suivi du job), §17.2 (payload de génération).
 *
 * Module PUR (aucun appel réseau, aucun React) : un réducteur et des
 * sélecteurs, testés sans navigateur. L'écran (`ExportPreparationScreen`)
 * branche les appels `prepare` / `estimate` / génération / suivi.
 *
 * Statuts (§2.1) : idle, loading_preparation, ready_pristine,
 * ready_modified, estimating, estimation_ready, generating, generated_pdf,
 * generated_zip, generated_partial, blocked_threshold, failed,
 * cancel_confirm, expired, file_deleted.
 */

import type {
  EstimateDto, ItemMode, OutputFormat, PrepItem, PrepSection, PreparationDto,
} from '@/services/exports/v12/preparation/types';
import type { PrepMessage } from '@/services/exports/v12/preparation/messages';

export type PrepStatus =
  | 'idle' | 'loading_preparation' | 'ready_pristine' | 'ready_modified' | 'estimating' | 'estimation_ready' | 'estimate_failed'
  | 'blocked_threshold' | 'generating' | 'generated_pdf' | 'generated_zip' | 'generated_partial' | 'failed'
  | 'cancel_confirm' | 'expired' | 'file_deleted';

export interface ItemState { selected: boolean; mode: ItemMode | null }

/** Suivi d'une génération (GET /api/export-generations/{publicId}). */
export interface GenerationView {
  publicId: string | null;
  requestedFormat: OutputFormat;
  generationStatus: string;
  outputFormat: string | null;
  currentStep: string | null;
  downloadUrl: string | null;
  downloadZipUrl: string | null;
  excludedFiles: Array<{ label: string; reasonLabel: string }>;
  errorMessage: string | null;
  expiresAt: string | null;
  /** Horodatage local du lancement (MSG-PREP-008 si la génération dure). */
  startedAt: number;
}

/** Enregistrement automatique des informations complémentaires (IC-GEN-004, PREP-HEA-008). */
export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface PrepState {
  status: PrepStatus;
  /** Statut à retrouver si l'utilisateur renonce à fermer (cancel_confirm). */
  returnTo: PrepStatus | null;
  prep: PreparationDto | null;
  items: Record<string, ItemState>;
  sections: Record<string, boolean>;
  /** SEL-GEN-011 : dernière sélection d'une section désactivée pendant la session. */
  memory: Record<string, Record<string, ItemState>>;
  estimate: EstimateDto | null;
  actions: { canGeneratePdf: boolean; canGenerateZip: boolean };
  messages: PrepMessage[];
  modified: boolean;
  /** Incrémenté à chaque modification : une estimation plus ancienne est ignorée. */
  revision: number;
  generation: GenerationView | null;
  error: { code: string; message: string } | null;
  /** ALT-002 : confirmation « PDF seul » ouverte. */
  confirmPdfOnly: boolean;
  autosave: AutosaveStatus;
  /** Échecs consécutifs d'estimation (nouvelles tentatives espacées, plafonnées). */
  estimateFailures: number;
}

export const initialPrepState: PrepState = {
  status: 'idle', returnTo: null, prep: null, items: {}, sections: {}, memory: {}, estimate: null,
  actions: { canGeneratePdf: false, canGenerateZip: false }, messages: [], modified: false, revision: 0,
  generation: null, error: null, confirmPdfOnly: false, autosave: 'idle', estimateFailures: 0,
};

export type PrepAction =
  | { type: 'LOAD_START' }
  | { type: 'LOAD_SUCCESS'; prep: PreparationDto }
  /** Rechargement (action CIL, informations enregistrées) : choix, mémoire et état de la session conservés. */
  | { type: 'RELOAD_SUCCESS'; prep: PreparationDto }
  | { type: 'RETRY_ESTIMATE' }
  | { type: 'LOAD_FAILURE'; code: string; message: string }
  | { type: 'TOGGLE_ITEM'; key: string; selected: boolean }
  | { type: 'SET_MODE'; key: string; mode: ItemMode }
  | { type: 'SET_SECTION'; id: string; enabled: boolean }
  | { type: 'SECTION_ALL'; id: string }
  | { type: 'SECTION_NONE'; id: string }
  | { type: 'SECTION_RESTORE'; id: string }
  | { type: 'SELECT_LINKED'; keys: string[] }
  | { type: 'ESTIMATE_START' }
  | { type: 'ESTIMATE_SUCCESS'; revision: number; estimate: EstimateDto; actions: PrepState['actions']; messages: PrepMessage[] }
  | { type: 'ESTIMATE_FAILURE'; revision: number }
  | { type: 'REQUEST_CLOSE' }
  | { type: 'CANCEL_CLOSE' }
  | { type: 'OPEN_PDF_ONLY_CONFIRM' }
  | { type: 'CLOSE_PDF_ONLY_CONFIRM' }
  | { type: 'GENERATE_START'; format: OutputFormat; now: number }
  | { type: 'GENERATE_ACCEPTED'; publicId: string; generationStatus: string }
  | { type: 'GENERATE_REJECTED'; code: string; message: string; blocking?: EstimateDto['blocking']; zipOnlyItems?: EstimateDto['zipOnlyItems'] }
  | { type: 'GENERATION_UPDATE'; dto: Partial<GenerationView> & { generationStatus: string } }
  | { type: 'BACK_TO_EDIT' }
  | { type: 'AUTOSAVE'; status: AutosaveStatus };

const EDITABLE: ReadonlySet<PrepStatus> = new Set(['ready_pristine', 'ready_modified', 'estimating', 'estimation_ready', 'estimate_failed', 'blocked_threshold', 'failed']);

/** Nombre maximal de nouvelles tentatives automatiques d'estimation. */
export const MAX_AUTO_ESTIMATE_RETRIES = 3;
/** Délai avant la n-ième nouvelle tentative : 2 s, 4 s, 8 s. */
export const estimateRetryDelayMs = (failures: number): number => 2000 * 2 ** Math.max(0, failures - 1);
const GENERATED: ReadonlySet<PrepStatus> = new Set(['generated_pdf', 'generated_zip', 'generated_partial', 'expired', 'file_deleted']);

export const isEditable = (s: PrepState): boolean => EDITABLE.has(s.status) && !!s.prep;
export const isGenerated = (s: PrepState): boolean => GENERATED.has(s.status);

/** Tous les éléments de la préparation, par clé. */
export function itemIndex(prep: PreparationDto | null): Map<string, { item: PrepItem; section: PrepSection }> {
  const out = new Map<string, { item: PrepItem; section: PrepSection }>();
  for (const section of prep?.sections ?? []) for (const item of section.items) if (!out.has(item.key)) out.set(item.key, { item, section });
  return out;
}

const sectionOf = (s: PrepState, id: string) => s.prep?.sections.find((x) => x.id === id) ?? null;

/** Sélection courante d'une section. */
function selectionOf(s: PrepState, section: PrepSection): Record<string, ItemState> {
  return Object.fromEntries(section.items.map((i) => [i.key, s.items[i.key] ?? { selected: false, mode: i.mode }]));
}

const anySelected = (s: PrepState, section: PrepSection, items = s.items) => section.items.some((i) => items[i.key]?.selected);

/** Modification : préparation « modifiée », estimation à refaire. */
function modified(s: PrepState, patch: Partial<PrepState>): PrepState {
  return { ...s, ...patch, status: 'ready_modified', modified: true, revision: s.revision + 1, error: null };
}

function mapGenerationStatus(g: string, outputFormat: string | null): PrepStatus {
  switch (g) {
    case 'queued': case 'generating': case 'pending': return 'generating';
    case 'ready': return outputFormat === 'ZIP' ? 'generated_zip' : 'generated_pdf';
    case 'partial': return 'generated_partial';
    case 'expired': return 'expired';
    case 'deleted': return 'file_deleted';
    default: return 'failed';
  }
}

export function prepReducer(s: PrepState, a: PrepAction): PrepState {
  switch (a.type) {
    case 'LOAD_START':
      return { ...initialPrepState, status: 'loading_preparation' };

    case 'LOAD_SUCCESS': {
      const items: Record<string, ItemState> = {};
      for (const section of a.prep.sections) for (const i of section.items) items[i.key] = { selected: i.selected, mode: i.mode };
      const sections = Object.fromEntries(a.prep.sections.map((x) => [x.id, x.enabled]));
      return {
        ...initialPrepState,
        status: a.prep.estimate.blocking.length ? 'blocked_threshold' : 'ready_pristine',
        prep: a.prep, items, sections, estimate: a.prep.estimate, actions: a.prep.actions, messages: a.prep.messages,
      };
    }

    case 'RELOAD_SUCCESS': {
      if (!s.prep) return prepReducer(s, { type: 'LOAD_SUCCESS', prep: a.prep });
      // Les éléments reviennent avec les choix transmis (`includeCurrentSelections`) ;
      // une pièce apparue entre-temps garde sa pré-sélection.
      const items: Record<string, ItemState> = {};
      for (const section of a.prep.sections) for (const i of section.items) items[i.key] = s.items[i.key] ?? { selected: i.selected, mode: i.mode };
      const sections = { ...Object.fromEntries(a.prep.sections.map((x) => [x.id, x.enabled])), ...s.sections };
      const keep = s.status === 'generating' || isGenerated(s) || s.status === 'cancel_confirm';
      return {
        ...s, prep: a.prep, items, sections, estimate: a.prep.estimate, actions: a.prep.actions, messages: a.prep.messages,
        estimateFailures: 0,
        status: keep ? s.status : a.prep.estimate.blocking.length ? 'blocked_threshold' : s.modified ? 'estimation_ready' : 'ready_pristine',
      };
    }

    case 'LOAD_FAILURE':
      return { ...s, status: 'failed', error: { code: a.code, message: a.message } };

    case 'TOGGLE_ITEM': {
      if (!isEditable(s)) return s;
      const found = itemIndex(s.prep).get(a.key);
      if (!found || (a.selected && !found.item.selectable)) return s;
      const { item, section } = found;
      const prev = s.items[a.key] ?? { selected: false, mode: item.mode };
      const items = { ...s.items, [a.key]: { selected: a.selected, mode: prev.mode ?? item.recommendedMode } };
      const sections = { ...s.sections };
      const memory = { ...s.memory };
      if (a.selected && section.toggleable) sections[section.id] = true;
      // SEL-GEN-010 : plus aucun élément retenu → section désactivée (sélection mémorisée, SEL-GEN-011).
      if (!a.selected && section.toggleable && !anySelected(s, section, items)) {
        memory[section.id] = selectionOf(s, section);
        sections[section.id] = false;
      }
      return modified(s, { items, sections, memory });
    }

    case 'SET_MODE': {
      if (!isEditable(s)) return s;
      const found = itemIndex(s.prep).get(a.key);
      // SEL-GEN-002 / DEC-005 : un mode non autorisé (PDF d'un fichier non intégrable) est refusé.
      if (!found || !found.item.allowedModes.includes(a.mode)) return s;
      const prev = s.items[a.key] ?? { selected: false, mode: null };
      return modified(s, { items: { ...s.items, [a.key]: { ...prev, mode: a.mode } } });
    }

    case 'SET_SECTION': {
      if (!isEditable(s)) return s;
      const section = sectionOf(s, a.id);
      if (!section || !section.toggleable) return s; // PREP-NAV-012 : section obligatoire verrouillée
      const sections = { ...s.sections, [a.id]: a.enabled };
      const memory = { ...s.memory };
      let items = s.items;
      if (!a.enabled) {
        memory[a.id] = selectionOf(s, section);
      } else if (section.items.length && !anySelected(s, section)) {
        // SEL-GEN-011 : dernière sélection de la session, sinon recommandation.
        const remembered = memory[a.id];
        const restore = remembered && Object.values(remembered).some((x) => x.selected)
          ? remembered
          : Object.fromEntries(section.items.map((i) => [i.key, { selected: i.recommended && i.selectable, mode: i.recommendedMode }]));
        items = { ...s.items, ...restore };
      }
      return modified(s, { sections, memory, items });
    }

    case 'SECTION_ALL': {
      if (!isEditable(s)) return s;
      const section = sectionOf(s, a.id);
      if (!section) return s;
      const items = { ...s.items };
      // SEL-GEN-008 : « Tout cocher » ne coche pas les documents sensibles (ni les fichiers inutilisables).
      for (const i of section.items) {
        if (!i.selectable || i.sensitive) continue;
        items[i.key] = { selected: true, mode: s.items[i.key]?.mode ?? i.recommendedMode };
      }
      return modified(s, { items, sections: section.toggleable ? { ...s.sections, [a.id]: true } : s.sections });
    }

    case 'SECTION_NONE': {
      if (!isEditable(s)) return s;
      const section = sectionOf(s, a.id);
      if (!section) return s;
      const memory = { ...s.memory, [a.id]: selectionOf(s, section) };
      const items = { ...s.items };
      // SEL-GEN-009 : tout décocher, sensibles compris ; SEL-GEN-010 : section désactivée.
      for (const i of section.items) items[i.key] = { selected: false, mode: s.items[i.key]?.mode ?? i.mode };
      return modified(s, { items, memory, sections: section.toggleable ? { ...s.sections, [a.id]: false } : s.sections });
    }

    case 'SECTION_RESTORE': {
      if (!isEditable(s)) return s;
      const section = sectionOf(s, a.id);
      if (!section) return s;
      const items = { ...s.items };
      for (const i of section.items) items[i.key] = { selected: i.recommended && i.selectable, mode: i.recommendedMode };
      const enabled = section.required || (section.defaultEnabled && (!section.items.length || section.items.some((i) => i.recommended && i.selectable)));
      return modified(s, { items, sections: section.toggleable ? { ...s.sections, [a.id]: enabled } : s.sections });
    }

    case 'SELECT_LINKED': {
      // Pièces et photos liées à une ligne saisie (dommage, action, échange…) :
      // cochées ensemble, jamais une pièce sensible ni un fichier inutilisable.
      if (!isEditable(s)) return s;
      const index = itemIndex(s.prep);
      const items = { ...s.items };
      const sections = { ...s.sections };
      let changed = false;
      for (const k of a.keys) {
        const found = index.get(k);
        if (!found || !found.item.selectable || found.item.sensitive || items[k]?.selected) continue;
        items[k] = { selected: true, mode: items[k]?.mode ?? found.item.recommendedMode };
        if (found.section.toggleable) sections[found.section.id] = true;
        changed = true;
      }
      return changed ? modified(s, { items, sections }) : s;
    }

    case 'ESTIMATE_START':
      return isEditable(s) ? { ...s, status: 'estimating' } : s;

    case 'ESTIMATE_SUCCESS': {
      if (a.revision !== s.revision || !isEditable(s)) return s; // estimation périmée
      return {
        ...s, estimate: a.estimate, actions: a.actions, messages: a.messages, estimateFailures: 0,
        status: a.estimate.blocking.length ? 'blocked_threshold' : 'estimation_ready',
      };
    }

    case 'ESTIMATE_FAILURE':
      // Pas de retour à `ready_modified` (qui relancerait l'estimation en boucle) :
      // état d'échec, nouvelles tentatives espacées et plafonnées, génération bloquée.
      return a.revision === s.revision && s.status === 'estimating' ? { ...s, status: 'estimate_failed', estimateFailures: s.estimateFailures + 1 } : s;

    case 'RETRY_ESTIMATE':
      return s.status === 'estimate_failed' ? { ...s, status: 'ready_modified', revision: s.revision + 1 } : s;

    case 'REQUEST_CLOSE':
      if (s.status === 'cancel_confirm') return s;
      return { ...s, returnTo: s.status, status: 'cancel_confirm' };

    case 'CANCEL_CLOSE':
      return s.status === 'cancel_confirm' ? { ...s, status: s.returnTo ?? 'ready_modified', returnTo: null } : s;

    case 'OPEN_PDF_ONLY_CONFIRM':
      return { ...s, confirmPdfOnly: true };

    case 'CLOSE_PDF_ONLY_CONFIRM':
      return { ...s, confirmPdfOnly: false };

    case 'GENERATE_START':
      return {
        ...s, status: 'generating', confirmPdfOnly: false, error: null,
        generation: {
          publicId: null, requestedFormat: a.format, generationStatus: 'queued', outputFormat: a.format, currentStep: null,
          downloadUrl: null, downloadZipUrl: null, excludedFiles: [], errorMessage: null, expiresAt: null, startedAt: a.now,
        },
      };

    case 'GENERATE_ACCEPTED':
      return s.generation ? { ...s, generation: { ...s.generation, publicId: a.publicId, generationStatus: a.generationStatus } } : s;

    case 'GENERATE_REJECTED': {
      // Refus synchrone (seuil, « PDF seul » non confirmé, CIL, plafond…) : message,
      // blocages et pièces ZIP renvoyés par le serveur repris, puis nouvelle
      // estimation (`ready_modified`) — le bouton reste bloqué jusqu'à elle.
      const estimate = s.estimate ? {
        ...s.estimate,
        ...(a.blocking ? { blocking: a.blocking } : {}),
        ...(a.zipOnlyItems ? { zipOnlyItems: a.zipOnlyItems } : {}),
      } : s.estimate;
      return {
        ...s, generation: null, error: { code: a.code, message: a.message }, estimate,
        status: 'ready_modified', revision: s.revision + 1,
        // ALT-002 : le serveur exige la confirmation « PDF seul » → elle s'ouvre.
        confirmPdfOnly: a.code === 'PDF_ONLY_CONFIRMATION_REQUIRED',
      };
    }

    case 'GENERATION_UPDATE': {
      if (!s.generation) return s;
      const generation = { ...s.generation, ...a.dto } as GenerationView;
      const next = mapGenerationStatus(a.dto.generationStatus, generation.outputFormat);
      // Une demande de fermeture en cours n'est pas interrompue par le suivi.
      if (s.status === 'cancel_confirm') return { ...s, generation, returnTo: next };
      return {
        ...s, generation, status: next,
        error: next === 'failed' ? { code: 'GENERATION_FAILED', message: generation.errorMessage ?? 'La génération a échoué.' } : s.error,
      };
    }

    case 'BACK_TO_EDIT':
      return s.prep ? { ...s, status: 'ready_modified', generation: null, error: null, revision: s.revision + 1 } : s;

    case 'AUTOSAVE': {
      if (a.status === s.autosave) return s;
      // Saisie d'une information complémentaire : préparation modifiée (FLOW-*-04).
      if (a.status === 'saving' && isEditable(s)) {
        return { ...s, autosave: a.status, modified: true, status: s.status === 'ready_pristine' ? 'ready_modified' : s.status };
      }
      return { ...s, autosave: a.status };
    }

    default:
      return s;
  }
}

// ─── Sélecteurs ─────────────────────────────────────────────────────────────

/** Une fermeture doit être confirmée (PREP-MOB-008) : préparation modifiée ou génération en cours. */
export const needsCloseConfirmation = (s: PrepState): boolean =>
  s.status === 'generating' || (s.modified && isEditable(s));

/** Pièces liées à une ligne : retenues, à cocher, sensibles (à cocher soi-même), absentes. */
export function linkedStatus(s: PrepState, keys: string[]): { retained: string[]; addable: string[]; sensitive: string[]; missing: number } {
  const index = itemIndex(s.prep);
  const out = { retained: [] as string[], addable: [] as string[], sensitive: [] as string[], missing: 0 };
  for (const k of keys) {
    const f = index.get(k);
    if (!f || !f.item.selectable) { out.missing++; continue; }
    const on = !!s.items[k]?.selected && (f.section.required || s.sections[f.section.id] !== false);
    if (on) out.retained.push(k);
    else if (f.item.sensitive) out.sensitive.push(k);
    else out.addable.push(k);
  }
  return out;
}

/** Compteurs d'une section (PREP-NAV-005/006/007). */
export function sectionCounts(s: PrepState, section: PrepSection): { selected: number; pdf: number; zip: number; total: number } {
  let selected = 0, pdf = 0, zip = 0;
  for (const i of section.items) {
    const st = s.items[i.key];
    if (!st?.selected || !i.selectable) continue;
    selected++;
    if (st.mode === 'ZIP') zip++;
    else if (st.mode === 'PDF') pdf++;
  }
  return { selected, pdf, zip, total: section.items.length };
}

/** Choix au format §17.2 : sections, éléments retenus et leur mode. */
export function buildChoices(s: PrepState, outputFormat: OutputFormat, pdfOnlyExcludesZipItems = false) {
  return {
    outputFormat,
    sections: (s.prep?.sections ?? []).map((section) => ({
      id: section.id,
      enabled: section.required || s.sections[section.id] !== false,
      items: section.items
        .filter((i) => i.selectable && s.items[i.key]?.selected)
        .map((i) => ({ sourceType: i.sourceType, sourceId: i.sourceId, selected: true, ...(s.items[i.key]?.mode ? { mode: s.items[i.key]!.mode } : {}) })),
    })),
    acknowledgements: { pdfOnlyExcludesZipItems },
  };
}

/** Corps de `POST /api/assets/{id}/exports` (génération, §17.2). */
export function buildGenerateBody(s: PrepState, outputFormat: OutputFormat, acknowledged = false) {
  return { exportType: s.prep?.exportType, choices: buildChoices(s, outputFormat, acknowledged) };
}

/** Corps de `POST …/exports/estimate` : format « naturel » calculé par le serveur. */
export function buildEstimateBody(s: PrepState) {
  return { exportType: s.prep?.exportType, choices: buildChoices(s, 'ZIP') };
}

export type GenerateDecision = 'blocked' | 'confirm_pdf_only' | 'go';

/** Bouton « Générer le PDF » / « Générer PDF + ZIP » : ALT-002, ALT-003, MSG-PREP-006. */
export function generateDecision(s: PrepState, format: OutputFormat): GenerateDecision {
  // Estimation à jour exigée : ni pendant une modification non estimée, ni pendant
  // le recalcul, ni après son échec (le résumé serait faux).
  if (!s.prep || !isEditable(s) || s.status === 'estimating' || s.status === 'ready_modified' || s.status === 'estimate_failed') return 'blocked';
  // MSG-PREP-006 : informations non enregistrées (ou en cours) → pas de génération.
  if (s.autosave === 'saving' || s.autosave === 'error') return 'blocked';
  if (!s.actions.canGeneratePdf || (s.estimate?.blocking.length ?? 0) > 0) return 'blocked';
  if (format === 'ZIP') return s.actions.canGenerateZip ? 'go' : 'blocked';
  return (s.estimate?.zipOnlyItems.length ?? 0) > 0 ? 'confirm_pdf_only' : 'go';
}

/** Étapes affichées de la progression (PREP-PROGRESS). */
export const PROGRESS_STEPS = [
  { id: 'prepare', label: 'Préparation des pièces', steps: ['validate_request', 'lock_snapshot', 'resolve_files'] },
  { id: 'render', label: 'Rendu du PDF', steps: ['render_html', 'render_pdf'] },
  { id: 'zip', label: 'Assemblage du ZIP', steps: ['assemble_zip'] },
  { id: 'store', label: 'Enregistrement', steps: ['store_result'] },
  { id: 'finalize', label: 'Finalisation', steps: ['finalize_history'] },
] as const;

export function progressSteps(g: GenerationView | null): Array<{ id: string; label: string; state: 'done' | 'current' | 'todo' }> {
  const steps = PROGRESS_STEPS.filter((p) => p.id !== 'zip' || g?.requestedFormat === 'ZIP');
  const done = g && ['ready', 'partial'].includes(g.generationStatus);
  const idx = g?.currentStep ? steps.findIndex((p) => (p.steps as readonly string[]).includes(g.currentStep!)) : (g?.generationStatus === 'generating' ? 0 : -1);
  return steps.map((p, i) => ({ id: p.id, label: p.label, state: done || i < idx ? 'done' : i === idx ? 'current' : 'todo' }));
}

/** Plan du dossier (résumé) : sections retenues numérotées comme dans le PDF, puis annexes. */
export function dossierOutline(s: PrepState): Array<{ no: string | null; label: string }> {
  const out: Array<{ no: string | null; label: string }> = [];
  let n = 0;
  for (const section of s.prep?.sections ?? []) {
    const enabled = section.required || s.sections[section.id] !== false;
    if (!enabled) continue;
    if (section.itemType && !section.items.some((i) => i.selectable && s.items[i.key]?.selected)) continue;
    // Section alimentée par des informations non renseignées : absente du PDF.
    if (section.fedBy && section.fedFilled === false) continue;
    if (section.id === 'cover') { out.push({ no: null, label: section.label }); continue; }
    if (section.id === 'references') continue;
    out.push({ no: String(++n).padStart(2, '0'), label: section.label });
  }
  if ((s.estimate?.zipDocuments ?? 0) + (s.estimate?.zipPhotos ?? 0) > 0 && s.estimate?.outputFormat === 'ZIP') out.push({ no: String(++n).padStart(2, '0'), label: 'Documents joints au ZIP' });
  if ((s.estimate?.pdfDocuments ?? 0) > 0) out.push({ no: 'Annexes', label: 'Index des annexes intégrées' });
  const refs = s.prep?.sections.find((x) => x.id === 'references');
  if (refs) out.push({ no: null, label: refs.label });
  return out;
}

/** Taille lisible (« 1,2 Mo »). */
export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
  return `${(n / (1024 * 1024)).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo`;
}
