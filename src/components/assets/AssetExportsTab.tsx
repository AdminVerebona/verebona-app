"use client"

import { useState, useEffect, useCallback, useRef } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FileDown, Send, FileText, Home, Shield, Package, RefreshCw, Download, AlertCircle, CheckCircle2, Clock, XCircle, X, Crown, CalendarDays, Trash2 } from 'lucide-react';
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
import { toast } from 'sonner';
import { ExportPrepareDrawer } from './ExportPrepareDrawer';
import { getPlanTheme } from '@/lib/plan-theme';

export type ExportType =
  | 'CIL_REGLEMENTAIRE'
  | 'DOSSIER_VENTE'
  | 'DOSSIER_COMPLET'
  | 'ASSURANCE_ESTIMATION'
  | 'ASSURANCE_INDEMNISATION'
  | 'EXPORT_BRUT';

interface ExportUsageDef {
  type: ExportType | 'TRANSMISSION';
  label: string;
  description: string;
  icon: React.ElementType;
  section: 'dossiers' | 'transfert';
  premiumOnly: boolean;
  /** Asset categories for which this export type is available. 'ALL' = no restriction. */
  allowedCategories: string[] | 'ALL';
}

const EXPORT_USAGES: ExportUsageDef[] = [
  {
    type: 'CIL_REGLEMENTAIRE',
    label: 'Carnet d\'information du logement',
    description: 'Générez le CIL réglementaire du logement à partir des données et documents disponibles.',
    icon: FileText, section: 'dossiers', premiumOnly: true,
    allowedCategories: ['IMMOBILIER'],
  },
  {
    type: 'DOSSIER_VENTE',
    label: 'Dossier de vente',
    description: 'Ensemble des documents requis pour la mise en vente du bien',
    icon: Home, section: 'dossiers', premiumOnly: true,
    allowedCategories: 'ALL',
  },
  {
    type: 'ASSURANCE_ESTIMATION',
    label: 'Assurance — Estimation',
    description: 'Dossier d\'estimation de valeur pour votre assureur',
    icon: Shield, section: 'dossiers', premiumOnly: true,
    allowedCategories: 'ALL',
  },
  {
    type: 'ASSURANCE_INDEMNISATION',
    label: 'Assurance — Indemnisation',
    description: 'Dossier de déclaration et justificatifs en cas de sinistre',
    icon: Shield, section: 'dossiers', premiumOnly: true,
    allowedCategories: 'ALL',
  },
  {
    type: 'DOSSIER_COMPLET',
    label: 'Dossier complet du bien',
    description: 'Document récapitulatif complet de toutes les informations et documents disponibles dans Verebona.',
    icon: FileText, section: 'dossiers', premiumOnly: true,
    allowedCategories: 'ALL',
  },
  {
    type: 'EXPORT_BRUT',
    label: 'Export données brutes',
    description: 'Tous vos fichiers et données en un ZIP téléchargeable',
    icon: Package, section: 'transfert', premiumOnly: false,
    allowedCategories: 'ALL',
  },
  {
    type: 'TRANSMISSION',
    label: 'Transmission du bien',
    description: 'Partager l\'ensemble du dossier avec un tiers (notaire, acheteur…)',
    icon: Send, section: 'transfert', premiumOnly: false,
    allowedCategories: 'ALL',
  },
];

export interface ExportRecord {
  id: number;
  publicId: string;
  exportType: string;
  status: string;
  requestedOutputs: string[];
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
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
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'ready') return <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />;
  if (status === 'error') return <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />;
  return <Clock className="w-4 h-4 text-blue-400 flex-shrink-0 animate-pulse" />;
}

export const TYPE_LABELS: Record<string, string> = {
  CIL_REGLEMENTAIRE: 'Carnet d\'information du logement',
  DOSSIER_VENTE: 'Dossier de vente',
  DOSSIER_COMPLET: 'Dossier complet du bien',
  ASSURANCE_ESTIMATION: 'Assurance — Estimation',
  ASSURANCE_INDEMNISATION: 'Assurance — Indemnisation',
  EXPORT_BRUT: 'Export données brutes',
  TRANSMISSION: 'Transmission du bien',
};

function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short' }).format(new Date(iso));
}

function formatDateLong(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso));
}

