"use client"

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FileDown, Send, FileText, Home, Shield, ShieldAlert, KeyRound, Package, RefreshCw, Download, AlertCircle, AlertTriangle, CheckCircle2, Clock, XCircle, X, Crown, CalendarDays, Trash2, Hourglass } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { apiClient } from '@/lib/api-client';
import { createExportSettleWatcher } from '@/lib/data-freshness';
import { toast } from 'sonner';
import { TransferExportDrawer, type TransferUsage } from './TransferExportDrawer';
import { preparationPath } from '@/lib/exports/dossier-slug';
import { getPlanTheme } from '@/lib/plan-theme';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import { useEntitlements } from '@/hooks/useEntitlements';
import { isCilEligible } from '@/lib/asset-capabilities';
import {
  DOSSIER_CODES, DOSSIER_DESCRIPTIONS, DOSSIER_LABELS, EXPORT_BRUT_LABEL, exportCodeLabel,
  isDossierCode, isDossierEligibleForFamily, type DossierCode,
} from '@/services/exports/catalog';
import type { CatalogDossier, ExportCatalog } from '@/services/exports/export-catalog.service';

/**
 * Codes envoyés à `POST /api/assets/[id]/exports` : les six dossiers V12
 * (`services/exports/catalog`) et l'export de données brutes.
 */
export type ExportType = DossierCode | 'EXPORT_BRUT';

interface ExportUsageDef {
  type: ExportType | 'TRANSMISSION';
  label: string;
  description: string;
  icon: React.ElementType;
  section: 'dossiers' | 'transfert';
  premiumOnly: boolean;
}

/** Pictogramme de chaque dossier (Lucide, comme le reste de l'application). */
const DOSSIER_ICONS: Record<DossierCode, React.ElementType> = {
  CIL: FileText,
  DOSSIER_COMPLET: FileText,
  VENTE: Home,
  LOCATION: KeyRound,
  ASSURANCE_SOUSCRIPTION: Shield,
  ASSURANCE_SINISTRE: ShieldAlert,
};

/**
 * Cartes proposées. Les dossiers suivent le catalogue V12 (§1.2) ; leur
 * éligibilité, leur verrou d'offre et leurs indices de préparation viennent
 * de `GET /api/assets/[id]/export-catalog` (EXP-001), avec repli local sur la
 * règle de famille si le catalogue ne répond pas.
 */
const EXPORT_USAGES: ExportUsageDef[] = [
  ...DOSSIER_CODES.map((code): ExportUsageDef => ({
    type: code,
    label: DOSSIER_LABELS[code],
    description: DOSSIER_DESCRIPTIONS[code],
    icon: DOSSIER_ICONS[code],
    section: 'dossiers',
    premiumOnly: true,
  })),
  {
    type: 'EXPORT_BRUT',
    label: EXPORT_BRUT_LABEL,
    description: 'Tous vos fichiers et données en un ZIP téléchargeable',
    icon: Package, section: 'transfert', premiumOnly: false,
  },
  {
    type: 'TRANSMISSION',
    label: 'Transmission du bien',
    description: 'Transférer votre bien vers un autre compte Verebona.',
    icon: Send, section: 'transfert', premiumOnly: false,
  },
];

export interface ExportRecord {
  id: number;
  publicId: string;
  exportType: string;
  status: string;
  /** Statut V12 (§2.1) : queued, generating, ready, partial, failed, expired, deleted. */
  generationStatus?: string;
  outputFormat?: string | null;
  requestedOutputs: string[];
  errorMessage: string | null;
  partialMessage?: string | null;
  excludedCount?: number | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt?: string | null;
  /** DRH-003 : auteur de la génération (titulaire ou co-titulaire Duo). */
  createdBy?: { userId: number; name: string | null } | null;
  downloadUrl: string | null;
  downloadZipUrl: string | null;
  generationAttemptCount?: number;
}

interface TransmissionRecord {
  id: number;
  publicId: string;
  recipientEmail: string;
  status: 'pending' | 'accepted' | 'refused' | 'cancelled';
  sentAt: string;
  acceptedAt: string | null;
  refusedAt: string | null;
  cancelledAt: string | null;
  shareUrl: string;
}

