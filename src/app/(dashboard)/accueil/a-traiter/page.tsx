"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  FileText,
  Calendar,
  Wrench,
  CheckCircle2,
  Loader2,
  Clock,
  Home,
  Link2Off,
  CalendarX,
  AlertTriangle,
  HelpCircle,
  Wand2,
  File,
  Image as ImageIcon,
  ArrowRight,
  BellOff,
  Link2,
  CheckSquare,
  Square,
  Building2,
  GitMerge,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { DocumentDrawerItem } from '@/components/assets/DocumentDrawer';
import { EquipmentDrawer } from '@/components/assets/EquipmentDrawer';
import { PdfThumbnail } from '@/components/ui/pdf-thumbnail';
import type { EquipmentDrawerItem, EquipmentDrawerAsset } from '@/components/assets/EquipmentDrawer';
import type { AgendaItemFull } from '@/services/agenda/AgendaQueryService';
import { SupplierDrawer } from '@/components/suppliers/SupplierDrawer';

const DocumentDrawer = dynamic(
  () => import('@/components/assets/DocumentDrawer').then(m => ({ default: m.DocumentDrawer })),
  { ssr: false }
);

const UnifiedDocumentDialog = dynamic(
  () => import('@/components/documents/unified-document-dialog').then(m => ({ default: m.UnifiedDocumentDialog })),
  { ssr: false }
);

const AgendaItemDrawer = dynamic(
  () => import('@/components/agenda/AgendaItemDrawer').then(m => ({ default: m.AgendaItemDrawer })),
  { ssr: false }
);

// ─── Types ────────────────────────────────────────────────────────────────────

interface DocumentItem {
  id: number;
  publicId: string;
  filename: string;
  originalFilename: string | null;
  mimeType: string | null;
  retainedTitle: string | null;
  retainedFunctionCode: string | null;
  assetId: number | null;
  linkedAssetId: number | null;
  linkedRoomId: number | null;
  equipmentId: number | null;
  documentType: string | null;
  documentDate: string | null;
  supplier: string | null;
  description: string | null;
  uploadedAt: string;
  lastAnalysisAt: string | null;
  analysisState: string | null;
  motifs: string[];
  fusionRunId: number | null;
}

interface AgendaItem {
  id: number;
  publicId: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
  effectiveStatus: string;
  attentionFlags: string[];
  assetLinks: { id: number; assetId: number; assetName: string }[];
}

interface EquipementItem {
  id: number;
  name: string;
  type: string | null;
  category: string | null;
  assetId: number | null;
  status: string | null;
}

interface SupplierReviewItem {
  id: number;
  publicId: string;
  itemType: string; // 'deduplication' | 'contact_conflict'
  status: string;
  detectedName: string | null;
  conflictingField: string | null;
  currentValue: string | null;
  detectedValue: string | null;
  supplierId: number | null;
  supplierName: string | null;
  documentId: number | null;
  documentFilename: string | null;
  candidateSupplierIds: number[] | null;
}

interface ATraiterData {
  documents: DocumentItem[];
  agendaItems: AgendaItem[];
  equipements: EquipementItem[];
}

// ─── Motif badge config ───────────────────────────────────────────────────────

const CONFLICT_FIELD_LABELS: Record<string, string> = {
  email:          'Email',
  phone:          'Téléphone',
  website:        'Site web',
  addressLine1:   'Adresse',
  addressLine2:   'Adresse (ligne 2)',
  postalCode:     'Code postal',
  city:           'Ville',
  country:        'Pays',
  siret:          'SIRET',
  vatNumber:      'N° TVA',
  iban:           'IBAN',
  ibanHolderName: 'Titulaire IBAN',
};

const MOTIF_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  missing_function: {
    label: 'Fonction manquante',
    color: 'text-[#a78bfa] bg-[#a78bfa]/10 border-[#a78bfa]/30',
    icon: <HelpCircle className="w-3 h-3" />,
  },
  missing_useful_link: {
    label: 'Aucun bien associé',
    color: 'text-[#ef4444] bg-[#ef4444]/10 border-[#ef4444]/30',
    icon: <Link2Off className="w-3 h-3" />,
  },
  missing_analysis: {
    label: 'Non analysé',
    color: 'text-[#8b5cf6] bg-[#8b5cf6]/10 border-[#8b5cf6]/30',
    icon: <Wand2 className="w-3 h-3" />,
  },
  fusion_suggested: {
    label: 'Fusion suggérée',
    color: 'text-[#f97316] bg-[#f97316]/10 border-[#f97316]/30',
    icon: <GitMerge className="w-3 h-3" />,
  },
};

// ─── Attention flag badge config ──────────────────────────────────────────────

const FLAG_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  sans_bien: {
    label: 'Sans bien',
    color: 'text-[#ef4444] bg-[#ef4444]/10 border-[#ef4444]/30',
    icon: <Home className="w-3 h-3" />,
  },
  en_retard: {
    label: 'En retard',
    color: 'text-[#f59e0b] bg-[#f59e0b]/10 border-[#f59e0b]/30',
    icon: <Clock className="w-3 h-3" />,
  },
  date_incoherente: {
    label: 'Date incohérente',
    color: 'text-[#f97316] bg-[#f97316]/10 border-[#f97316]/30',
    icon: <CalendarX className="w-3 h-3" />,
  },
  donnee_distincte_a_qualifier: {
    label: 'Donnée à qualifier',
    color: 'text-[#a78bfa] bg-[#a78bfa]/10 border-[#a78bfa]/30',
    icon: <AlertTriangle className="w-3 h-3" />,
  },
};

