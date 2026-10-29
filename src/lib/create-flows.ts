/**
 * Parcours de création ouverts depuis n'importe quel écran — lot 34G.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MÊME MÉCANISME QUE LES TIROIRS (`lib/drawers.ts`)
 *
 * « Ajouter un document », « Ajouter un bien », « Créer une échéance »
 * proposés par l'assistant menaient à une PAGE (/documents, /assets,
 * /agenda) : l'utilisateur devait y retrouver le bouton. Ils ouvrent
 * désormais directement le formulaire — `UnifiedDocumentDialog`,
 * `AssetFormDialog`, `CreateAgendaItemDrawer` — monté par
 * `GlobalCreateFlowHost` (DashboardLayout), avec le bien déjà résolu
 * présélectionné.
 *
 * Le client ne décide de rien : l'hôte applique la garde d'écriture
 * standard (`useWriteGuard`, quotas documents et biens, état d'abonnement),
 * et le serveur contrôle de nouveau chaque écriture (droits, offre, quota,
 * appartenance au compte).
 * ══════════════════════════════════════════════════════════════════════════
 */

export type CreateFlowKind = 'document' | 'asset' | 'agenda_item';

export interface CreateFlowRequest {
  flow: CreateFlowKind;
  /** Bien déjà résolu (contrôlé par le serveur) : présélectionné. */
  assetId?: number | null;
  /**
   * Lot 95 (document uniquement) : fichiers déjà choisis — PDF du scanner
   * natif, fichiers partagés vers l'app (CDC 12 SCAN-03, IMP-02/03). Ils
   * entrent dans le formulaire d'ajout habituel, avec ses contrôles (taille,
   * format, rattachement, quota) : aucun parcours parallèle (PO M9).
   */
  files?: File[];
}

export const OPEN_CREATE_FLOW = 'open-create-flow';

/** Quota vérifié par la garde d'écriture avant l'ouverture. */
const CREATE_FLOW_QUOTA: Readonly<Record<CreateFlowKind, 'documents' | 'assets' | undefined>> = {
  document: 'documents',
  asset: 'assets',
  agenda_item: undefined,
};

/** Demande valide (pure) : parcours connu, bien entier positif ou absent. */
export function parseCreateFlowRequest(v: unknown): CreateFlowRequest | null {
  const r = v as Partial<CreateFlowRequest> | null;
  if (!r || (r.flow !== 'document' && r.flow !== 'asset' && r.flow !== 'agenda_item')) return null;
  const assetId = r.assetId == null ? null : Number(r.assetId);
  const files = r.flow === 'document' ? fichiersValides(r.files) : null;
  const avecFichiers = files ? { files } : {};
  if (assetId !== null && (!Number.isSafeInteger(assetId) || assetId <= 0)) return { flow: r.flow, assetId: null, ...avecFichiers };
  return { flow: r.flow, assetId, ...avecFichiers };
}

/** Fichiers transmis (objets `File` uniquement, au plus 10 comme le dépôt), ou null. */
function fichiersValides(v: unknown): File[] | null {
  if (!Array.isArray(v) || typeof File === 'undefined') return null;
  const files = v.filter((f): f is File => f instanceof File).slice(0, 10);
  return files.length > 0 ? files : null;
}

/** Formulaire ouvert par chaque parcours (le même que « + Ajouter »). */
type CreateFlowComponent = 'UnifiedDocumentDialog' | 'AssetFormDialog' | 'CreateAgendaItemDrawer';

interface CreateFlowView {
  component: CreateFlowComponent;
  /** Bien présélectionné (`preselectedAssetId` / `prefilledAssetId`), jamais pour un bien. */
  preselectedAssetId: number | null;
  /** Quota contrôlé par la garde d'écriture standard. */
  quota: 'documents' | 'assets' | undefined;
  /** Lot 95 : fichiers à placer dans le formulaire de document (`initialFiles`). */
  initialFiles?: File[];
}

/** Ce que l'hôte monte pour une demande (pure, testée). */
export function createFlowView(r: CreateFlowRequest): CreateFlowView {
  const component: CreateFlowComponent = r.flow === 'document' ? 'UnifiedDocumentDialog'
    : r.flow === 'asset' ? 'AssetFormDialog' : 'CreateAgendaItemDrawer';
  const view: CreateFlowView = { component, preselectedAssetId: r.flow === 'asset' ? null : r.assetId ?? null, quota: CREATE_FLOW_QUOTA[r.flow] };
  if (r.flow === 'document' && r.files && r.files.length > 0) view.initialFiles = r.files;
  return view;
}

/**
 * Lot 95 : l'hôte (`GlobalCreateFlowHost`, chargé à l'usage dans l'espace
 * connecté) se déclare prêt. Sert à l'application native, qui reçoit un scan
 * ou un partage parfois AVANT que l'hôte soit monté (démarrage à froid,
 * connexion) et attend ce signal pour ouvrir le formulaire. Sans effet sur le
 * Web (personne n'écoute).
 */
export const CREATE_FLOW_HOST_READY = 'create-flow-host-ready';
let hotesPrets = 0;
export function declareCreateFlowHost(): () => void {
  hotesPrets += 1;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CREATE_FLOW_HOST_READY));
  return () => { hotesPrets = Math.max(0, hotesPrets - 1); };
}
export function isCreateFlowHostReady(): boolean {
  return hotesPrets > 0;
}

/** Ouvre le parcours de création sur l'écran courant. */
export function openCreateFlow(req: CreateFlowRequest): void {
  if (typeof window === 'undefined') return;
  const r = parseCreateFlowRequest(req);
  if (!r) return;
  window.dispatchEvent(new CustomEvent<CreateFlowRequest>(OPEN_CREATE_FLOW, { detail: r }));
}