interface CilPreparationSummary {
  eligible: boolean;
  globalStatus?: 'ready' | 'action_required';
  completion?: { percentage: number; resolvedBlocks: number; totalBlocks: number };
  lastGeneration?: { createdAt: string; status: string } | null;
}

type CompletenessLevel = 'faible' | 'moyen' | 'bon' | 'eleve';

function getCompletenessLevel(pct: number): CompletenessLevel {
  if (pct >= 90) return 'eleve';
  if (pct >= 65) return 'bon';
  if (pct >= 35) return 'moyen';
  return 'faible';
}

const COMPLETENESS_CONFIG: Record<CompletenessLevel, { label: string; color: string; bg: string; border: string }> = {
  eleve:  { label: 'Élevé',  color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950/30', border: 'border-emerald-200 dark:border-emerald-800' },
  bon:    { label: 'Bon',    color: 'text-blue-600 dark:text-blue-400',       bg: 'bg-blue-50 dark:bg-blue-950/30',       border: 'border-blue-200 dark:border-blue-800' },
  moyen:  { label: 'Moyen', color: 'text-amber-600 dark:text-amber-400',     bg: 'bg-amber-50 dark:bg-amber-950/30',     border: 'border-amber-200 dark:border-amber-800' },
  faible: { label: 'Faible', color: 'text-rose-600 dark:text-rose-400',      bg: 'bg-rose-50 dark:bg-rose-950/30',       border: 'border-rose-200 dark:border-rose-800' },
};

interface Props {
  assetId: number;
  assetCategory: string;
  assetTypeId?: number;
  planType: string;
  thumbnailUrl?: string | null;
  /** Catégorie Immobilier (« Maison »…) — éligibilité CIL (GAP-08). */
  assetSubtype?: string | null;
}

/** Statut V12 d'une ligne d'historique (repli sur le statut historique). */
function v12Status(exp: ExportRecord): string {
  if (exp.generationStatus) return exp.generationStatus;
  return exp.status === 'pending' ? 'queued' : exp.status === 'error' ? 'failed' : exp.status;
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'ready') return <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />;
  if (status === 'partial') return <AlertTriangle className="w-4 h-4 text-[color:var(--text-warning)] flex-shrink-0" />;
  if (status === 'failed') return <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />;
  // DRH-004 : fichier supprimé, entrée conservée dans l'historique.
  if (status === 'deleted') return <Trash2 className="w-4 h-4 text-muted-foreground flex-shrink-0" />;
  // DRH-006 : expiré, téléchargement impossible.
  if (status === 'expired') return <Hourglass className="w-4 h-4 text-muted-foreground flex-shrink-0" />;
  return <Clock className="w-4 h-4 text-blue-400 flex-shrink-0 animate-pulse" />;
}

/**
 * Libellés de l'historique : codes V12, anciens codes (lignes antérieures à la
 * migration 0213) et transmission. Lire via `typeLabel`.
 */
export const TYPE_LABELS: Record<string, string> = {
  ...DOSSIER_LABELS,
  EXPORT_BRUT: EXPORT_BRUT_LABEL,
  TRANSMISSION: 'Transmission du bien',
};

export function typeLabel(code: string): string {
  return TYPE_LABELS[code] ?? exportCodeLabel(code);
}

function formatDateLong(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso));
}