// ─── Document preview thumbnail ───────────────────────────────────────────────

const previewUrlCache = new Map<number, string>();

function DocPreview({ docId, mimeType }: { docId: number; mimeType: string | null }) {
  const isPdf = mimeType === 'application/pdf';
  const isImage = mimeType?.startsWith('image/');

  // For PDFs, delegate to PdfThumbnail (handles its own fetching via pdfjs)
  if (isPdf) {
    return (
      <div className="relative w-full h-32 rounded-t-lg overflow-hidden border-b border-[color:var(--border-subtle)]">
        <PdfThumbnail fileId={docId.toString()} className="absolute inset-0 w-full h-full" />
      </div>
    );
  }

  return <DocImagePreview docId={docId} isImage={!!isImage} />;
}

function DocImagePreview({ docId, isImage }: { docId: number; isImage: boolean }) {
  const [viewUrl, setViewUrl] = useState<string | null>(previewUrlCache.get(docId) ?? null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    previewUrlCache.has(docId) ? 'ready' : 'idle'
  );
  const observerRef = useRef<IntersectionObserver | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status !== 'idle' || !isImage) return;

    const load = async () => {
      setStatus('loading');
      try {
        const token = typeof window !== 'undefined' ? localStorage.getItem('bearer_token') : null;
        const res = await fetch(`/api/files/${docId}/view`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error('fetch failed');
        const data = await res.json();
        previewUrlCache.set(docId, data.viewUrl);
        setViewUrl(data.viewUrl);
        setStatus('ready');
      } catch {
        setStatus('error');
      }
    };

    if (!containerRef.current) return;
    observerRef.current = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          observerRef.current?.disconnect();
          load();
        }
      },
      { rootMargin: '100px' }
    );
    observerRef.current.observe(containerRef.current);

    return () => observerRef.current?.disconnect();
  }, [docId, status, isImage]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-32 rounded-t-lg overflow-hidden bg-[rgba(255,255,255,0.04)] border-b border-[color:var(--border-subtle)]"
    >
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-[color:var(--text-muted)] opacity-40" />
        </div>
      )}

      {status === 'ready' && viewUrl && (
        <img
          src={viewUrl}
          alt=""
          className="w-full h-full object-cover"
          onError={() => setStatus('error')}
        />
      )}

      {(status === 'idle' || status === 'error' || !isImage) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 opacity-25">
          {isImage
            ? <ImageIcon className="w-8 h-8 text-[color:var(--text-muted)]" />
            : <File className="w-8 h-8 text-[color:var(--text-muted)]" />}
        </div>
      )}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4">
        <CheckCircle2 className="w-8 h-8 text-green-500" />
      </div>
      <h3 className="text-lg font-medium text-[color:var(--text-primary)]">Tout est à jour !</h3>
      <p className="text-sm text-[color:var(--text-muted)] max-w-xs mx-auto mt-1">
        Aucun {label} à traiter pour le moment.
      </p>
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="flex justify-center py-16">
      <Loader2 className="w-8 h-8 animate-spin text-[color:var(--text-muted)]" />
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ATraiterPage() {
  const { setBreadcrumbs } = useBreadcrumb();

  useEffect(() => {
    setBreadcrumbs([{ label: 'À traiter' }]);
  }, [setBreadcrumbs]);

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ATraiterData>({
    documents: [],
    agendaItems: [],
    equipements: [],
  });
  const [activeTab, setActiveTab] = useState('documents');
  const [drawerDoc, setDrawerDoc] = useState<DocumentDrawerItem | null>(null);
  const [drawerDocIndex, setDrawerDocIndex] = useState<number>(-1);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [ignoringId, setIgnoringId] = useState<number | null>(null);
  const [editingEquipment, setEditingEquipment] = useState<EquipmentDrawerItem | null>(null);
  const [availableAssets, setAvailableAssets] = useState<EquipmentDrawerAsset[]>([]);
  const [agendaDrawerItem, setAgendaDrawerItem] = useState<AgendaItemFull | null>(null);
  const [agendaDrawerOpen, setAgendaDrawerOpen] = useState(false);
  const [loadingAgendaId, setLoadingAgendaId] = useState<number | null>(null);
  const [supplierReviewItems, setSupplierReviewItems] = useState<SupplierReviewItem[]>([]);
  const [supplierDrawerOpen, setSupplierDrawerOpen] = useState(false);
  const [supplierDrawerId, setSupplierDrawerId] = useState<number | null>(null);

  // Bulk selection for documents tab
  const [selectedDocIds, setSelectedDocIds] = useState<number[]>([]);


  const [showLinkAssetDialog, setShowLinkAssetDialog] = useState(false);
  const [targetLinkAssetId, setTargetLinkAssetId] = useState('');
  const [isLinking, setIsLinking] = useState(false);
  const [isIgnoringBulk, setIsIgnoringBulk] = useState(false);
  const [fusionLoadingRunId, setFusionLoadingRunId] = useState<number | null>(null);
  const [fusionIgnoringRunId, setFusionIgnoringRunId] = useState<number | null>(null);


  const visibleDocuments = useMemo(() =>
    data.documents.filter(doc => !doc.fusionRunId || data.documents.filter(d => d.fusionRunId === doc.fusionRunId).length < 2),
    [data.documents]
  );

  const toggleSelectDoc = useCallback((id: number) => {
    setSelectedDocIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  }, []);
  const deselectAllDocs = useCallback(() => setSelectedDocIds([]), []);

  const handleOpenAgendaDrawer = useCallback(async (id: number) => {
    setLoadingAgendaId(id);
    try {
      const data = await apiClient.get<{ item: AgendaItemFull }>(`/api/agenda/${id}`);
      setAgendaDrawerItem(data.item);
      setAgendaDrawerOpen(true);
    } catch {
      toast.error('Impossible de charger cet élément d\'agenda');
    } finally {
      setLoadingAgendaId(null);
    }
  }, []);

  const handleIgnore = useCallback(async (id: number) => {
    setIgnoringId(id);
    try {
      await apiClient.post(`/api/dashboard/a-traiter/documents/${id}/ignore`, {});
      setData(prev => {
        const next = { ...prev, documents: prev.documents.filter(d => d.id !== id) };
        const count = next.documents.length + next.agendaItems.length + next.equipements.length;
        window.dispatchEvent(new CustomEvent('update-a-traiter-count', { detail: count }));
        return next;
      });
      toast.success('Document ignoré');
    } catch {
      toast.error('Impossible d\'ignorer ce document');
    } finally {
      setIgnoringId(null);
    }
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // Auto-resolve false-positive conflicts first, then fetch the cleaned list
      await apiClient.post('/api/to-process/suppliers/bulk-resolve', {}).catch(() => {});
      // Invalidate supplier cache after resolve so we don't get stale data
      apiClient.invalidateCache('/api/to-process/suppliers');

      const [mainResult, assetsResult, suppliersResult] = await Promise.allSettled([
        apiClient.get<ATraiterData>('/api/dashboard/a-traiter', { useCache: true }),
        apiClient.get<any>('/api/assets?limit=100', { useCache: true }).catch(() => ({})),
        apiClient.get<{ reviewItems: SupplierReviewItem[] }>('/api/to-process/suppliers', { useCache: true }).catch(() => ({ reviewItems: [] })),
      ]);

      if (mainResult.status === 'fulfilled') {
        setData(mainResult.value);
        const d = mainResult.value;
        const suppCount = suppliersResult.status === 'fulfilled' ? (suppliersResult.value?.reviewItems?.length ?? 0) : 0;
        const count = (d.documents?.length ?? 0) + (d.agendaItems?.length ?? 0) + (d.equipements?.length ?? 0) + suppCount;
        window.dispatchEvent(new CustomEvent('update-a-traiter-count', { detail: count }));
      } else {
        console.error('Error fetching à traiter data:', mainResult.reason);
        toast.error('Erreur lors du chargement des objets à traiter');
      }

      if (suppliersResult.status === 'fulfilled') {
        setSupplierReviewItems(suppliersResult.value?.reviewItems ?? []);
      }

      const raw = assetsResult.status === 'fulfilled' ? assetsResult.value : {};
      const assetList = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
      setAvailableAssets(assetList.map((a: any) => ({ id: a.id, name: a.name })));
    } catch (error) {
      console.error('Error fetching à traiter data:', error);
      toast.error('Erreur lors du chargement des objets à traiter');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const handleRefresh = () => fetchData();
    const handleDocumentDeleted = () => {
      apiClient.invalidateCache('/api/dashboard/a-traiter');
      fetchData();
    };
    window.addEventListener('refresh-a-traiter', handleRefresh);
    window.addEventListener('document-added', handleRefresh);
    window.addEventListener('document-deleted', handleDocumentDeleted);
    return () => {
      window.removeEventListener('refresh-a-traiter', handleRefresh);
      window.removeEventListener('document-added', handleRefresh);
      window.removeEventListener('document-deleted', handleDocumentDeleted);
    };
  }, [fetchData]);

  const handleBulkAnalyzeDocs = useCallback(async () => {
    if (selectedDocIds.length === 0) return;
    const fileIds = [...selectedDocIds];
    deselectAllDocs();
    try {
      await apiClient.post('/api/documents/analyze-batch', { fileIds });
      toast.success(`Analyse lancée pour ${fileIds.length} document${fileIds.length > 1 ? 's' : ''}`);
      window.dispatchEvent(new CustomEvent('document-analysis-start', { detail: { fileId: fileIds[0] ?? null } }));
    } catch (err: any) {
      toast.error(err?.status === 403 ? 'Analyse automatique disponible avec un abonnement Premium.' : 'Erreur lors du lancement de l\'analyse');
    }
  }, [selectedDocIds, deselectAllDocs]);

  const handleBulkLink = useCallback(async () => {
    if (!targetLinkAssetId || selectedDocIds.length === 0) return;
    try {
      setIsLinking(true);
      const result = await apiClient.post<{ moved: number }>('/api/documents/bulk-move', {
        documentIds: selectedDocIds,
        targetAssetId: parseInt(targetLinkAssetId),
      });
      toast.success(`${result.moved} document${result.moved > 1 ? 's rattachés' : ' rattaché'}`);
      deselectAllDocs();
      setShowLinkAssetDialog(false);
      setTargetLinkAssetId('');
      fetchData();
    } catch { toast.error('Erreur lors du rattachement'); }
    finally { setIsLinking(false); }
  }, [targetLinkAssetId, selectedDocIds, deselectAllDocs, fetchData]);

  const handleBulkIgnore = useCallback(async () => {
    if (selectedDocIds.length === 0) return;
    try {
      setIsIgnoringBulk(true);
      await Promise.allSettled(
        selectedDocIds.map(id => apiClient.post(`/api/dashboard/a-traiter/documents/${id}/ignore`, {}))
      );
      const count = selectedDocIds.length;
      setData(prev => {
        const next = { ...prev, documents: prev.documents.filter(d => !selectedDocIds.includes(d.id)) };
        const total = next.documents.length + next.agendaItems.length + next.equipements.length;
        window.dispatchEvent(new CustomEvent('update-a-traiter-count', { detail: total }));
        return next;
      });
      toast.success(`${count} document${count > 1 ? 's sortis' : ' sorti'} de à traiter`);
      deselectAllDocs();
    } catch { toast.error('Erreur lors de l\'opération'); }
    finally { setIsIgnoringBulk(false); }
  }, [selectedDocIds, deselectAllDocs]);

  const handleFusionMerge = useCallback(async (groupDocs: DocumentItem[]) => {
    if (groupDocs.length < 2) return;
    const runId = groupDocs[0].fusionRunId;
    if (!runId) return;
    setFusionLoadingRunId(runId);
    try {
      // Lead = first doc, secondary = the rest. Call merge on each secondary → lead.
      const leadId = groupDocs[0].id;
      const secondaryIds = groupDocs.slice(1).map(d => d.id);
      await Promise.all(
        secondaryIds.map(secId =>
          apiClient.post(`/api/documents/${leadId}/fusion`, { action: 'merge', candidateId: secId })
        )
      );
      toast.success('Documents fusionnés');
      fetchData();
    } catch {
      toast.error('Erreur lors de la fusion');
    } finally {
      setFusionLoadingRunId(null);
    }
  }, [fetchData]);

  const handleFusionIgnore = useCallback(async (groupDocs: DocumentItem[]) => {
    const runId = groupDocs[0].fusionRunId;
    if (!runId) return;
    setFusionIgnoringRunId(runId);
    try {
      await Promise.all(
        groupDocs.map(d =>
          apiClient.post(`/api/dashboard/a-traiter/documents/${d.id}/ignore`, {})
        )
      );
      const ids = groupDocs.map(d => d.id);
      setData(prev => {
        const next = { ...prev, documents: prev.documents.filter(d => !ids.includes(d.id)) };
        const total = next.documents.length + next.agendaItems.length + next.equipements.length;
        window.dispatchEvent(new CustomEvent('update-a-traiter-count', { detail: total }));
        return next;
      });
      toast.success('Fusion ignorée');
    } catch {
      toast.error('Erreur lors de l\'opération');
    } finally {
      setFusionIgnoringRunId(null);
    }
  }, []);

  const totalCount = data.documents.length + data.agendaItems.length + data.equipements.length + supplierReviewItems.length;

  return (
    <>
      <div data-guide="treat-incomplete" className="space-y-6 w-full max-w-full overflow-x-hidden pb-12">
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">À traiter</h1>
            <p className="text-muted-foreground mt-1">
              {totalCount > 0
                ? `${totalCount} objet${totalCount > 1 ? 's' : ''} à traiter`
                : 'Aucun élément en attente'}
            </p>
          </div>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="bg-[rgba(15,23,42,0.5)] border border-[color:var(--border-subtle)] p-1 rounded-xl w-full md:w-fit overflow-x-auto flex-nowrap [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <TabsTrigger
              value="documents"
              className="rounded-lg data-[state=active]:bg-[#3b82f6] data-[state=active]:text-white"
            >
              <FileText className="w-3.5 h-3.5 mr-1.5" />
              Documents
              {data.documents.length > 0 && (
                <span className="ml-1.5 text-xs opacity-75">({data.documents.length})</span>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="agenda"
              className="rounded-lg data-[state=active]:bg-[#f59e0b] data-[state=active]:text-white"
            >
              <Calendar className="w-3.5 h-3.5 mr-1.5" />
              Agenda
              {data.agendaItems.length > 0 && (
                <span className="ml-1.5 text-xs opacity-75">({data.agendaItems.length})</span>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="equipements"
              className="rounded-lg data-[state=active]:bg-[#8b5cf6] data-[state=active]:text-white"
            >
              <Wrench className="w-3.5 h-3.5 mr-1.5" />
              Équipements
              {data.equipements.length > 0 && (
                <span className="ml-1.5 text-xs opacity-75">({data.equipements.length})</span>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="fournisseurs"
              className="rounded-lg data-[state=active]:bg-[#10b981] data-[state=active]:text-white"
            >
              <Building2 className="w-3.5 h-3.5 mr-1.5" />
              Fournisseurs
              {supplierReviewItems.length > 0 && (
                <span className="ml-1.5 text-xs opacity-75">({supplierReviewItems.length})</span>
              )}
            </TabsTrigger>
          </TabsList>

          {/* ── Documents tab ──────────────────────────────────────────────── */}
          <TabsContent value="documents" className="mt-6">
            {loading ? (
              <LoadingSkeleton />
            ) : data.documents.length === 0 ? (
              <EmptyState label="document" />
            ) : (
              <>
                {/* Bulk action bar */}
                {selectedDocIds.length > 0 && (
                  <div className="flex items-center gap-2 p-3 mb-4 rounded-xl bg-[#3b82f6]/10 border border-[#3b82f6]/30">
                    <button
                      onClick={() => {
                        if (selectedDocIds.length === data.documents.length) deselectAllDocs();
                        else setSelectedDocIds(data.documents.map(d => d.id));
                      }}
                      className="flex items-center gap-2 text-sm font-medium text-[#3b82f6] hover:text-[#2563eb] shrink-0"
                    >
                      {selectedDocIds.length === data.documents.length ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                      <span>{selectedDocIds.length} sélectionné{selectedDocIds.length > 1 ? 's' : ''}</span>
                    </button>
                    <div className="flex-1" />
                    <button
                      onClick={handleBulkAnalyzeDocs}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-[#8b5cf6]/40 text-[#8b5cf6] hover:bg-[#8b5cf6]/10"
                    >
                      <Wand2 className="w-3.5 h-3.5" />
                      Analyse IA
                    </button>
                    <button
                      onClick={() => setShowLinkAssetDialog(true)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-[#3b82f6]/40 text-[#3b82f6] hover:bg-[#3b82f6]/10"
                    >
                      <Link2 className="w-3.5 h-3.5" />
                      Rattacher à un bien
                    </button>
                    <button
                      onClick={handleBulkIgnore}
                      disabled={isIgnoringBulk}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-[color:var(--border-subtle)] text-[color:var(--text-muted)] hover:bg-[rgba(255,255,255,0.05)] disabled:opacity-50"
                    >
                      {isIgnoringBulk ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BellOff className="w-3.5 h-3.5" />}
                      Sortir de à traiter
                    </button>
                    <button onClick={deselectAllDocs} className="px-2 py-1.5 text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] text-sm">✕</button>
                  </div>
                )}

              {/* ── Fusion groups ─────────────────────────────────────────── */}
              {(() => {
                const fusionGroupsMap = new Map<number, DocumentItem[]>();
                for (const doc of data.documents) {
                  if (doc.fusionRunId) {
                    const group = fusionGroupsMap.get(doc.fusionRunId) ?? [];
                    group.push(doc);
                    fusionGroupsMap.set(doc.fusionRunId, group);
                  }
                }
                const fusionGroups = [...fusionGroupsMap.values()].filter(g => g.length > 1);
                if (fusionGroups.length === 0) return null;
                return (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
                    {fusionGroups.map(group => {
                      const runId = group[0].fusionRunId!;
                      const isLoading = fusionLoadingRunId === runId;
                      const isIgnoring = fusionIgnoringRunId === runId;
                      return (
                        <Card
                          key={`fusion-${runId}`}
                          className="border-[#f97316]/40 bg-[color:var(--bg-card)] overflow-hidden p-0"
                        >
                          {/* Thumbnails row */}
                          <div className="flex h-24 overflow-hidden border-b border-[color:var(--border-subtle)]">
                            {group.map((doc, i) => (
                              <div key={doc.id} className={`flex-1 relative ${i > 0 ? 'border-l border-[color:var(--border-subtle)]' : ''}`}>
                                <DocPreview docId={doc.id} mimeType={doc.mimeType} />
                              </div>
                            ))}
                          </div>

                          <CardContent className="p-4">
                            <div className="flex items-start gap-3 mb-3">
                              <div className="w-8 h-8 rounded-lg bg-[#f97316]/10 flex items-center justify-center shrink-0">
                                <GitMerge className="w-4 h-4 text-[#f97316]" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <h4 className="font-medium text-sm text-[color:var(--text-primary)]">
                                  Fusion suggérée — {group.length} fichiers
                                </h4>
                                <p className="text-[11px] text-[color:var(--text-muted)] mt-0.5">
                                  Ces fichiers semblent former un seul document
                                </p>
                              </div>
                            </div>

                            <div className="space-y-1 mb-3">
                              {group.map(doc => (
                                <p key={doc.id} className="text-[11px] text-[color:var(--text-secondary)] truncate">
                                  • {doc.retainedTitle?.trim() || doc.originalFilename || doc.filename}
                                </p>
                              ))}
                            </div>

                            <div className="flex items-center justify-end gap-2 pt-3 border-t border-[color:var(--border-subtle)]">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-auto py-1.5 px-2 text-[color:var(--text-muted)] hover:text-[#ef4444] hover:bg-[#ef4444]/10 text-xs"
                                disabled={isIgnoring || isLoading}
                                onClick={() => handleFusionIgnore(group)}
                              >
                                {isIgnoring ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <BellOff className="w-3 h-3 mr-1" />}
                                Ignorer
                              </Button>
                              <Button
                                size="sm"
                                className="h-auto py-1.5 px-3 bg-[#f97316] hover:bg-[#ea6c10] text-white text-xs"
                                disabled={isLoading || isIgnoring}
                                onClick={() => handleFusionMerge(group)}
                              >
                                {isLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <GitMerge className="w-3 h-3 mr-1" />}
                                Fusionner
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                );
              })()}

              {/* ── Regular documents ─────────────────────────────────────── */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {visibleDocuments.map((doc, idx) => {
                  const displayName = doc.retainedTitle?.trim() || doc.originalFilename || doc.filename;
                  return (
                    <Card
                      key={doc.id}
                      className={`border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] hover:border-[#3b82f6]/50 transition-all group overflow-hidden p-0 cursor-pointer ${selectedDocIds.includes(doc.id) ? 'ring-1 ring-[#3b82f6] border-[#3b82f6]/50' : ''}`}
                      onClick={() => {
                        setDrawerDocIndex(idx);
                        setDrawerDoc({
                          id: doc.id,
                          originalFilename: doc.originalFilename || doc.filename,
                          mimeType: doc.mimeType || '',
                          documentType: doc.documentType || 'AUTRE',
                          documentDate: doc.documentDate,
                          uploadedAt: doc.uploadedAt,
                          assetId: doc.assetId ?? doc.linkedAssetId ?? 0,
                        });
                        setDrawerOpen(true);
                      }}
                    >
                      {/* Preview + select overlay */}
                      <div className="relative">
                        <DocPreview docId={doc.id} mimeType={doc.mimeType} />
                        <div
                          className={`absolute top-2 right-2 w-5 h-5 rounded flex items-center justify-center border transition-colors z-10 ${selectedDocIds.includes(doc.id) ? 'bg-[#3b82f6] border-[#3b82f6]' : 'bg-black/40 border-white/30 opacity-0 group-hover:opacity-100'}`}
                          onClick={(e) => { e.stopPropagation(); toggleSelectDoc(doc.id); }}
                        >
                          {selectedDocIds.includes(doc.id) && (
                            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                      </div>

                      <CardContent className="p-4">
                        <div className="flex items-start gap-3">
                          <div className="w-8 h-8 rounded-lg bg-[#3b82f6]/10 flex items-center justify-center shrink-0">
                            <FileText className="w-4 h-4 text-[#3b82f6]" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <h4
                              className="font-medium text-sm truncate text-[color:var(--text-primary)]"
                              title={displayName ?? undefined}
                            >
                              {displayName}
                            </h4>
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {doc.motifs.map((motif) => {
                                const cfg = MOTIF_CONFIG[motif];
                                if (!cfg) return null;
                                return (
                                  <span
                                    key={motif}
                                    className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border ${cfg.color}`}
                                  >
                                    {cfg.icon}
                                    {cfg.label}
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 pt-3 border-t border-[color:var(--border-subtle)] flex items-center justify-between gap-2">
                          <span className="text-[10px] text-[color:var(--text-muted)] shrink-0">
                            {doc.documentDate
                              ? new Date(doc.documentDate).toLocaleDateString('fr-FR')
                              : doc.uploadedAt
                              ? `Ajouté ${new Date(doc.uploadedAt).toLocaleDateString('fr-FR')}`
                              : '—'}
                          </span>
                          <div className="flex items-center gap-1">
                            <TooltipProvider delayDuration={300}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-auto p-1 text-[color:var(--text-muted)] hover:text-[#ef4444] hover:bg-[#ef4444]/10"
                                    disabled={ignoringId === doc.id}
                                    onClick={(e) => { e.stopPropagation(); handleIgnore(doc.id); }}
                                  >
                                    {ignoringId === doc.id
                                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      : <BellOff className="w-3.5 h-3.5" />}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-[200px] text-center">
                                  <p className="font-medium">Ignorer ce document</p>
                                  <p className="text-xs text-muted-foreground mt-0.5">Ce document n'apparaîtra plus dans les documents à traiter</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              {/* Link to asset dialog */}
              <Dialog open={showLinkAssetDialog} onOpenChange={setShowLinkAssetDialog}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Rattacher à un bien</DialogTitle>
                  </DialogHeader>
                  <div className="py-4">
                    <Select value={targetLinkAssetId} onValueChange={setTargetLinkAssetId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Sélectionner un bien" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableAssets.map(a => (
                          <SelectItem key={a.id} value={a.id.toString()}>{a.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => { setShowLinkAssetDialog(false); setTargetLinkAssetId(''); }} disabled={isLinking}>
                      Annuler
                    </Button>
                    <Button onClick={handleBulkLink} disabled={isLinking || !targetLinkAssetId}>
                      {isLinking ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                      Rattacher
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              </>
            )}
          </TabsContent>

          {/* ── Agenda tab ─────────────────────────────────────────────────── */}
          <TabsContent value="agenda" className="mt-6">
            {loading ? (
              <LoadingSkeleton />
            ) : data.agendaItems.length === 0 ? (
              <EmptyState label="élément d'agenda" />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {data.agendaItems.map((item) => {
                  const dateLabel = item.startDate
                    ? new Date(item.startDate).toLocaleDateString('fr-FR')
                    : item.endDate
                    ? new Date(item.endDate).toLocaleDateString('fr-FR')
                    : null;
                  const assetName = item.assetLinks?.[0]?.assetName ?? null;
                  return (
                    <Card
                      key={item.id}
                      className="border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] hover:border-[#f59e0b]/50 transition-all group overflow-hidden cursor-pointer"
                      onClick={() => handleOpenAgendaDrawer(item.id)}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start gap-3">
                          <div className="w-10 h-10 rounded-lg bg-[#f59e0b]/10 flex items-center justify-center shrink-0">
                            {loadingAgendaId === item.id
                              ? <Loader2 className="w-5 h-5 text-[#f59e0b] animate-spin" />
                              : <Calendar className="w-5 h-5 text-[#f59e0b]" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <h4
                              className="font-medium text-sm truncate text-[color:var(--text-primary)]"
                              title={item.title}
                            >
                              {item.title}
                            </h4>
                            {assetName && (
                              <p className="text-[11px] text-[color:var(--text-muted)] truncate mt-0.5">
                                {assetName}
                              </p>
                            )}
                            <div className="flex flex-wrap gap-1 mt-2">
                              {item.attentionFlags.map((flag) => {
                                const cfg = FLAG_CONFIG[flag];
                                if (!cfg) return null;
                                return (
                                  <span
                                    key={flag}
                                    className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border ${cfg.color}`}
                                  >
                                    {cfg.icon}
                                    {cfg.label}
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                        <div className="mt-4 pt-4 border-t border-[color:var(--border-subtle)] flex items-center justify-between">
                          <span className="text-[10px] text-[color:var(--text-muted)]">
                            {dateLabel ? `Échéance : ${dateLabel}` : 'Sans date'}
                          </span>
                          <span className="text-[#f59e0b] text-xs font-medium flex items-center gap-1 group-hover:translate-x-1 transition-transform">
                            Voir <ArrowRight className="w-3 h-3" />
                          </span>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* ── Fournisseurs tab ───────────────────────────────────────────── */}
          <TabsContent value="fournisseurs" className="mt-6">
            {loading ? (
              <LoadingSkeleton />
            ) : supplierReviewItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4">
                  <CheckCircle2 className="w-8 h-8 text-green-500" />
                </div>
                <h3 className="text-lg font-medium text-[color:var(--text-primary)]">Tout est à jour !</h3>
                <p className="text-sm text-[color:var(--text-muted)] max-w-xs mx-auto mt-1">
                  Vous n'avez aucun fournisseur à traiter pour le moment.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {supplierReviewItems.map(item => {
                  const isDedup = item.itemType === 'deduplication';
                  const isIban = item.conflictingField === 'iban';
                  const fieldLabel = item.conflictingField ? (CONFLICT_FIELD_LABELS[item.conflictingField] ?? item.conflictingField) : null;

                  return (
                    <button
                      key={item.id}
                      type="button"
                      className="text-left w-full rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] hover:border-[#10b981]/50 hover:bg-[color:var(--accent-soft)]/30 transition-all group overflow-hidden p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#10b981]/50"
                      onClick={() => {
                        if (item.supplierId) {
                          setSupplierDrawerId(item.supplierId);
                          setSupplierDrawerOpen(true);
                        }
                      }}
                    >
                      {/* En-tête */}
                      <div className="flex items-start gap-3 mb-3">
                        <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${isDedup ? 'bg-[#3b82f6]/10' : 'bg-[#f59e0b]/10'}`}>
                          {isDedup
                            ? <GitMerge className="w-4 h-4 text-[#3b82f6]" />
                            : <AlertTriangle className="w-4 h-4 text-[#f59e0b]" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--text-muted)] mb-0.5">
                            {isDedup ? 'Nouveau fournisseur détecté' : `Conflit — ${fieldLabel ?? 'coordonnées'}`}
                          </p>
                          <h4 className="font-semibold text-sm text-[color:var(--text-primary)] truncate">
                            {isDedup ? (item.detectedName ?? 'Nom inconnu') : (item.supplierName ?? 'Fournisseur inconnu')}
                          </h4>
                          {item.documentFilename && (
                            <p className="text-[11px] text-[color:var(--text-muted)] mt-0.5 truncate">
                              via {item.documentFilename}
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Corps — ce que l'IA sait */}
                      {isDedup ? (
                        <div className="rounded-lg bg-[#3b82f6]/5 border border-[#3b82f6]/15 px-3 py-2 text-xs text-[color:var(--text-secondary)]">
                          Ce nom a été détecté automatiquement dans un document.
                          {(item.candidateSupplierIds?.length ?? 0) > 0
                            ? <span className="font-medium text-[#3b82f6]"> Ressemble à un fournisseur existant.</span>
                            : <span className="font-medium text-[#3b82f6]"> Aucun fournisseur correspondant trouvé.</span>
                          }
                        </div>
                      ) : isIban ? (
                        <div className="rounded-lg bg-[#f59e0b]/5 border border-[#f59e0b]/15 px-3 py-2 text-xs text-[color:var(--text-secondary)]">
                          Un <span className="font-medium text-[#f59e0b]">IBAN différent</span> de celui enregistré. Vérifiez dans le drawer.
                        </div>
                      ) : item.detectedValue ? (
                        <div className="rounded-lg bg-[#f59e0b]/5 border border-[#f59e0b]/15 px-3 py-2 space-y-1.5">
                          {item.currentValue && (
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <span className="text-[color:var(--text-muted)] shrink-0">Actuel</span>
                              <span className="text-[color:var(--text-secondary)] truncate text-right">{item.currentValue}</span>
                            </div>
                          )}
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="text-[#f59e0b] font-medium shrink-0">Détecté</span>
                            <span className="text-[color:var(--text-primary)] font-medium truncate text-right">{item.detectedValue}</span>
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-lg bg-[#f59e0b]/5 border border-[#f59e0b]/15 px-3 py-2 text-xs text-[color:var(--text-secondary)]">
                          Valeur non détectée automatiquement. Vérifiez manuellement.
                        </div>
                      )}

                      {/* Action */}
                      <div className="mt-3 flex items-center justify-end">
                        <span className={`text-xs font-semibold flex items-center gap-1 group-hover:translate-x-0.5 transition-transform ${isDedup ? 'text-[#3b82f6]' : 'text-[#f59e0b]'}`}>
                          {isDedup ? 'Rapprocher ou créer' : 'Choisir la bonne valeur'} <ArrowRight className="w-3 h-3" />
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* ── Équipements tab ────────────────────────────────────────────── */}
          <TabsContent value="equipements" className="mt-6">
            {loading ? (
              <LoadingSkeleton />
            ) : data.equipements.length === 0 ? (
              <EmptyState label="équipement" />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {data.equipements.map((eq) => (
                  <Card
                    key={eq.id}
                    className="border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] hover:border-[#8b5cf6]/50 transition-all group overflow-hidden"
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <div className="w-10 h-10 rounded-lg bg-[#8b5cf6]/10 flex items-center justify-center shrink-0">
                          <Wrench className="w-5 h-5 text-[#8b5cf6]" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium text-sm truncate text-[color:var(--text-primary)]" title={eq.name}>
                            {eq.name}
                          </h4>
                          {eq.type && (
                            <p className="text-[11px] text-[color:var(--text-muted)] truncate mt-0.5">{eq.type}</p>
                          )}
                        </div>
                      </div>
                      <div className="mt-4 pt-4 border-t border-[color:var(--border-subtle)] flex items-center justify-end">
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0 text-[#8b5cf6] text-xs font-medium group-hover:translate-x-1 transition-transform"
                          onClick={() => setEditingEquipment({
                            id: eq.id,
                            assetId: eq.assetId ?? 0,
                            name: eq.name,
                            type: eq.type,
                            status: eq.status ?? 'EN_SERVICE',
                          })}
                        >
                          Modifier <ArrowRight className="w-3 h-3 ml-1" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>

        {/* Equipment drawer */}
        <EquipmentDrawer
          open={!!editingEquipment}
          onOpenChange={(open) => { if (!open) setEditingEquipment(null); }}
          assetId={editingEquipment?.assetId ?? 0}
          equipment={editingEquipment}
          substructures={[]}
          initialEditing
          availableAssets={availableAssets}
          onRefresh={() => { setEditingEquipment(null); fetchData(); }}
        />

        {/* Document drawer — identique à la page Mes Documents */}
        {drawerDoc && (
          <DocumentDrawer
            open={drawerOpen}
            onOpenChange={(v) => { setDrawerOpen(v); if (!v) { setDrawerDoc(null); setDrawerDocIndex(-1); } }}
            document={visibleDocuments[drawerDocIndex] ? {
              id: visibleDocuments[drawerDocIndex].id,
              originalFilename: visibleDocuments[drawerDocIndex].originalFilename || visibleDocuments[drawerDocIndex].filename,
              mimeType: visibleDocuments[drawerDocIndex].mimeType || '',
              documentType: visibleDocuments[drawerDocIndex].documentType || 'AUTRE',
              documentDate: visibleDocuments[drawerDocIndex].documentDate,
              uploadedAt: visibleDocuments[drawerDocIndex].uploadedAt,
              assetId: visibleDocuments[drawerDocIndex].assetId ?? visibleDocuments[drawerDocIndex].linkedAssetId ?? 0,
            } : drawerDoc}
            onRefresh={() => {
              apiClient.invalidateCache('/api/dashboard/a-traiter');
              fetchData();
            }}
            onPrev={() => {
              const newIdx = drawerDocIndex - 1;
              const doc = visibleDocuments[newIdx];
              if (doc) { setDrawerDocIndex(newIdx); setDrawerDoc({ id: doc.id, originalFilename: doc.originalFilename || doc.filename, mimeType: doc.mimeType || '', documentType: doc.documentType || 'AUTRE', documentDate: doc.documentDate, uploadedAt: doc.uploadedAt, assetId: doc.assetId ?? doc.linkedAssetId ?? 0 }); }
            }}
            onNext={() => {
              const newIdx = drawerDocIndex + 1;
              const doc = visibleDocuments[newIdx];
              if (doc) { setDrawerDocIndex(newIdx); setDrawerDoc({ id: doc.id, originalFilename: doc.originalFilename || doc.filename, mimeType: doc.mimeType || '', documentType: doc.documentType || 'AUTRE', documentDate: doc.documentDate, uploadedAt: doc.uploadedAt, assetId: doc.assetId ?? doc.linkedAssetId ?? 0 }); }
            }}
            hasPrev={drawerDocIndex > 0}
            hasNext={drawerDocIndex < visibleDocuments.length - 1}
          />
        )}

        {/* Agenda item drawer */}
        <AgendaItemDrawer
          item={agendaDrawerItem}
          open={agendaDrawerOpen}
          initialMode="edit"
          onClose={() => { setAgendaDrawerOpen(false); setAgendaDrawerItem(null); }}
          onMutated={() => { setAgendaDrawerOpen(false); setAgendaDrawerItem(null); fetchData(); }}
        />


      </div>

      {/* Supplier drawer */}
      <SupplierDrawer
        supplierId={supplierDrawerId}
        open={supplierDrawerOpen}
        onOpenChange={(v) => {
          setSupplierDrawerOpen(v);
          if (!v) { setSupplierDrawerId(null); fetchData(); }
        }}
        onUpdated={fetchData}
      />
    </>
  );
}
