"use client"

import { useState, useEffect, useCallback } from 'react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Lock, Loader2, FileText, Home, Shield, Package, Send, Crown,
  ChevronDown, ChevronRight, Image, Wrench,
  X, Download, FileDown, Check, Link, CalendarDays, AlertCircle,
  CheckCircle2, HelpCircle, MinusCircle, XCircle, ChevronUp, ArrowRight,
} from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
import type { ExportType } from './AssetExportsTab';
import { DOCUMENT_TYPE_LABELS, CIL_RUBRIC_CODES } from '@/lib/document-type-constants';
import { getPlanTheme } from '@/lib/plan-theme';

type Usage = ExportType | 'TRANSMISSION';

interface DocItem  { id: number; name: string; documentType: string; documentDate: string | null; functionCode: string | null; cilRubricCodes: string[] | null; isWebLink?: boolean; }
interface PhotoItem { id: number; name: string; }
interface EquipItem { id: number; name: string; category?: string; }
interface AgendaItem { id: number; title: string; startDate: string | null; }

interface Props {
  assetId: number;
  usage: Usage;
  planType: string;
  assetCategory: string;
  thumbnailUrl?: string | null;
  onClose: () => void;
  onSuccess: () => void;
}

const USAGE_META: Record<Usage, { label: string; icon: React.ElementType; premiumOnly: boolean }> = {
  CIL_REGLEMENTAIRE:       { label: 'CIL Réglementaire',         icon: FileText, premiumOnly: true },
  DOSSIER_VENTE:           { label: 'Dossier de vente',          icon: Home,     premiumOnly: true },
  DOSSIER_COMPLET:         { label: 'Dossier complet du bien',   icon: FileText, premiumOnly: true },
  ASSURANCE_ESTIMATION:    { label: 'Assurance — Estimation',    icon: Shield,   premiumOnly: true },
  ASSURANCE_INDEMNISATION: { label: 'Assurance — Indemnisation', icon: Shield,   premiumOnly: true },
  EXPORT_BRUT:             { label: 'Export données brutes',     icon: Package,  premiumOnly: false },
  TRANSMISSION:            { label: 'Transmission du bien',      icon: Send,     premiumOnly: false },
};

// Which categories get docs/photos/equips selection per usage
const USAGE_HAS_DOCS: Record<Usage, boolean>   = { CIL_REGLEMENTAIRE: true, DOSSIER_VENTE: true, DOSSIER_COMPLET: true, ASSURANCE_ESTIMATION: true, ASSURANCE_INDEMNISATION: true, EXPORT_BRUT: true, TRANSMISSION: true };
const USAGE_HAS_PHOTOS: Record<Usage, boolean> = { CIL_REGLEMENTAIRE: false, DOSSIER_VENTE: true, DOSSIER_COMPLET: true, ASSURANCE_ESTIMATION: true, ASSURANCE_INDEMNISATION: true, EXPORT_BRUT: true, TRANSMISSION: true };
const USAGE_HAS_EQUIPS: Record<Usage, boolean> = { CIL_REGLEMENTAIRE: false, DOSSIER_VENTE: true, DOSSIER_COMPLET: true, ASSURANCE_ESTIMATION: false, ASSURANCE_INDEMNISATION: false, EXPORT_BRUT: true, TRANSMISSION: true };