export function AssetExportsTab({ assetId, assetCategory, assetTypeId, planType, thumbnailUrl, assetSubtype }: Props) {
  // CIL : maisons et appartements uniquement — même règle que l'API.
  const cilOffert = isCilEligible({ category: assetCategory, subtype: assetSubtype });
  const [exports, setExports] = useState<ExportRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  /** Tiroir « Transfert et récupération » ; les dossiers ont leur écran de préparation (§5). */
  const [drawerUsage, setDrawerUsage] = useState<TransferUsage | null>(null);

  /**
   * Ouverture d'un export, gardée pour les dossiers préparés.
   *
   * `premiumOnly` distingue déjà les deux familles : la transmission et
   * l'export de données brutes restent accessibles, essai terminé ou non.
   * Les fermer priverait l'utilisateur de ses propres données — ce que le
   * message « vos données sont conservées » promet précisément.
   */
  const { garder, signalerRefus } = useWriteGuard();

  // ══════════════════════════════════════════════════════════════════════
  // DOSSIERS PRÊTS À L'USAGE : RÉSERVÉS À PREMIUM ET PREMIUM DUO
  //
  // Le verrou comparait `planType` à 'STANDARD', alors que la page lui
  // passe 'freemium' | 'premium' : il ne s'affichait jamais, et un compte
  // Standard ouvrait le tiroir de préparation. Il suit désormais les droits
  // effectifs (`premiumFeatures`, qui couvre aussi l'essai Premium).
  //
  // Un compte Standard qui clique sur un dossier obtient la fenêtre
  // « Passer à Premium ou Premium Duo ». Transfert et récupération
  // (`premiumOnly: false`) restent ouverts à tous.
  // ══════════════════════════════════════════════════════════════════════
  const { entitlements } = useEntitlements();
  const premiumRefuse = entitlements != null && !entitlements.premiumFeatures;

  const ouvrirExport = useCallback(
    (type: ExportType | 'TRANSMISSION', premiumOnly: boolean) => {
      if (!isDossierCode(type)) { setDrawerUsage(type as TransferUsage); return; }
      if (!premiumOnly) { router.push(preparationPath(assetId, type)); return; }
      // `garder` traite d'abord le compte restreint (essai terminé…).
      garder(() => {
        if (premiumRefuse) {
          signalerRefus({
            code: 'PREMIUM_REQUIRED',
            message: 'Les dossiers prêts à l\u2019usage sont disponibles avec les offres Premium et Premium Duo.',
          });
          return;
        }
        // Écran de préparation (page dédiée, CDC V12 §5).
        router.push(preparationPath(assetId, type));
      });
    },
    [garder, signalerRefus, premiumRefuse, router, assetId],
  );
  const [retrying, setRetrying] = useState<number | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<ExportRecord | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [transmissions, setTransmissions] = useState<TransmissionRecord[]>([]);
  const [loadingTransmissions, setLoadingTransmissions] = useState(false);
  const [cancellingId, setCancellingId] = useState<number | null>(null);

  // Catalogue V12 (EXP-001) : éligibilité, verrou d'offre, indices de préparation.
  const [catalog, setCatalog] = useState<ExportCatalog | null>(null);
  const loadCatalog = useCallback(async () => {
    try {
      setCatalog(await apiClient.get<ExportCatalog>(`/api/assets/${assetId}/export-catalog`));
    } catch {
      // Repli : règles de famille locales (isAllowed) et droits du compte.
      setCatalog(null);
    }
  }, [assetId]);

  // CIL completeness summary (loaded once for IMMOBILIER assets, refreshed after export created)
  const [cilSummary, setCilSummary] = useState<CilPreparationSummary | null>(null);
  const [cilSummaryLoading, setCilSummaryLoading] = useState(false);

  // CDC 11 §15 : historique interrogé toutes les 3 s pendant une génération —
  // un export passé à prêt / erreur émet `verebona:data-mutated` (mascotte).
  const generationsWatcher = useRef(createExportSettleWatcher());
  const loadExports = useCallback(async () => {
    try {
      const res = await apiClient.get<{ exports: ExportRecord[] }>(`/api/assets/${assetId}/exports`);
      generationsWatcher.current.observeList((res.exports ?? []).map((e) => ({ id: e.id, status: v12Status(e) })));
      setExports(res.exports ?? []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [assetId]);

  const loadTransmissions = useCallback(async () => {
    setLoadingTransmissions(true);
    try {
      const res = await apiClient.get<{ transmissions: TransmissionRecord[] }>(`/api/assets/${assetId}/transmission`);
      setTransmissions(res.transmissions ?? []);
    } catch {
      // ignore
    } finally {
      setLoadingTransmissions(false);
    }
  }, [assetId]);

  const loadCilSummary = useCallback(async () => {
    if (!cilOffert) return;
    setCilSummaryLoading(true);
    try {
      const res = await apiClient.get<CilPreparationSummary>(`/api/assets/${assetId}/exports/cil/preparation`);
      setCilSummary(res);
    } catch {
      // ignore silently — completeness is informative only
    } finally {
      setCilSummaryLoading(false);
    }
  }, [assetId, cilOffert]);

  useEffect(() => {
    loadExports();
    loadTransmissions();
    loadCilSummary();
    loadCatalog();
  }, [loadExports, loadTransmissions, loadCilSummary, loadCatalog]);

  // Lien « Historique » de l'écran de préparation (PREP-HEA-009) : `#historique`.
  useEffect(() => {
    if (loading || typeof window === 'undefined' || window.location.hash !== '#historique') return;
    document.getElementById('historique')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [loading]);

  const transmissionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll exports (3s) — seulement si un export est en cours ET onglet visible
  useEffect(() => {
    const hasActive = exports.some(e => ['queued', 'generating'].includes(v12Status(e)));

    const start = () => {
      if (!pollIntervalRef.current) pollIntervalRef.current = setInterval(loadExports, 3000);
    };
    const stop = () => {
      if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null; }
    };
    const onVisibility = () => { if (document.hidden) stop(); else if (hasActive) start(); };

    if (hasActive && !document.hidden) start(); else stop();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [exports, loadExports]);

  // Poll transmissions (10s) — seulement si une transmission est en attente ET onglet visible
  useEffect(() => {
    const hasPending = transmissions.some(t => t.status === 'pending');

    const start = () => {
      if (!transmissionPollRef.current) transmissionPollRef.current = setInterval(loadTransmissions, 10_000);
    };
    const stop = () => {
      if (transmissionPollRef.current) { clearInterval(transmissionPollRef.current); transmissionPollRef.current = null; }
    };
    const onVisibility = () => { if (document.hidden) stop(); else if (hasPending) start(); };

    if (hasPending && !document.hidden) start(); else stop();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [transmissions, loadTransmissions]);

  const handleRetry = useCallback(async (exportId: number) => {
    setRetrying(exportId);
    try {
      await apiClient.post(`/api/assets/${assetId}/exports/${exportId}/retry`, {});
      await loadExports();
      toast.success('Regénération lancée');
    } catch (err: any) {
      toast.error(err?.message ?? 'Erreur lors de la relance');
    } finally {
      setRetrying(null);
    }
  }, [assetId, loadExports]);

  const handleDelete = useCallback(async (exportId: number) => {
    setDeleting(exportId);
    try {
      await apiClient.delete(`/api/assets/${assetId}/exports/${exportId}`);
      toast.success('Fichier supprimé');
      setDeleteConfirm(null);
      await loadExports();
    } catch (err: any) {
      toast.error(err?.message ?? 'Erreur lors de la suppression');
    } finally {
      setDeleting(null);
    }
  }, [assetId, loadExports]);

  const handleExportCreated = useCallback(async () => {
    setDrawerUsage(null);
    await Promise.all([loadExports(), loadTransmissions(), loadCilSummary(), loadCatalog()]);
  }, [loadExports, loadTransmissions, loadCilSummary, loadCatalog]);

  const handleCancelTransmission = useCallback(async (transmissionId: number) => {
    setCancellingId(transmissionId);
    try {
      await apiClient.delete(`/api/assets/${assetId}/transmission/${transmissionId}`);
      toast.success('Transmission annulée');
      await loadTransmissions();
    } catch (err: any) {
      toast.error(err?.message ?? 'Erreur lors de l\'annulation');
    } finally {
      setCancellingId(null);
    }
  }, [assetId, loadTransmissions]);

  const catalogEntry = (type: ExportUsageDef['type']): CatalogDossier | undefined =>
    isDossierCode(type) ? catalog?.dossiers.find(d => d.code === type) : undefined;

  // Dossier non applicable à la famille (LOCATION d'un véhicule, CIL d'un
  // terrain…) : non proposé. Même règle que le serveur, qui refuse aussi.
  const isAllowed = (usage: ExportUsageDef) => {
    if (!isDossierCode(usage.type)) return true;
    const entry = catalogEntry(usage.type);
    if (entry) return entry.eligible;
    return isDossierEligibleForFamily(usage.type, assetCategory) && (usage.type !== 'CIL' || cilOffert);
  };

  const dossierUsages = EXPORT_USAGES.filter(u => u.section === 'dossiers' && isAllowed(u));
  const transfertUsages = EXPORT_USAGES.filter(u => u.section === 'transfert' && isAllowed(u));

  const isLocked = (usage: ExportUsageDef) =>
    usage.premiumOnly && (catalogEntry(usage.type)?.locked ?? premiumRefuse);

  // CIL completeness derived values
  const cilPct = cilSummary?.completion?.percentage ?? 0;
  const cilLevel = getCompletenessLevel(cilPct);
  const cilConfig = COMPLETENESS_CONFIG[cilLevel];
  const cilLastGen = cilSummary?.lastGeneration;
  const cilEligible = cilSummary?.eligible ?? true;

  return (
    <div className="space-y-8">
      {/* ── Dossiers prêts à l'usage ── */}
      <div>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Dossiers prêts à l&apos;usage
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {dossierUsages.map((usage) => {
            const locked = isLocked(usage);
            const Icon = usage.icon;
            const premiumTheme = getPlanTheme('PREMIUM');
            const isCilRegl = usage.type === 'CIL';
            const showCilInfo = isCilRegl && cilOffert && !locked;
            const entry = catalogEntry(usage.type);
            // Indice de préparation le plus important (bloquant, puis recommandé).
            const hint = !locked && !isCilRegl
              ? entry?.readiness.hints.find(h => h.severity === 'blocking') ?? entry?.readiness.hints.find(h => h.severity === 'warning')
              : undefined;
            const lastGen = !isCilRegl ? entry?.lastGeneration : null;

            return (
              <button
                key={usage.type}
                onClick={() => ouvrirExport(usage.type, usage.premiumOnly)}
                className={`flex items-start gap-3 p-4 rounded-lg border text-left transition-colors w-full ${
                  locked
                    ? `border-blue-500/30 bg-blue-500/5 ${premiumTheme.colors.bgDark} hover:bg-blue-500/10`
                    : 'hover:bg-accent/50'
                }`}
              >
                <Icon className={`w-5 h-5 mt-0.5 flex-shrink-0 ${locked ? 'text-blue-400/60 dark:text-blue-300/60' : 'text-muted-foreground'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{usage.label}</span>
                    {locked && <Crown className="w-3 h-3 text-blue-400 dark:text-blue-300" />}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{usage.description}</p>

                  {/* CIL completeness badge */}
                  {showCilInfo && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {cilSummaryLoading ? (
                        <Skeleton className="h-4 w-20" />
                      ) : cilSummary && cilEligible ? (
                        <>
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border ${cilConfig.bg} ${cilConfig.color} ${cilConfig.border}`}>
                            Complétude : {cilConfig.label}
                          </span>
                          {cilLastGen?.status === 'ready' && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                              <CalendarDays className="w-2.5 h-2.5" />
                              Généré le {formatDateLong(cilLastGen.createdAt)}
                            </span>
                          )}
                        </>
                      ) : null}
                    </div>
                  )}

                  {hint && (
                    <p className="mt-2 flex items-start gap-1 text-[11px] leading-snug text-amber-400">
                      <AlertCircle className="w-3 h-3 mt-px shrink-0" />
                      {hint.message}
                    </p>
                  )}
                  {lastGen?.status === 'ready' && (
                    <span className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                      <CalendarDays className="w-2.5 h-2.5" />
                      Généré le {formatDateLong(lastGen.createdAt)}
                    </span>
                  )}

                  {locked && (
                    <Badge
                      className="mt-1.5 text-[10px] px-1.5 py-0 bg-blue-500/15 text-blue-400 dark:text-blue-300 border border-blue-500/30 dark:border-blue-500/20 hover:bg-blue-500/20"
                      title={entry?.lockReason?.message}
                    >
                      Premium
                    </Badge>
                  )}
                </div>
                <span className="text-xs text-muted-foreground whitespace-nowrap self-center">→</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Transfert et récupération ── */}
      <div>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Transfert et récupération
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {transfertUsages.map((usage) => {
            const locked = isLocked(usage);
            const Icon = usage.icon;
            const premiumTheme = getPlanTheme('PREMIUM');
            return (
              <button
                key={usage.type}
                onClick={() => ouvrirExport(usage.type, usage.premiumOnly)}
                className={`flex items-start gap-3 p-4 rounded-lg border text-left transition-colors w-full ${
                  locked
                    ? `border-blue-500/30 bg-blue-500/5 ${premiumTheme.colors.bgDark} hover:bg-blue-500/10`
                    : 'hover:bg-accent/50'
                }`}
              >
                <Icon className={`w-5 h-5 mt-0.5 flex-shrink-0 ${locked ? 'text-blue-400/60 dark:text-blue-300/60' : 'text-muted-foreground'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{usage.label}</span>
                    {locked && <Crown className="w-3 h-3 text-blue-400 dark:text-blue-300" />}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{usage.description}</p>
                  {locked && (
                    <Badge className="mt-1.5 text-[10px] px-1.5 py-0 bg-blue-500/15 text-blue-400 dark:text-blue-300 border border-blue-500/30 dark:border-blue-500/20 hover:bg-blue-500/20">
                      Premium
                    </Badge>
                  )}
                </div>
                <span className="text-xs text-muted-foreground whitespace-nowrap self-center">→</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Historique des transmissions ── */}
      {(loadingTransmissions || transmissions.length > 0) && (
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Transmissions
          </h3>

          {loadingTransmissions ? (
            <div className="space-y-2">
              {[1, 2].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : (
            <div className="space-y-2">
              {transmissions.map(tr => {
                const statusConfig = {
                  pending:   { label: 'En attente',  icon: Clock,         color: 'text-blue-400' },
                  accepted:  { label: 'Acceptée',    icon: CheckCircle2,  color: 'text-green-500' },
                  refused:   { label: 'Refusée',     icon: XCircle,       color: 'text-red-400' },
                  cancelled: { label: 'Annulée',     icon: X,             color: 'text-muted-foreground' },
                }[tr.status] ?? { label: tr.status, icon: Clock, color: 'text-muted-foreground' };
                const StatusIco = statusConfig.icon;
                const eventDate = tr.acceptedAt ?? tr.refusedAt ?? tr.cancelledAt ?? tr.sentAt;

                return (
                  <div key={tr.id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg border bg-card text-sm">
                    <StatusIco className={`w-4 h-4 flex-shrink-0 ${statusConfig.color} ${tr.status === 'pending' ? 'animate-pulse' : ''}`} />
                    <div className="flex-1 min-w-0">
                      <span className="font-medium block truncate">→ {tr.recipientEmail}</span>
                      <span className={`text-xs mt-0.5 block ${statusConfig.color}`}>{statusConfig.label}</span>
                    </div>
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                      {new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short' }).format(new Date(eventDate))}
                    </span>
                    {tr.status === 'pending' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs text-muted-foreground hover:text-destructive flex-shrink-0"
                        onClick={() => handleCancelTransmission(tr.id)}
                        disabled={cancellingId === tr.id}
                      >
                        {cancellingId === tr.id
                          ? <RefreshCw className="w-3 h-3 animate-spin" />
                          : 'Annuler'}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Historique des exports (DRH-002 à 010, ALT-005, ALT-006) ── */}
      <div id="historique" className="scroll-mt-24">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Historique des exports
        </h3>

        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : exports.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground text-sm">
            <FileDown className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p>Aucun export généré pour ce bien.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {exports.map(exp => {
              const st = v12Status(exp);
              const downloadable = st === 'ready' || st === 'partial';
              const active = st === 'queued' || st === 'generating';
              return (
                <div
                  key={exp.id}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg border bg-card text-sm"
                >
                  <StatusIcon status={st} />
                  <div className="flex-1 min-w-0">
                    <span className="font-medium truncate block">
                      {typeLabel(exp.exportType)}
                      {exp.outputFormat === 'ZIP' && downloadable && <span className="ml-1.5 text-[10px] font-semibold text-muted-foreground">PDF + ZIP</span>}
                    </span>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {formatDateLong(exp.createdAt)}
                      {/* DRH-003 : auteur affiché (Duo : titulaire ou co-titulaire). */}
                      {exp.createdBy && <> · par {exp.createdBy.name ?? `l’utilisateur n° ${exp.createdBy.userId}`}</>}
                    </p>
                    {st === 'failed' && exp.errorMessage && (
                      <p className="text-xs text-red-500 truncate mt-0.5">{exp.errorMessage}</p>
                    )}
                    {st === 'partial' && (
                      <p className="text-xs text-[color:var(--text-warning)] mt-0.5">
                        Généré partiellement{exp.excludedCount ? ` : ${exp.excludedCount} fichier${exp.excludedCount > 1 ? 's' : ''} exclu${exp.excludedCount > 1 ? 's' : ''}` : ''}
                      </p>
                    )}
                    {st === 'queued' && <p className="text-xs text-muted-foreground mt-0.5">En attente de génération…</p>}
                    {st === 'generating' && <p className="text-xs text-muted-foreground mt-0.5">Génération en cours…</p>}
                    {st === 'deleted' && <p className="text-xs text-muted-foreground mt-0.5">Fichier supprimé</p>}
                    {/* DRH-006 / DRH-007 : expiré, ni téléchargement ni régénération depuis l'historique. */}
                    {st === 'expired' && <p className="text-xs text-muted-foreground mt-0.5">Expiré — relancez une préparation pour obtenir un nouveau dossier</p>}
                    {downloadable && exp.expiresAt && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">Disponible jusqu’au {formatDateLong(exp.expiresAt)}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {/* DRH-010 : liens vers /api/export-generations/{id}/download (droits revérifiés). */}
                    {downloadable && exp.downloadUrl && (
                      <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
                        <a href={exp.downloadUrl} target="_blank" rel="noopener noreferrer"><Download className="w-3.5 h-3.5" />PDF</a>
                      </Button>
                    )}
                    {downloadable && exp.downloadZipUrl && (
                      <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
                        <a href={exp.downloadZipUrl} target="_blank" rel="noopener noreferrer"><Package className="w-3.5 h-3.5" />ZIP</a>
                      </Button>
                    )}
                    {st === 'failed' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => handleRetry(exp.id)}
                        disabled={retrying === exp.id}
                      >
                        <RefreshCw className={`w-3 h-3 mr-1 ${retrying === exp.id ? 'animate-spin' : ''}`} />
                        Réessayer
                      </Button>
                    )}
                    {active && (
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <RefreshCw className="w-3 h-3 animate-spin" />
                      </div>
                    )}
                    {!active && st !== 'deleted' && st !== 'expired' && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        title="Supprimer le fichier de cet export"
                        aria-label="Supprimer le fichier de cet export"
                        onClick={() => setDeleteConfirm(exp)}
                        disabled={deleting === exp.id}
                      >
                        {deleting === exp.id
                          ? <RefreshCw className="w-3 h-3 animate-spin" />
                          : <Trash2 className="w-3.5 h-3.5" />}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Confirmation suppression export ── */}
      <AlertDialog open={!!deleteConfirm} onOpenChange={(open) => { if (!open) setDeleteConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer le fichier de cet export ?</AlertDialogTitle>
            <AlertDialogDescription>
              Le fichier de l&apos;export <strong>{typeLabel(deleteConfirm?.exportType ?? '')}</strong> sera supprimé définitivement ; l&apos;entrée reste visible dans l&apos;historique. Les fichiers déjà téléchargés restent disponibles localement.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting !== null}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90 text-white"
              onClick={() => deleteConfirm && handleDelete(deleteConfirm.id)}
              disabled={deleting !== null}
            >
              {deleting !== null ? 'Suppression…' : 'Supprimer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Transfert et récupération (export brut, transmission) ── */}
      {drawerUsage !== null && (
        <TransferExportDrawer
          assetId={assetId}
          usage={drawerUsage}
          planType={premiumRefuse ? 'STANDARD' : planType}
          assetCategory={assetCategory}
          thumbnailUrl={thumbnailUrl}
          onClose={() => setDrawerUsage(null)}
          onSuccess={handleExportCreated}
        />
      )}
    </div>
  );
}