export function AssetExportsTab({ assetId, assetCategory, assetTypeId, planType, thumbnailUrl }: Props) {
  const [exports, setExports] = useState<ExportRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [drawerUsage, setDrawerUsage] = useState<ExportType | 'TRANSMISSION' | null>(null);
  const [retrying, setRetrying] = useState<number | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<ExportRecord | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [transmissions, setTransmissions] = useState<TransmissionRecord[]>([]);
  const [loadingTransmissions, setLoadingTransmissions] = useState(false);
  const [cancellingId, setCancellingId] = useState<number | null>(null);

  // CIL completeness summary (loaded once for IMMOBILIER assets, refreshed after export created)
  const [cilSummary, setCilSummary] = useState<CilPreparationSummary | null>(null);
  const [cilSummaryLoading, setCilSummaryLoading] = useState(false);

  const loadExports = useCallback(async () => {
    try {
      const res = await apiClient.get<{ exports: ExportRecord[] }>(`/api/assets/${assetId}/exports`);
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
    if (assetCategory !== 'IMMOBILIER') return;
    setCilSummaryLoading(true);
    try {
      const res = await apiClient.get<CilPreparationSummary>(`/api/assets/${assetId}/exports/cil/preparation`);
      setCilSummary(res);
    } catch {
      // ignore silently — completeness is informative only
    } finally {
      setCilSummaryLoading(false);
    }
  }, [assetId, assetCategory]);

  useEffect(() => {
    loadExports();
    loadTransmissions();
    loadCilSummary();
  }, [loadExports, loadTransmissions, loadCilSummary]);

  const transmissionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll exports (3s) — seulement si un export est en cours ET onglet visible
  useEffect(() => {
    const hasActive = exports.some(e => e.status === 'pending' || e.status === 'generating');

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
      toast.success('Export supprimé');
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
    await Promise.all([loadExports(), loadTransmissions(), loadCilSummary()]);
  }, [loadExports, loadTransmissions, loadCilSummary]);

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

  const isAllowed = (usage: ExportUsageDef) =>
    usage.allowedCategories === 'ALL' || usage.allowedCategories.includes(assetCategory);

  const dossierUsages = EXPORT_USAGES.filter(u => u.section === 'dossiers' && isAllowed(u));
  const transfertUsages = EXPORT_USAGES.filter(u => u.section === 'transfert' && isAllowed(u));

  const isLocked = (usage: ExportUsageDef) => usage.premiumOnly && planType === 'STANDARD';

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
            const isCilRegl = usage.type === 'CIL_REGLEMENTAIRE';
            const showCilInfo = isCilRegl && assetCategory === 'IMMOBILIER' && !locked;

            return (
              <button
                key={usage.type}
                onClick={() => setDrawerUsage(usage.type)}
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
                onClick={() => setDrawerUsage(usage.type)}
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

      {/* ── Historique des exports ── */}
      <div>
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
            {exports.map(exp => (
              <div
                key={exp.id}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg border bg-card text-sm"
              >
                <StatusIcon status={exp.status} />
                <div className="flex-1 min-w-0">
                  <span className="font-medium truncate block">{TYPE_LABELS[exp.exportType] ?? exp.exportType}</span>
                  {exp.status === 'error' && exp.errorMessage && (
                    <p className="text-xs text-red-500 truncate mt-0.5">{exp.errorMessage}</p>
                  )}
                  {(exp.status === 'pending' || exp.status === 'generating') && (
                    <p className="text-xs text-muted-foreground mt-0.5">En cours…</p>
                  )}
                </div>
                {exp.completedAt && (
                  <span className="text-xs text-muted-foreground flex-shrink-0">{formatDate(exp.completedAt)}</span>
                )}
                <div className="flex items-center gap-1 flex-shrink-0">
                  {exp.status === 'ready' && exp.downloadUrl && (
                    <a href={exp.downloadUrl} target="_blank" rel="noopener noreferrer" title="Télécharger PDF">
                      <Button size="icon" variant="ghost" className="h-7 w-7">
                        <Download className="w-3.5 h-3.5" />
                      </Button>
                    </a>
                  )}
                  {exp.status === 'ready' && exp.downloadZipUrl && (
                    <a href={exp.downloadZipUrl} target="_blank" rel="noopener noreferrer" title="Télécharger ZIP">
                      <Button size="icon" variant="ghost" className="h-7 w-7">
                        <Package className="w-3.5 h-3.5" />
                      </Button>
                    </a>
                  )}
                  {exp.status === 'error' && (
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
                  {(exp.status === 'pending' || exp.status === 'generating') && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <RefreshCw className="w-3 h-3 animate-spin" />
                    </div>
                  )}
                  {exp.status !== 'generating' && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      title="Supprimer cet export"
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
            ))}
          </div>
        )}
      </div>

      {/* ── Confirmation suppression export ── */}
      <AlertDialog open={!!deleteConfirm} onOpenChange={(open) => { if (!open) setDeleteConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer cet export ?</AlertDialogTitle>
            <AlertDialogDescription>
              L&apos;export <strong>{TYPE_LABELS[deleteConfirm?.exportType ?? ''] ?? deleteConfirm?.exportType}</strong> sera supprimé définitivement. Les fichiers téléchargés restent disponibles localement.
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

      {/* ── Drawer de préparation ── */}
      {drawerUsage !== null && (
        <ExportPrepareDrawer
          assetId={assetId}
          usage={drawerUsage}
          planType={planType}
          assetCategory={assetCategory}
          thumbnailUrl={thumbnailUrl}
          onClose={() => setDrawerUsage(null)}
          onSuccess={handleExportCreated}
        />
      )}
    </div>
  );
}