function SectionHeader({
  icon: Icon, label, count, open, onToggle, allChecked, someChecked, onToggleAll, disabled,
}: {
  icon: React.ElementType; label: string; count: number; open: boolean; onToggle: () => void;
  allChecked: boolean; someChecked: boolean; onToggleAll: () => void; disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 py-2.5 px-3 rounded-lg hover:bg-muted/40 transition-colors">
      <Checkbox
        checked={allChecked ? true : someChecked ? 'indeterminate' : false}
        onCheckedChange={onToggleAll}
        disabled={disabled}
        onClick={(e) => e.stopPropagation()}
      />
      <button
        type="button"
        className="flex-1 flex items-center gap-2 min-w-0 text-left"
        onClick={onToggle}
        disabled={disabled}
      >
        <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium flex-1">{label}</span>
        <Badge variant="secondary" className="text-[10px] px-1.5 shrink-0">{count}</Badge>
        {open ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
      </button>
    </div>
  );
}

// ── CIL Block types ──────────────────────────────────────────────────────────

type CilBlockStatus = 'complete' | 'not_applicable' | 'missing' | 'invalid' | 'unknown';

interface CilMissingItem {
  id: string;
  label: string;
  target: { type: string; filter?: string };
  actionLabel: string;
}

interface CilBlock {
  id: string;
  label: string;
  status: CilBlockStatus;
  blocking: boolean;
  missingItems: CilMissingItem[];
}

interface CilPreparation {
  assetId: number;
  eligible: boolean;
  eligibilityReason?: string;
  globalStatus?: 'ready' | 'action_required';
  completion?: { resolvedBlocks: number; applicableBlocks: number; totalBlocks: number; percentage: number };
  blocks?: CilBlock[];
  lastGeneration?: { id: number; publicId: string; createdAt: string; status: string; downloadUrl: string | null } | null;
  assetName?: string;
  assetAddress?: string;
  assetSubtype?: string;
}

function CilBlockStatusBadge({ status }: { status: CilBlockStatus }) {
  const configs: Record<CilBlockStatus, { label: string; className: string; icon: React.ElementType }> = {
    complete:       { label: 'Complet',         className: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-800', icon: CheckCircle2 },
    not_applicable: { label: 'Non applicable',  className: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700', icon: MinusCircle },
    missing:        { label: 'À compléter',     className: 'bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-400 dark:border-rose-800', icon: XCircle },
    invalid:        { label: 'À corriger',      className: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-400 dark:border-orange-800', icon: AlertCircle },
    unknown:        { label: 'À vérifier',      className: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-800', icon: HelpCircle },
  };
  const { label, className, icon: Icon } = configs[status];
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold border ${className}`}>
      <Icon className="w-2.5 h-2.5" />
      {label}
    </span>
  );
}

export function ExportPrepareDrawer({ assetId, usage, planType, assetCategory, thumbnailUrl, onClose, onSuccess }: Props) {
  const meta = USAGE_META[usage];
  const isLocked = meta.premiumOnly && planType === 'STANDARD';
  const Icon = meta.icon;

  // CIL preparation state (only for CIL_REGLEMENTAIRE)
  const [cilPrep, setCilPrep] = useState<CilPreparation | null>(null);
  const [cilLoading, setCilLoading] = useState(false);
  const [expandedBlock, setExpandedBlock] = useState<string | null>(null);
  // CIL material form
  const [showMaterialForm, setShowMaterialForm] = useState(false);
  const [matCategory, setMatCategory] = useState('');
  const [matNature, setMatNature] = useState('');
  const [matBrand, setMatBrand] = useState('');
  const [matR, setMatR] = useState('');
  const [savingMaterial, setSavingMaterial] = useState(false);

  const loadCilPrep = useCallback(async () => {
    if (usage !== 'CIL_REGLEMENTAIRE' || isLocked) return;
    setCilLoading(true);
    try {
      const res = await apiClient.get<CilPreparation>(`/api/assets/${assetId}/exports/cil/preparation`);
      setCilPrep(res);
    } catch (err) {
      console.error('[CIL prep]', err);
    } finally {
      setCilLoading(false);
    }
  }, [assetId, usage, isLocked]);

  useEffect(() => {
    if (usage === 'CIL_REGLEMENTAIRE') loadCilPrep();
  }, [usage, loadCilPrep]);

  const handleSetResolution = async (blockId: string, resolution: 'not_applicable' | 'unknown_confirmed') => {
    try {
      await apiClient.patch(`/api/assets/${assetId}/exports/cil/resolutions`, { blockId, resolution });
      await loadCilPrep();
    } catch {
      toast.error('Erreur lors de la mise à jour');
    }
  };

  const handleClearResolution = async (blockId: string) => {
    try {
      await apiClient.delete(`/api/assets/${assetId}/exports/cil/resolutions?blockId=${blockId}`);
      await loadCilPrep();
    } catch {
      toast.error('Erreur lors de la mise à jour');
    }
  };

  const handleSaveMaterial = async () => {
    if (!matCategory) { toast.error('Catégorie requise'); return; }
    setSavingMaterial(true);
    try {
      await apiClient.post(`/api/assets/${assetId}/energy-materials`, {
        category: matCategory,
        materialNature: matNature || null,
        brand: matBrand || null,
        thermalResistanceR: matR ? parseFloat(matR) : null,
      });
      setShowMaterialForm(false);
      setMatCategory(''); setMatNature(''); setMatBrand(''); setMatR('');
      await loadCilPrep();
      toast.success('Matériau enregistré');
    } catch {
      toast.error('Erreur lors de l\'enregistrement');
    } finally {
      setSavingMaterial(false);
    }
  };

  // Data
  const [docs, setDocs]   = useState<DocItem[]>([]);
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [equips, setEquips] = useState<EquipItem[]>([]);
  const [agendaItemsList, setAgendaItemsList] = useState<AgendaItem[]>([]);
  const [loadingData, setLoadingData] = useState(false);
  const [loadElapsed, setLoadElapsed] = useState(0);
  const [loadStage, setLoadStage] = useState(0);

  // Selection state
  const [selectedDocIds, setSelectedDocIds]   = useState<Set<number>>(new Set());
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<number>>(new Set());
  const [selectedEquipIds, setSelectedEquipIds] = useState<Set<number>>(new Set());
  const [selectedAgendaIds, setSelectedAgendaIds] = useState<Set<number>>(new Set());

  // Section open/closed
  const [docsOpen, setDocsOpen]   = useState(true);
  const [photosOpen, setPhotosOpen] = useState(false);
  const [equipsOpen, setEquipsOpen] = useState(false);
  const [agendaOpen, setAgendaOpen] = useState(false);

  // Options
  const [requestZip, setRequestZip] = useState(false);
  const [recipientEmail, setRecipientEmail] = useState('');
  // Transmission: keep asset active after transmission (default: false = mark as TRANSMIS)
  const [keepActiveAfterTransmission, setKeepActiveAfterTransmission] = useState(false);
  // Transmission: include thumbnail in transfer (default: true when thumbnail exists)
  const [includeThumbnail, setIncludeThumbnail] = useState(true);

  // Submission
  const [generating, setGenerating] = useState(false);

  // Light preview

  const showDocs   = USAGE_HAS_DOCS[usage];
  const showPhotos = USAGE_HAS_PHOTOS[usage];
  // Equipments only exist for IMMOBILIER assets — never show for vehicles or objects
  const showEquips = USAGE_HAS_EQUIPS[usage] && assetCategory === 'IMMOBILIER';

  // Build loading stages dynamically — only include what will actually be fetched
  const LOAD_STAGES = [
    showDocs   && { label: 'Récupération des documents…', pct: 0 },
    showPhotos && { label: 'Chargement des photos…',      pct: 0 },
    showEquips && { label: 'Chargement des équipements…', pct: 0 },
  ].filter(Boolean).map((s, i, arr) => ({
    ...(s as { label: string; pct: number }),
    pct: Math.round(((i + 1) / arr.length) * 85),
  }));

  // Elapsed timer + stage cycling while loading
  useEffect(() => {
    if (!loadingData) return;
    setLoadElapsed(0);
    setLoadStage(0);
    const maxStage = Math.max(0, LOAD_STAGES.length - 1);
    const timer = setInterval(() => setLoadElapsed(s => s + 1), 1000);
    const stages = setInterval(() => setLoadStage(s => Math.min(s + 1, maxStage)), 1200);
    return () => { clearInterval(timer); clearInterval(stages); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingData]);

  // Load asset data
  useEffect(() => {
    if (isLocked) {
      setLoadingData(false);
      return;
    }
    setLoadingData(true);

    let cancelled = false;

    // Wrap apiClient calls with a 30s timeout race
    const withTimeout = <T,>(promise: Promise<T>, ms = 30000): Promise<T | null> =>
      Promise.race([
        promise.then(v => v).catch((err) => { console.error('[ExportDrawer] fetch error:', err); return null as T | null; }),
        new Promise<null>(resolve => setTimeout(() => { console.warn('[ExportDrawer] fetch timeout'); resolve(null); }, ms)),
      ]);

    const fetchAll = async () => {
      try {
        await Promise.all([
          // Documents + Photos — single call, split client-side
          (showDocs || showPhotos)
            ? withTimeout(apiClient.get<any>(`/api/files?assetId=${assetId}&uploadStatus=COMPLETED&limit=500`))
                .then((res: any) => {
                  if (cancelled) return;
                  const allFiles: any[] = Array.isArray(res) ? res : (res?.data ?? []);
                  if (showDocs) {
                    let realDocs = allFiles.filter((f: any) => !f.mimeType?.startsWith('image/'));
                    if (usage === 'CIL_REGLEMENTAIRE') {
                      realDocs = realDocs.filter((f: any) =>
                        CIL_RUBRIC_CODES.has(f.retainedFunctionCode) ||
                        CIL_RUBRIC_CODES.has(f.documentType) ||
                        (Array.isArray(f.cilRubricCodes) && f.cilRubricCodes.some((c: string) => CIL_RUBRIC_CODES.has(c)))
                      );
                    }
                    const mappedDocs: DocItem[] = realDocs.map((f: any) => ({
                      id: f.id,
                      name: f.retainedTitle || f.originalFilename || `Document ${f.id}`,
                      documentType: f.documentType ?? '',
                      documentDate: f.documentDate ?? null,
                      functionCode: f.retainedFunctionCode ?? null,
                      isWebLink: f.isWebLink ?? false,
                      cilRubricCodes: Array.isArray(f.cilRubricCodes) ? f.cilRubricCodes
                        : typeof f.cilRubricCodes === 'string' ? (() => { try { return JSON.parse(f.cilRubricCodes); } catch { return null; } })()
                        : null,
                    }));
                    setDocs(mappedDocs);
                    setSelectedDocIds(new Set(mappedDocs.map(d => d.id)));
                  }
                  if (showPhotos) {
                    const photoFiles = allFiles.filter((f: any) => f.mimeType?.startsWith('image/') && !f.isWebLink);
                    const mappedPhotos: PhotoItem[] = photoFiles.map((p: any) => ({
                      id: p.id,
                      name: p.retainedTitle || p.originalFilename || `Photo ${p.id}`,
                    }));
                    setPhotos(mappedPhotos);
                    setSelectedPhotoIds(new Set(mappedPhotos.map(p => p.id)));
                  }
                })
            : Promise.resolve(),

          // Equipments (IMMOBILIER only)
          showEquips
            ? withTimeout(apiClient.get<any>(`/api/assets/${assetId}/equipments`))
                .then((eqs: any) => {
                  if (cancelled) return;
                  const eqList: any[] = Array.isArray(eqs) ? eqs : (eqs?.data ?? eqs?.items ?? []);
                  const mapped: EquipItem[] = eqList.map((e: any) => ({ id: e.id, name: e.name, category: e.category }));
                  setEquips(mapped);
                  setSelectedEquipIds(new Set(mapped.map(e => e.id)));
                })
            : Promise.resolve(),

          // Agenda items — TRANSMISSION only
          usage === 'TRANSMISSION'
            ? withTimeout(apiClient.get<any>(`/api/agenda?assetIds=${assetId}&period=all&includeUndated=true&includeCancelled=false`))
                .then((res: any) => {
                  if (cancelled) return;
                  const list: any[] = Array.isArray(res) ? res : (res?.items ?? res?.data ?? []);
                  const mapped: AgendaItem[] = list.map((a: any) => ({
                    id: a.id,
                    title: a.title,
                    startDate: a.startDate ?? null,
                  }));
                  setAgendaItemsList(mapped);
                  setSelectedAgendaIds(new Set(mapped.map(a => a.id)));
                })
            : Promise.resolve(),
        ]);
      } catch (err) {
        console.error('[ExportDrawer] load error', err);
      } finally {
        if (!cancelled) setLoadingData(false);
      }
    };
    fetchAll();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, usage, isLocked]);

  const toggleDoc    = (id: number) => setSelectedDocIds(s    => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const togglePhoto  = (id: number) => setSelectedPhotoIds(s  => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleEquip  = (id: number) => setSelectedEquipIds(s  => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAgenda = (id: number) => setSelectedAgendaIds(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const toggleAllDocs    = () => setSelectedDocIds(s    => s.size === docs.length          ? new Set() : new Set(docs.map(d => d.id)));
  const toggleAllPhotos  = () => setSelectedPhotoIds(s  => s.size === photos.length        ? new Set() : new Set(photos.map(p => p.id)));
  const toggleAllEquips  = () => setSelectedEquipIds(s  => s.size === equips.length        ? new Set() : new Set(equips.map(e => e.id)));
  const toggleAllAgenda  = () => setSelectedAgendaIds(s => s.size === agendaItemsList.length ? new Set() : new Set(agendaItemsList.map(a => a.id)));

  const handleGenerate = useCallback(async (requestedOutputs?: string[]) => {
    if (isLocked) return;
    setGenerating(true);
    try {
      if (usage === 'TRANSMISSION') {
        if (!recipientEmail.trim()) {
          toast.error('Veuillez saisir l\'adresse email du destinataire');
          return;
        }
        await apiClient.post(`/api/assets/${assetId}/transmission`, {
          recipientEmail: recipientEmail.trim(),
          keepActiveAfterTransmission,
          selectedPayload: {
            includeDocuments: selectedDocIds.size > 0,
            selectedDocIds: Array.from(selectedDocIds),
            includeEquipments: selectedEquipIds.size > 0,
            selectedEquipmentIds: Array.from(selectedEquipIds),
            includePhotos: selectedPhotoIds.size > 0,
            selectedPhotoIds: Array.from(selectedPhotoIds),
            includeEvents: selectedAgendaIds.size > 0,
            selectedEventIds: Array.from(selectedAgendaIds),
            includeThumbnail: !!(thumbnailUrl && includeThumbnail),
          },
        });
        toast.success('Invitation de transmission envoyée');
        onSuccess();
      } else {
        // Use caller-supplied outputs, or derive defaults
        let outputs: string[];
        if (requestedOutputs) {
          outputs = requestedOutputs;
        } else if (usage === 'EXPORT_BRUT') {
          outputs = ['ZIP'];
        } else {
          outputs = ['PDF'];
          if (requestZip && planType !== 'STANDARD') outputs.push('ZIP');
        }

        const options: Record<string, unknown> = {
          includePhotos: selectedPhotoIds.size > 0,
          includeEquipments: selectedEquipIds.size > 0,
          customDocIds: selectedDocIds.size > 0 && selectedDocIds.size < docs.length
            ? Array.from(selectedDocIds)
            : undefined,
        };

        const res = await apiClient.post<{ exportId: number; status: string; errorMessage?: string; downloadUrl?: string; downloadZipUrl?: string }>(
          `/api/assets/${assetId}/exports`,
          { exportType: usage, requestedOutputs: outputs, options },
        );

        if (res.status === 'error') {
          toast.error(res.errorMessage ?? 'Erreur lors de la génération');
        } else {
          toast.success('Export généré avec succès');
          // Open download(s) in new tab
          if (res.downloadUrl) {
            window.open(res.downloadUrl, '_blank', 'noopener,noreferrer');
          }
          if (res.downloadZipUrl) {
            setTimeout(() => {
              window.open(res.downloadZipUrl!, '_blank', 'noopener,noreferrer');
            }, 400);
          }
        }
        onSuccess();
      }
    } catch (err: any) {
      toast.error(err?.message ?? 'Erreur lors de la génération');
    } finally {
      setGenerating(false);
    }
  }, [assetId, usage, isLocked, planType, selectedDocIds, selectedPhotoIds, selectedEquipIds, docs.length, requestZip, recipientEmail, keepActiveAfterTransmission, includeThumbnail, thumbnailUrl, onSuccess]);

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="flex flex-col p-0 w-full sm:max-w-lg"
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 px-6 py-5 border-b shrink-0">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Icon className="w-4 h-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-base leading-tight">
              {usage === 'CIL_REGLEMENTAIRE' ? 'Préparer le Carnet d\'information du logement' : usage === 'DOSSIER_COMPLET' ? 'Préparer le Dossier complet du bien' : meta.label}
            </h2>
            {usage === 'CIL_REGLEMENTAIRE' && (
              <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                Verebona vérifie les données nécessaires pour générer un CIL complet pour ce logement.
              </p>
            )}
            {usage === 'DOSSIER_COMPLET' && (
              <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                Document récapitulatif de toutes les informations et documents du bien dans Verebona.
              </p>
            )}
          </div>
          {isLocked && (
            <Badge variant="secondary" className="text-[10px] px-1.5 shrink-0">
              <Lock className="w-2.5 h-2.5 mr-1" />Premium
            </Badge>
          )}
        </div>

        {/* ── Scrollable body ─────────────────────────────────────────────── */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="px-6 py-5 space-y-6">

            {/* ── Loading ─────────────────────────────────────────────────── */}
            {loadingData && (() => {
              const stage = LOAD_STAGES[Math.min(loadStage, LOAD_STAGES.length - 1)];
              const fmtTime = (s: number) => s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
              return (
                <div className="py-4 space-y-5">
                  {/* Icon + label */}
                  <div className="flex flex-col items-center gap-3 text-center">
                    <div className="relative w-12 h-12">
                      <div className="absolute inset-0 rounded-full bg-primary/10 animate-pulse" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Loader2 className="w-5 h-5 text-primary animate-spin" />
                      </div>
                    </div>
                    <div>
                      <p className="text-sm font-semibold">Préparation du dossier</p>
                      <p className="text-xs text-muted-foreground mt-0.5 transition-all">{stage.label}</p>
                    </div>
                  </div>
                  {/* Progress bar + timer */}
                  <div className="space-y-1.5">
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-[1500ms] ease-out"
                        style={{ width: `${stage.pct}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>{stage.pct}%</span>
                      <span>{fmtTime(loadElapsed)} écoulé</span>
                    </div>
                  </div>
                  {/* Steps */}
                  <div className="space-y-2">
                    {LOAD_STAGES.map((s, i) => (
                      <div key={i} className="flex items-center gap-2.5">
                        <div className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 transition-all ${
                          i < loadStage ? 'bg-primary' : i === loadStage ? 'border-2 border-primary' : 'border border-muted-foreground/30'
                        }`}>
                          {i < loadStage && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                          {i === loadStage && <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />}
                        </div>
                        <span className={`text-xs transition-all ${
                          i < loadStage ? 'text-primary' : i === loadStage ? 'text-foreground font-medium' : 'text-muted-foreground/40'
                        }`}>{s.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* ── Selection sections ───────────────────────────────────────── */}
            {!loadingData && (
              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                  Contenu à inclure
                </p>

                {/* Documents */}
                {showDocs && (
                  <div className="rounded-xl border bg-card overflow-hidden">
                    <SectionHeader
                      icon={FileText} label="Documents" count={selectedDocIds.size}
                      open={docsOpen} onToggle={() => setDocsOpen(v => !v)}
                      allChecked={selectedDocIds.size === docs.length && docs.length > 0}
                      someChecked={selectedDocIds.size > 0 && selectedDocIds.size < docs.length}
                      onToggleAll={toggleAllDocs}
                      disabled={isLocked}
                    />
                    {docsOpen && docs.length > 0 && (
                      <div className="border-t divide-y">
                        {docs.map(doc => (
                          <label
                            key={doc.id}
                            className={`flex items-start gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors cursor-pointer ${isLocked ? 'pointer-events-none opacity-50' : ''}`}
                          >
                            <Checkbox
                              checked={selectedDocIds.has(doc.id)}
                              onCheckedChange={() => toggleDoc(doc.id)}
                              disabled={isLocked}
                              className="mt-0.5 shrink-0"
                            />
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-medium leading-snug truncate flex items-center gap-1">
                                {doc.isWebLink && <Link className="w-3 h-3 shrink-0 text-muted-foreground" />}
                                {doc.name}
                              </p>
                              <p className="text-[10px] text-muted-foreground mt-0.5">
                                {DOCUMENT_TYPE_LABELS[doc.documentType] ?? doc.documentType}
                                {doc.documentDate ? ` · ${new Date(doc.documentDate + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
                              </p>
                            </div>
                          </label>
                        ))}
                      </div>
                    )}
                    {docsOpen && docs.length === 0 && !loadingData && (
                      <p className="text-xs text-muted-foreground px-4 py-3 border-t">Aucun document qualifié</p>
                    )}
                  </div>
                )}

                {/* Photos */}
                {showPhotos && (
                  <div className="rounded-xl border bg-card overflow-hidden">
                    <SectionHeader
                      icon={Image} label="Photos" count={selectedPhotoIds.size + (usage === 'TRANSMISSION' && !!thumbnailUrl && includeThumbnail ? 1 : 0)}
                      open={photosOpen} onToggle={() => setPhotosOpen(v => !v)}
                      allChecked={selectedPhotoIds.size === photos.length && photos.length > 0 && (usage !== 'TRANSMISSION' || !thumbnailUrl || includeThumbnail)}
                      someChecked={selectedPhotoIds.size > 0 && selectedPhotoIds.size < photos.length}
                      onToggleAll={toggleAllPhotos}
                      disabled={isLocked}
                    />
                    {photosOpen && (
                      <div className="border-t divide-y">
                        {/* Thumbnail — TRANSMISSION only */}
                        {usage === 'TRANSMISSION' && !!thumbnailUrl && (
                          <label className={`flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors cursor-pointer ${isLocked ? 'pointer-events-none opacity-50' : ''}`}>
                            <Checkbox
                              checked={includeThumbnail}
                              onCheckedChange={(v) => setIncludeThumbnail(!!v)}
                              disabled={isLocked}
                              className="shrink-0"
                            />
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-medium truncate">Vignette du bien</p>
                              <p className="text-[10px] text-muted-foreground">Photo principale affichée sur la fiche</p>
                            </div>
                          </label>
                        )}
                        {photos.map(ph => (
                          <label
                            key={ph.id}
                            className={`flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors cursor-pointer ${isLocked ? 'pointer-events-none opacity-50' : ''}`}
                          >
                            <Checkbox
                              checked={selectedPhotoIds.has(ph.id)}
                              onCheckedChange={() => togglePhoto(ph.id)}
                              disabled={isLocked}
                              className="shrink-0"
                            />
                            <p className="text-xs font-medium truncate flex-1">{ph.name}</p>
                          </label>
                        ))}
                        {photos.length === 0 && !thumbnailUrl && !loadingData && (
                          <p className="text-xs text-muted-foreground px-4 py-3">Aucune photo</p>
                        )}
                      </div>
                    )}
                    {!photosOpen && photos.length === 0 && !thumbnailUrl && !loadingData && (
                      <p className="text-xs text-muted-foreground px-4 py-3 border-t">Aucune photo</p>
                    )}
                  </div>
                )}

                {/* Équipements */}
                {showEquips && (
                  <div className="rounded-xl border bg-card overflow-hidden">
                    <SectionHeader
                      icon={Wrench} label="Équipements" count={selectedEquipIds.size}
                      open={equipsOpen} onToggle={() => setEquipsOpen(v => !v)}
                      allChecked={selectedEquipIds.size === equips.length && equips.length > 0}
                      someChecked={selectedEquipIds.size > 0 && selectedEquipIds.size < equips.length}
                      onToggleAll={toggleAllEquips}
                      disabled={isLocked}
                    />
                    {equipsOpen && equips.length > 0 && (
                      <div className="border-t divide-y">
                        {equips.map(eq => (
                          <label
                            key={eq.id}
                            className={`flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors cursor-pointer ${isLocked ? 'pointer-events-none opacity-50' : ''}`}
                          >
                            <Checkbox
                              checked={selectedEquipIds.has(eq.id)}
                              onCheckedChange={() => toggleEquip(eq.id)}
                              disabled={isLocked}
                              className="shrink-0"
                            />
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-medium truncate">{eq.name}</p>
                              {eq.category && <p className="text-[10px] text-muted-foreground">{eq.category}</p>}
                            </div>
                          </label>
                        ))}
                      </div>
                    )}
                        {equipsOpen && equips.length === 0 && !loadingData && (
                      <p className="text-xs text-muted-foreground px-4 py-3 border-t">Aucun équipement</p>
                    )}
                  </div>
                )}

                {/* Agenda — TRANSMISSION only */}
                {usage === 'TRANSMISSION' && (
                  <div className="rounded-xl border bg-card overflow-hidden">
                    <SectionHeader
                      icon={CalendarDays} label="Agenda" count={selectedAgendaIds.size}
                      open={agendaOpen} onToggle={() => setAgendaOpen(v => !v)}
                      allChecked={selectedAgendaIds.size === agendaItemsList.length && agendaItemsList.length > 0}
                      someChecked={selectedAgendaIds.size > 0 && selectedAgendaIds.size < agendaItemsList.length}
                      onToggleAll={toggleAllAgenda}
                      disabled={isLocked}
                    />
                    {agendaOpen && agendaItemsList.length > 0 && (
                      <div className="border-t divide-y">
                        {agendaItemsList.map(item => (
                          <label
                            key={item.id}
                            className={`flex items-start gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors cursor-pointer ${isLocked ? 'pointer-events-none opacity-50' : ''}`}
                          >
                            <Checkbox
                              checked={selectedAgendaIds.has(item.id)}
                              onCheckedChange={() => toggleAgenda(item.id)}
                              disabled={isLocked}
                              className="mt-0.5 shrink-0"
                            />
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-medium leading-snug truncate">{item.title}</p>
                              {item.startDate && (
                                <p className="text-[10px] text-muted-foreground mt-0.5">
                                  {new Date(item.startDate + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}
                                </p>
                              )}
                            </div>
                          </label>
                        ))}
                      </div>
                    )}
                    {agendaOpen && agendaItemsList.length === 0 && !loadingData && (
                      <p className="text-xs text-muted-foreground px-4 py-3 border-t">Aucun élément agenda</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── CIL Réglementaire : Blocs de complétude B1-B9 ───────────── */}
            {usage === 'CIL_REGLEMENTAIRE' && !isLocked && (() => {
              if (cilLoading) {
                return (
                  <div className="py-6 flex flex-col items-center gap-3 text-muted-foreground">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <p className="text-xs">Vérification des données…</p>
                  </div>
                );
              }

              if (!cilPrep) return null;

              if (!cilPrep.eligible) {
                return (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 px-4 py-3 text-xs text-amber-700 dark:text-amber-400">
                    Le CIL réglementaire est disponible uniquement pour les maisons et appartements.
                  </div>
                );
              }

              const { completion, blocks = [], globalStatus, lastGeneration, assetName, assetAddress, assetSubtype } = cilPrep;
              const pct = completion?.percentage ?? 0;
              const isReady = globalStatus === 'ready';

              return (
                <div className="space-y-4">
                  {/* En-tête bien */}
                  <div className="rounded-xl border bg-card px-4 py-3 space-y-1">
                    <p className="text-sm font-semibold truncate">{assetName}</p>
                    {assetAddress && <p className="text-xs text-muted-foreground truncate">{assetAddress}</p>}
                    <div className="flex items-center gap-2 mt-1">
                      {assetSubtype && <Badge variant="secondary" className="text-[10px]">{assetSubtype}</Badge>}
                      {lastGeneration?.status === 'ready' && (
                        <span className="text-[10px] text-muted-foreground">
                          Dernier CIL généré le {new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(lastGeneration.createdAt))}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Résumé complétude */}
                  <div className="rounded-xl border bg-card px-4 py-3 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium">
                        {isReady ? 'Toutes les informations nécessaires sont disponibles ou marquées comme non applicables.' : 'Certaines informations nécessaires au CIL complet sont à renseigner.'}
                      </span>
                      <span className={`font-bold tabular-nums shrink-0 ml-2 ${pct === 100 ? 'text-emerald-500' : pct >= 60 ? 'text-amber-500' : 'text-rose-500'}`}>
                        {pct}%
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${pct === 100 ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-500' : 'bg-rose-500'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      {completion?.resolvedBlocks} / {completion?.totalBlocks} blocs complets
                    </p>
                  </div>

                  {/* Blocs B1-B9 */}
                  <div className="space-y-2">
                    {blocks.map(block => {
                      const isExpanded = expandedBlock === block.id;
                      const hasActions = block.missingItems.length > 0 || block.status === 'unknown' || block.status === 'missing';

                      return (
                        <div key={block.id} className="rounded-xl border bg-card overflow-hidden">
                          <button
                            type="button"
                            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors text-left"
                            onClick={() => hasActions ? setExpandedBlock(isExpanded ? null : block.id) : undefined}
                          >
                            <span className="text-[10px] font-bold text-muted-foreground w-5 shrink-0">{block.id}</span>
                            <span className="text-xs font-medium flex-1 truncate">{block.label}</span>
                            <CilBlockStatusBadge status={block.status} />
                            {hasActions && (
                              isExpanded
                                ? <ChevronUp className="w-3 h-3 text-muted-foreground shrink-0" />
                                : <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
                            )}
                          </button>

                          {isExpanded && (
                            <div className="border-t px-4 py-3 space-y-3 bg-muted/20">
                              {/* Missing items */}
                              {block.missingItems.length > 0 && (
                                <div className="space-y-2">
                                  {block.missingItems.map(item => (
                                    <div key={item.id} className="flex items-center gap-2">
                                      <AlertCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                      <span className="text-xs flex-1 text-muted-foreground">{item.label}</span>
                                      {/* Action for energy_materials */}
                                      {item.target.type === 'energy_materials' && (
                                        <button
                                          type="button"
                                          className="text-[10px] font-semibold text-primary hover:underline shrink-0 flex items-center gap-1"
                                          onClick={() => setShowMaterialForm(true)}
                                        >
                                          {item.actionLabel} <ArrowRight className="w-3 h-3" />
                                        </button>
                                      )}
                                      {/* Action for documents */}
                                      {item.target.type === 'documents' && (
                                        <span className="text-[10px] text-muted-foreground shrink-0">→ onglet Documents</span>
                                      )}
                                      {/* Action for equipments */}
                                      {item.target.type === 'equipments' && (
                                        <span className="text-[10px] text-muted-foreground shrink-0">→ onglet Équipements</span>
                                      )}
                                      {/* Action for agenda */}
                                      {item.target.type === 'agenda' && (
                                        <span className="text-[10px] text-muted-foreground shrink-0">→ onglet Suivi</span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}

                              {/* Material form inline */}
                              {block.id === 'B5' && showMaterialForm && (
                                <div className="rounded-lg border bg-background p-3 space-y-3">
                                  <p className="text-xs font-semibold">Ajouter un matériau isolant</p>
                                  <div className="space-y-2">
                                    <Label className="text-xs">Catégorie *</Label>
                                    <Select value={matCategory} onValueChange={setMatCategory}>
                                      <SelectTrigger className="h-8 text-xs">
                                        <SelectValue placeholder="Sélectionner…" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="toiture">Isolation toiture</SelectItem>
                                        <SelectItem value="murs_exterieurs">Isolation murs extérieurs</SelectItem>
                                        <SelectItem value="parois_vitrees">Parois vitrées / portes</SelectItem>
                                        <SelectItem value="planchers_bas">Isolation planchers bas</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="grid grid-cols-2 gap-2">
                                    <div className="space-y-1">
                                      <Label className="text-xs">Nature du matériau</Label>
                                      <Input value={matNature} onChange={e => setMatNature(e.target.value)} className="h-8 text-xs" placeholder="Ex : laine de verre" />
                                    </div>
                                    <div className="space-y-1">
                                      <Label className="text-xs">Marque</Label>
                                      <Input value={matBrand} onChange={e => setMatBrand(e.target.value)} className="h-8 text-xs" placeholder="Ex : Isover" />
                                    </div>
                                    <div className="space-y-1">
                                      <Label className="text-xs">R (m²K/W)</Label>
                                      <Input type="number" value={matR} onChange={e => setMatR(e.target.value)} className="h-8 text-xs" placeholder="Ex : 6.0" />
                                    </div>
                                  </div>
                                  <div className="flex gap-2 justify-end">
                                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowMaterialForm(false)}>Annuler</Button>
                                    <Button size="sm" className="h-7 text-xs" onClick={handleSaveMaterial} disabled={savingMaterial}>
                                      {savingMaterial ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Enregistrer'}
                                    </Button>
                                  </div>
                                </div>
                              )}

                              {/* N/A toggle */}
                              {block.status !== 'complete' && block.status !== 'not_applicable' && (
                                <button
                                  type="button"
                                  className="text-[10px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                                  onClick={() => handleSetResolution(block.id, 'not_applicable')}
                                >
                                  Marquer comme non applicable pour ce logement
                                </button>
                              )}
                              {block.status === 'not_applicable' && (
                                <button
                                  type="button"
                                  className="text-[10px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                                  onClick={() => handleClearResolution(block.id)}
                                >
                                  Annuler — recalculer ce bloc
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                </div>
              );
            })()}

            {/* ── Récap visuel autres exports ──────────────────────────────── */}

            {/* ── Transmission ─────────────────────────────────────────────── */}
            {usage === 'TRANSMISSION' && !isLocked && (
              <div className="space-y-5">

                {/* Explainer */}
                <div className="rounded-lg bg-muted/50 border px-4 py-3 space-y-2 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">Comment fonctionne la transmission ?</p>
                  <ul className="space-y-1.5 list-none">
                    <li className="flex items-start gap-2">
                      <span className="mt-0.5 shrink-0 text-primary">①</span>
                      <span>Un email est envoyé au destinataire avec un lien sécurisé pour accepter ou refuser.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="mt-0.5 shrink-0 text-primary">②</span>
                      <span>S'il accepte, une copie complète du bien (données + documents sélectionnés) est créée dans son espace.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="mt-0.5 shrink-0 text-primary">③</span>
                      <span>Vous suivez le statut de l'invitation depuis cet onglet.</span>
                    </li>
                  </ul>
                </div>

                {/* Recipient email */}
                <div className="space-y-1.5">
                  <Label htmlFor="recipient" className="text-sm font-medium">Email du destinataire *</Label>
                  <Input
                    id="recipient"
                    type="email"
                    placeholder="nom@exemple.fr"
                    value={recipientEmail}
                    onChange={(e) => setRecipientEmail(e.target.value)}
                  />
                </div>

                {/* Post-transmission status choice */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Statut du bien après transmission</Label>
                  <p className="text-xs text-muted-foreground">
                    Souhaitez-vous conserver ce bien actif dans votre portefeuille une fois l'invitation envoyée ?
                  </p>
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setKeepActiveAfterTransmission(false)}
                      className={[
                        'flex flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors',
                        !keepActiveAfterTransmission
                          ? 'border-primary bg-primary/5 text-foreground'
                          : 'border-border bg-background text-muted-foreground hover:bg-muted/40',
                      ].join(' ')}
                    >
                      <span className="text-xs font-semibold">Passer en Transmis</span>
                      <span className="text-[11px] leading-snug">Le bien est marqué transmis et n'apparaît plus dans votre portefeuille actif.</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setKeepActiveAfterTransmission(true)}
                      className={[
                        'flex flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors',
                        keepActiveAfterTransmission
                          ? 'border-primary bg-primary/5 text-foreground'
                          : 'border-border bg-background text-muted-foreground hover:bg-muted/40',
                      ].join(' ')}
                    >
                      <span className="text-xs font-semibold">Conserver actif</span>
                      <span className="text-[11px] leading-snug">Le bien reste visible et actif dans votre portefeuille après envoi.</span>
                    </button>
                  </div>
                </div>

              </div>
            )}

            {/* ── Format ZIP ───────────────────────────────────────────────── */}
            {/* CIL+DCB premium: ZIP always included automatically */}
            {planType !== 'STANDARD' && !isLocked && (usage === 'CIL_REGLEMENTAIRE' || usage === 'DOSSIER_COMPLET') && (
              <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
                <Package className="w-3.5 h-3.5 shrink-0" />
                PDF + ZIP inclus automatiquement (dossier complet + documents joints)
              </div>
            )}
            {/* Other premium types: optional ZIP checkbox */}
            {usage !== 'EXPORT_BRUT' && usage !== 'TRANSMISSION' && usage !== 'CIL_REGLEMENTAIRE' && usage !== 'DOSSIER_COMPLET' && planType !== 'STANDARD' && !isLocked && (
              <div className="flex items-center gap-2.5 rounded-lg border px-3 py-2.5">
                <Checkbox id="zip" checked={requestZip} onCheckedChange={(v) => setRequestZip(!!v)} />
                <Label htmlFor="zip" className="text-sm font-normal cursor-pointer flex-1">
                  Inclure aussi le ZIP (PDF + documents joints)
                </Label>
              </div>
            )}

            {/* ── EXPORT_BRUT info ──────────────────────────────────────────── */}
            {usage === 'EXPORT_BRUT' && !isLocked && (
              <div className="rounded-lg bg-muted/50 px-4 py-3 text-xs text-muted-foreground">
                {planType !== 'STANDARD'
                  ? '📦 ZIP structuré par catégorie documentaire, avec récapitulatif des données du bien.'
                  : '📦 ZIP brut à plat — tous vos fichiers en un seul téléchargement.'}
              </div>
            )}

            {/* ── Locked CTA ──────────────────────────────────────────────── */}
            {isLocked && (() => {
              const premiumTheme = getPlanTheme('PREMIUM');
              return (
                <div className={`rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50 ${premiumTheme.colors.bgDark} px-4 py-4 space-y-3`}>
                  <div className="flex items-center gap-2">
                    <Crown className={`w-4 h-4 ${premiumTheme.colors.text} shrink-0`} />
                    <span className={`text-sm font-semibold text-blue-800 ${premiumTheme.colors.textDark}`}>Fonctionnalité Premium</span>
                  </div>
                  <p className={`text-xs text-blue-700 ${premiumTheme.colors.textDark}`}>
                    {usage === 'TRANSMISSION'
                      ? 'La transmission de biens est réservée aux abonnés Premium.'
                      : 'La génération de dossiers documentaires est réservée aux abonnés Premium.'}
                  </p>
                  <Button size="sm" className="w-full bg-blue-600 hover:bg-blue-700 text-white">
                    Passer à Premium
                  </Button>
                </div>
              );
            })()}
          </div>
        </ScrollArea>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <div className="px-5 py-4 border-t shrink-0">
          <div className="flex items-stretch rounded-xl border border-border bg-muted/30 overflow-hidden">
            <button
              type="button"
              className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-muted/60 transition-colors text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={onClose}
              disabled={generating}
            >
              <X className="w-4 h-4" />
              <span className="text-[10px] font-semibold uppercase tracking-wider">Annuler</span>
            </button>
            {!isLocked && (
              <>
                <div className="w-px bg-border" />
                {(usage === 'CIL_REGLEMENTAIRE' || usage === 'DOSSIER_COMPLET') ? (() => {
                  const isDisabled = generating || loadingData || cilLoading;
                  return (
                    <>
                      <button
                        type="button"
                        className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-primary/10 transition-colors text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                        onClick={() => handleGenerate(['PDF'])}
                        disabled={isDisabled}
                      >
                        {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
                        <span className="text-[10px] font-semibold uppercase tracking-wider">PDF</span>
                      </button>
                      <div className="w-px bg-border" />
                      <button
                        type="button"
                        className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-primary/10 transition-colors text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                        onClick={() => handleGenerate(['PDF', 'ZIP'])}
                        disabled={isDisabled}
                      >
                        {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Package className="w-4 h-4" />}
                        <span className="text-[10px] font-semibold uppercase tracking-wider">ZIP (PDF + Docs)</span>
                      </button>
                    </>
                  );
                })() : (() => {
                  const isDisabled = generating || loadingData;
                  return (
                    <button
                      type="button"
                      className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-primary/10 transition-colors text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                      onClick={() => handleGenerate()}
                      disabled={isDisabled}
                    >
                      {generating
                        ? <Loader2 className="w-4 h-4 animate-spin" />
                        : usage === 'TRANSMISSION'
                        ? <Send className="w-4 h-4" />
                        : usage === 'EXPORT_BRUT'
                        ? <Download className="w-4 h-4" />
                        : <FileDown className="w-4 h-4" />}
                      <span className="text-[10px] font-semibold uppercase tracking-wider">
                        {generating
                          ? 'Génération…'
                          : usage === 'TRANSMISSION'
                          ? 'Transmettre'
                          : usage === 'EXPORT_BRUT'
                          ? 'Télécharger'
                          : 'Générer'}
                      </span>
                    </button>
                  );
                })()}
              </>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
