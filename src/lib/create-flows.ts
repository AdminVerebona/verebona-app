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
}

export const OPEN_CREATE_FLOW = 'open-create-flow';

/** Quota vérifié par la garde d'écriture avant l'ouverture. */
export const CREATE_FLOW_QUOTA: Readonly<Record<CreateFlowKind, 'documents' | 'assets' | undefined>> = {
  document: 'documents',
  asset: 'assets',
  agenda_item: undefined,
};

/** Demande valide (pure) : parcours connu, bien entier positif ou absent. */
export function parseCreateFlowRequest(v: unknown): CreateFlowRequest | null {
  const r = v as Partial<CreateFlowRequest> | null;
  if (!r || (r.flow !== 'document' && r.flow !== 'asset' && r.flow !== 'agenda_item')) return null;
  const assetId = r.assetId == null ? null : Number(r.assetId);
  if (assetId !== null && (!Number.isSafeInteger(assetId) || assetId <= 0)) return { flow: r.flow, assetId: null };
  return { flow: r.flow, assetId };
}

/** Formulaire ouvert par chaque parcours (le même que « + Ajouter »). */
export type CreateFlowComponent = 'UnifiedDocumentDialog' | 'AssetFormDialog' | 'CreateAgendaItemDrawer';

export interface CreateFlowView {
  component: CreateFlowComponent;
  /** Bien présélectionné (`preselectedAssetId` / `prefilledAssetId`), jamais pour un bien. */
  preselectedAssetId: number | null;
  /** Quota contrôlé par la garde d'écriture standard. */
  quota: 'documents' | 'assets' | undefined;
}

/** Ce que l'hôte monte pour une demande (pure, testée). */
export function createFlowView(r: CreateFlowRequest): CreateFlowView {
  const component: CreateFlowComponent = r.flow === 'document' ? 'UnifiedDocumentDialog'
    : r.flow === 'asset' ? 'AssetFormDialog' : 'CreateAgendaItemDrawer';
  return { component, preselectedAssetId: r.flow === 'asset' ? null : r.assetId ?? null, quota: CREATE_FLOW_QUOTA[r.flow] };
}

/** Ouvre le parcours de création sur l'écran courant. */
export function openCreateFlow(req: CreateFlowRequest): void {
  if (typeof window === 'undefined') return;
  const r = parseCreateFlowRequest(req);
  if (!r) return;
  window.dispatchEvent(new CustomEvent<CreateFlowRequest>(OPEN_CREATE_FLOW, { detail: r }));
}
