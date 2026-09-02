"use client"

import { useState, useEffect, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FileText, File, Link as LinkIcon, SlidersHorizontal, X, LayoutGrid, List, Plus, Download, Trash2, Loader2, CheckSquare, Square, Video, Sparkles, AlertTriangle, AlertCircle } from 'lucide-react';
import JSZip from 'jszip';
import { DatePicker } from '@/components/ui/date-picker';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { useSession } from '@/hooks/useSession';
import { apiClient } from '@/lib/api-client';

const UnifiedDocumentDialog = dynamic(
  () => import('@/components/documents/unified-document-dialog').then(m => ({ default: m.UnifiedDocumentDialog })),
  { ssr: false }
);
const DocumentEditDialog = dynamic(
  () => import('@/components/document-edit-dialog').then(m => ({ default: m.DocumentEditDialog })),
  { ssr: false }
);
const DocumentDrawer = dynamic(
  () => import('@/components/assets/DocumentDrawer').then(m => ({ default: m.DocumentDrawer })),
  { ssr: false }
);

interface Document {
  id: number;
  fileName: string;
  retainedTitle?: string | null;
  mimeType: string;
  fileSize: number | null;
  documentType: string;
  documentDate: string | null;
  supplier?: string | null;
  asset: { id: number; name: string } | null;
  createdAt: string;
  webLinkUrl?: string | null;
  analysisState?: string | null;
}
interface Asset { id: number; name: string; }
interface DocumentType { id: number; code: string; label: string; isActive: boolean; }
interface Pagination { page: number; pageSize: number; filteredTotal: number; total: number; }

function WebLinkThumbnail({ url }: { url?: string | null }) {
  const domain = url ? (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; } })() : null;
  const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : null;

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-sky-950 to-sky-900">
      {faviconUrl ? (
        <img
          src={faviconUrl}
          alt={domain ?? ''}
          width={36}
          height={36}
          className="rounded-lg opacity-90"
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
      ) : (
        <LinkIcon className="w-9 h-9 text-sky-400/60" />
      )}
      {domain && (
        <span className="text-[10px] text-sky-300/70 font-medium truncate max-w-[90%] px-1">{domain}</span>
      )}
    </div>
  );
}

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

const getExt = (name: string, mime: string) => {
  if (mime === 'application/x-web-link') return 'LIEN';
  const p = name.split('.');
  if (p.length > 1) { const e = p.pop()!.toUpperCase(); if (e.length <= 5) return e; }
  if (mime.includes('pdf')) return 'PDF';
  if (mime.includes('png')) return 'PNG';
  if (mime.includes('jpg') || mime.includes('jpeg')) return 'JPG';
  return 'FILE';
};

const fmtDate = (d: string | null) => {
  if (!d) return null;
  try { return new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return d; }
};

export default function DocumentsPage() {
  const { user, isLoading: isSessionLoading } = useSession({ required: true });
  const { setBreadcrumbs } = useBreadcrumb();

  useEffect(() => {
    setBreadcrumbs([{ label: 'Mes documents' }]);
  }, [setBreadcrumbs]);

  const [documents, setDocuments] = useState<Document[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [documentTypes, setDocumentTypes] = useState<DocumentType[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, pageSize: 100, filteredTotal: 0, total: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [filePreviewUrls, setFilePreviewUrls] = useState<Record<number, string>>({});

  // Applied filters (multi-select)
  const [assetFilters, setAssetFilters] = useState<string[]>([]);
  const [typeFilters, setTypeFilters] = useState<string[]>([]);
  const [formatFilters, setFormatFilters] = useState<string[]>([]);
  const [supplierFilter, setSupplierFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
  // Pending (edited in drawer, applied on click)
  const [pendingAssets, setPendingAssets] = useState<string[]>([]);
  const [pendingTypes, setPendingTypes] = useState<string[]>([]);
  const [pendingFormats, setPendingFormats] = useState<string[]>([]);
  const [pendingSupplier, setPendingSupplier] = useState('');
  const [pendingDateFrom, setPendingDateFrom] = useState('');
  const [pendingDateTo, setPendingDateTo] = useState('');

  // Dialogs
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [documentToEdit, setDocumentToEdit] = useState<Document | null>(null);
  const [viewingFile, setViewingFile] = useState<{ url: string; filename: string; mimeType: string } | null>(null);
  const [isLoadingView, setIsLoadingView] = useState(false);
  const [downloadingFiles, setDownloadingFiles] = useState<Set<number>>(new Set());
  const [drawerDocId, setDrawerDocId] = useState<number | null>(null);
  const [drawerDocIndex, setDrawerDocIndex] = useState<number>(-1);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [deletingDocId, setDeletingDocId] = useState<number | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [setBearerToken] = useState('');

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);

  const toggleSelectDoc = useCallback((id: number) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  }, []);
  const deselectAll = useCallback(() => setSelectedIds([]), []);


  const docTypeLabels = useMemo(() => {
    const m: Record<string, string> = {};
    documentTypes.forEach(dt => { m[dt.code] = dt.label; });
    return m;
  }, [documentTypes]);
  const getTypeLabel = useCallback((code: string) => docTypeLabels[code] || code, [docTypeLabels]);

  const hasActiveFilters = assetFilters.length > 0 || typeFilters.length > 0 || formatFilters.length > 0 || !!supplierFilter || !!dateFrom || !!dateTo;
  const activeFilterCount = [assetFilters.length > 0, typeFilters.length > 0, formatFilters.length > 0, !!supplierFilter, !!dateFrom || !!dateTo].filter(Boolean).length;

  // ══════════════════════════════════════════════════════════════════════════
  // « AUCUN DOCUMENT » N'EST PAS « AUCUN RÉSULTAT »
  //
  // Le message s'appuyait sur `pagination.total`, un décompte serveur non
  // filtré : sur un compte vide, l'écran annonçait pourtant « Aucun document
  // ne correspond aux filtres » alors qu'aucun filtre n'était posé. On se
  // fie désormais à ce que l'utilisateur voit — rien d'affiché, aucun filtre
  // actif — ce qui décrit exactement sa situation.
  //
  // Les filtres et le sélecteur de vue sont masqués dans ce seul cas. Les
  // masquer dès que la liste est vide enfermerait l'utilisateur : un filtre
  // trop restrictif deviendrait impossible à retirer.
  // ══════════════════════════════════════════════════════════════════════════
  const aucunDocument = filteredDocuments.length === 0 && !hasActiveFilters;

  const loadImagePreviews = useCallback((docs: Document[]) => {
    const urls: Record<number, string> = {};
    docs.filter(d => d.mimeType?.includes('image/')).forEach(d => {
      urls[d.id] = `/api/files/${d.id}/proxy`;
    });
    setFilePreviewUrls(urls);
  }, []);

  const loadAssets = useCallback(async () => {
    try {
      const d = await apiClient.get<{ data: Asset[] }>('/api/assets?limit=100');
      setAssets(Array.isArray(d.data) ? d.data : []);
    } catch {}
  }, []);

  const loadDocumentTypes = useCallback(async () => {
    try {
      const d = await apiClient.get<{ documentTypes?: DocumentType[] }>('/api/document-types');
      setDocumentTypes(Array.isArray(d.documentTypes) ? d.documentTypes : []);
    } catch {}
  }, []);

  const loadDocuments = useCallback(async () => {
    try {
      setIsLoading(true);
      const params = new URLSearchParams({ page: '1', pageSize: '100', sortBy: 'documentDate', sortDir: 'desc' });
      const result = await apiClient.get<{ data: Document[]; pagination: Pagination }>(`/api/documents?${params}`);
      const list: Document[] = result.data || [];
      setDocuments(list);
      setPagination(result.pagination);
      await loadImagePreviews(list);
    } catch { toast.error('Erreur lors du chargement des documents'); }
    finally { setIsLoading(false); }
  }, [loadImagePreviews]);

  useEffect(() => {
    if (!user) return;
    Promise.all([loadAssets(), loadDocumentTypes(), loadDocuments()]);
  }, [user, loadAssets, loadDocumentTypes, loadDocuments]);

  // ⚡ Injection optimiste + re-fetch silencieux quand un document est ajouté
  useEffect(() => {
    const handler = (e: Event) => {
      const doc = (e as CustomEvent).detail?.file as Document | undefined;
      if (doc) {
        // Injection immédiate en tête de liste (uniquement page 1, pas de filtre actif)
        setDocuments(prev => {
          if (prev.some(d => d.id === doc.id)) return prev;
          return [doc, ...prev];
        });
        setPagination(prev => prev ? { ...prev, filteredTotal: prev.filteredTotal + 1, total: prev.total + 1 } : prev);
      }
      // Re-fetch silencieux pour avoir les données complètes
      loadDocuments();
    };
    window.addEventListener('document-added', handler);
    return () => window.removeEventListener('document-added', handler);
  }, [loadDocuments]);

  const openFilterDrawer = () => {
    setPendingAssets([...assetFilters]);
    setPendingTypes([...typeFilters]);
    setPendingFormats([...formatFilters]);
    setPendingSupplier(supplierFilter);
    setPendingDateFrom(dateFrom);
    setPendingDateTo(dateTo);
    setFilterDrawerOpen(true);
  };

  const applyFilters = () => {
    setAssetFilters(pendingAssets);
    setTypeFilters(pendingTypes);
    setFormatFilters(pendingFormats);
    setSupplierFilter(pendingSupplier);
    setDateFrom(pendingDateFrom);
    setDateTo(pendingDateTo);
    setFilterDrawerOpen(false);
  };

  const resetFilters = () => {
    setAssetFilters([]); setTypeFilters([]); setFormatFilters([]);
    setSupplierFilter(''); setDateFrom(''); setDateTo('');
    setPendingAssets([]); setPendingTypes([]); setPendingFormats([]);
    setPendingSupplier(''); setPendingDateFrom(''); setPendingDateTo('');
  };

  const togglePending = (list: string[], setList: (v: string[]) => void, value: string) => {
    setList(list.includes(value) ? list.filter(v => v !== value) : [...list, value]);
  };

  // Client-side filtering (all done client-side for multi-select)
  const filteredDocuments = useMemo(() => {
    return documents.filter(doc => {
      if (assetFilters.length > 0 && !assetFilters.includes(doc.asset?.id?.toString() ?? '')) return false;
      if (typeFilters.length > 0 && !typeFilters.includes(doc.documentType)) return false;
      if (formatFilters.length > 0) {
        const mime = doc.mimeType;
        const matched = formatFilters.some(f => {
          if (f === 'pdf') return mime.includes('pdf');
          if (f === 'image') return mime.startsWith('image/');
          if (f === 'video') return mime.startsWith('video/');
          if (f === 'word') return mime.includes('word') || mime.includes('officedocument.wordprocessing');
          if (f === 'autre') return !mime.includes('pdf') && !mime.startsWith('image/') && !mime.startsWith('video/') && !mime.includes('word');
          return false;
        });
        if (!matched) return false;
      }
      if (supplierFilter && !(doc.supplier ?? '').toLowerCase().includes(supplierFilter.toLowerCase())) return false;
      if (dateFrom && (!doc.documentDate || doc.documentDate < dateFrom)) return false;
      if (dateTo && (!doc.documentDate || doc.documentDate > dateTo)) return false;
      return true;
    });
  }, [documents, assetFilters, typeFilters, formatFilters, supplierFilter, dateFrom, dateTo]);

  const handleView = useCallback(async (docId: number) => {
    try {
      setIsLoadingView(true);
      const { viewUrl, filename, mimeType } = await apiClient.get<{ viewUrl: string; filename: string; mimeType: string }>(`/api/files/${docId}/view`);
      if (mimeType.startsWith('image/')) {
        setViewingFile({ url: viewUrl, filename, mimeType });
      } else {
        const isFrame = window.self !== window.top;
        if (isFrame) window.parent.postMessage({ type: 'OPEN_EXTERNAL_URL', data: { url: viewUrl } }, '*');
        else window.open(viewUrl, '_blank', 'noopener,noreferrer');
        toast.success('Document ouvert dans un nouvel onglet');
      }
    } catch { toast.error('Erreur lors de la visualisation'); }
    finally { setIsLoadingView(false); }
  }, []);

  const handleDownload = useCallback(async (docId: number) => {
    try {
      setDownloadingFiles(prev => new Set(prev).add(docId));
      const { downloadUrl } = await apiClient.get<{ downloadUrl: string }>(`/api/files/${docId}/download`);
      const isFrame = window.self !== window.top;
      if (isFrame) window.parent.postMessage({ type: 'OPEN_EXTERNAL_URL', data: { url: downloadUrl } }, '*');
      else window.open(downloadUrl, '_blank', 'noopener,noreferrer');
      toast.success('Téléchargement démarré');
    } catch { toast.error('Erreur lors du téléchargement'); }
    finally { setDownloadingFiles(prev => { const s = new Set(prev); s.delete(docId); return s; }); }
  }, []);

  const handleDelete = useCallback(async () => {
    if (!deletingDocId) return;
    try {
      setIsDeleting(true);
      await apiClient.fetch(`/api/files/${deletingDocId}`, { method: 'DELETE' });
      toast.success('Document supprimé');
      setShowDeleteDialog(false);
      setDeletingDocId(null);
      loadDocuments();
    } catch { toast.error('Erreur lors de la suppression'); }
    finally { setIsDeleting(false); }
  }, [deletingDocId, loadDocuments]);

  const handleBulkAnalyze = useCallback(async () => {
    if (selectedIds.length === 0) return;
    try {
      setIsAnalyzing(true);
      await apiClient.post('/api/documents/analyze-batch', { fileIds: selectedIds });
      toast.success(`Analyse lancée pour ${selectedIds.length} document${selectedIds.length > 1 ? 's' : ''}`);
      deselectAll();
      window.dispatchEvent(new CustomEvent('document-analysis-start', { detail: { fileId: selectedIds[0] ?? null } }));
    } catch (err: any) {
      if (err?.status === 403 || err?.message?.includes('PLAN_UPGRADE_REQUIRED')) {
        toast.error('L\'analyse IA est disponible avec un abonnement Premium.');
      } else {
        toast.error('Erreur lors de l\'analyse IA');
      }
    } finally {
      setIsAnalyzing(false);
    }
  }, [selectedIds, deselectAll]);

  const handleBulkDownload = useCallback(async () => {
    if (selectedIds.length === 0) return;
    try {
      setIsZipping(true);
      toast.info('Préparation du téléchargement...');
      const zip = new JSZip();
      const results = await Promise.allSettled(
        selectedIds.map(async (id) => {
          const doc = filteredDocuments.find(d => d.id === id);
          const { downloadUrl } = await apiClient.get<{ downloadUrl: string }>(`/api/files/${id}/download`);
          const resp = await fetch(downloadUrl);
          if (!resp.ok) throw new Error('Failed');
          const blob = await resp.blob();
          return { name: doc?.retainedTitle || doc?.fileName || `file_${id}`, blob };
        })
      );
      results.forEach(r => { if (r.status === 'fulfilled') zip.file(r.value.name, r.value.blob); });
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `documents_${new Date().toISOString().split('T')[0]}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      toast.success(`${selectedIds.length} document${selectedIds.length > 1 ? 's téléchargés' : ' téléchargé'}`);
    } catch { toast.error('Erreur lors du téléchargement'); }
    finally { setIsZipping(false); }
  }, [selectedIds, filteredDocuments]);

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.length === 0) return;
    try {
      setIsBulkDeleting(true);
      const result = await apiClient.post<{ deleted: number }>('/api/documents/bulk-delete', { documentIds: selectedIds });
      toast.success(`${result.deleted} document${result.deleted > 1 ? 's supprimés' : ' supprimé'}`);
      deselectAll();
      setShowBulkDeleteDialog(false);
      loadDocuments();
    } catch { toast.error('Erreur lors de la suppression'); }
    finally { setIsBulkDeleting(false); }
  }, [selectedIds, deselectAll, loadDocuments]);

  if (isSessionLoading || (isLoading && documents.length === 0)) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="aspect-[3/4] rounded-2xl" />)}
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <>
      <div className="space-y-5 w-full max-w-full overflow-x-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl md:text-3xl font-bold whitespace-nowrap">Mes documents</h1>
            <p className="text-muted-foreground mt-1">
              {filteredDocuments.length} {filteredDocuments.length > 1 ? 'documents' : 'document'}
              {hasActiveFilters && <span className="ml-1 text-[#3b82f6]">· filtré</span>}
            </p>
          </div>
          <div className={`flex items-center gap-2 ${aucunDocument ? 'hidden' : ''}`}>
            {/* View toggle */}
            <div className="flex items-center rounded-md border border-border overflow-hidden">
              <button
                onClick={() => setViewMode('grid')}
                className={`p-1.5 transition-colors ${viewMode === 'grid' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                title="Vue grille"
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-1.5 transition-colors ${viewMode === 'list' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                title="Vue liste"
              >
                <List className="w-4 h-4" />
              </button>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={openFilterDrawer}
              className="btn-filter relative"
            >
              <SlidersHorizontal className="btn-filter-sliders-icon w-4 h-4" />
              Filtres
              {activeFilterCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[#3b82f6] text-white text-[9px] font-bold flex items-center justify-center">
                  {activeFilterCount}
                </span>
              )}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowUploadDialog(true)} className="btn-add">
              <Plus className="btn-add-plus-icon w-4 h-4" />
              <span className="hidden sm:inline">Ajouter</span>
            </Button>
          </div>
        </div>

        {/* Bulk action bar */}
        {selectedIds.length > 0 && (
          <div className="p-3 rounded-xl bg-[#3b82f6]/10 border border-[#3b82f6]/30">
            {/* Row 1: selection label + close */}
            <div className="flex items-center gap-2 mb-2">
              <button
                onClick={() => {
                  if (selectedIds.length === filteredDocuments.length) deselectAll();
                  else setSelectedIds(filteredDocuments.map(d => d.id));
                }}
                className="flex items-center gap-2 text-sm font-medium text-[#3b82f6] hover:text-[#2563eb] shrink-0"
              >
                {selectedIds.length === filteredDocuments.length ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                <span>{selectedIds.length} sélectionné{selectedIds.length > 1 ? 's' : ''}</span>
              </button>
              <div className="flex-1" />
              <button onClick={deselectAll} className="px-2 py-1 text-muted-foreground hover:text-foreground text-sm">✕</button>
            </div>
            {/* Row 2: action buttons */}
            <div className="flex items-center gap-2">
              {/* Bouton Analyse IA lot supprimé — analyse auto V4 */}
              <button
                onClick={handleBulkDownload}
                disabled={isZipping}
                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-sm rounded-lg border border-border text-foreground hover:bg-muted disabled:opacity-50"
              >
                {isZipping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                <span className="hidden sm:inline">Télécharger</span>
              </button>
              <button
                onClick={() => setShowBulkDeleteDialog(true)}
                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-sm rounded-lg border border-destructive/40 text-destructive hover:bg-destructive/10 btn-delete"
              >
                <Trash2 className="w-3.5 h-3.5 btn-delete-trash-icon" />
                <span className="hidden sm:inline">Supprimer</span>
              </button>
            </div>
          </div>
        )}

        {/* Active filter chips */}
        {hasActiveFilters && (
          <div className="flex flex-wrap gap-2 items-center">
            {assetFilters.map(id => (
              <Badge key={id} variant="secondary" className="gap-1 cursor-pointer" onClick={() => setAssetFilters(assetFilters.filter(v => v !== id))}>
                {assets.find(a => a.id.toString() === id)?.name ?? id} <X className="w-3 h-3" />
              </Badge>
            ))}
            {typeFilters.map(code => (
              <Badge key={code} variant="secondary" className="gap-1 cursor-pointer" onClick={() => setTypeFilters(typeFilters.filter(v => v !== code))}>
                {getTypeLabel(code)} <X className="w-3 h-3" />
              </Badge>
            ))}
            {formatFilters.map(f => (
              <Badge key={f} variant="secondary" className="gap-1 cursor-pointer" onClick={() => setFormatFilters(formatFilters.filter(v => v !== f))}>
                {f.toUpperCase()} <X className="w-3 h-3" />
              </Badge>
            ))}
            {supplierFilter && (
              <Badge variant="secondary" className="gap-1 cursor-pointer" onClick={() => setSupplierFilter('')}>
                {supplierFilter} <X className="w-3 h-3" />
              </Badge>
            )}
            <button onClick={resetFilters} className="text-xs text-muted-foreground hover:text-foreground underline">
              Tout effacer
            </button>
          </div>
        )}

        {/* Documents */}
        {filteredDocuments.length === 0 ? (
          hasActiveFilters ? (
            <div className="text-center py-16">
              <FileText className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-40" />
              <p className="text-muted-foreground">Aucun document ne correspond aux filtres</p>
              <button onClick={resetFilters} className="mt-2 text-sm text-[#3b82f6] hover:underline">Effacer les filtres</button>
            </div>
          ) : (
            /* Même bloc que « Mes biens » : une ligne, une explication, une action. */
            <Card className="border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] rounded-2xl shadow-sm">
              <CardContent className="flex items-center gap-4 py-4 px-5">
                <div className="w-8 h-8 rounded-full bg-[color:var(--accent-soft)] flex items-center justify-center flex-shrink-0">
                  <FileText className="w-4 h-4 text-[color:var(--accent)]" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[color:var(--text-primary)]">Aucun document pour le moment</p>
                  <p className="text-xs text-[color:var(--text-muted)] mt-0.5">Ajoutez votre premier document pour commencer</p>
                </div>
                <Button onClick={() => setShowUploadDialog(true)} className="btn-add px-4 flex-shrink-0 ml-auto">
                  <Plus className="btn-add-plus-icon w-4 h-4 mr-2" />
                  Ajouter mon premier document
                </Button>
              </CardContent>
            </Card>
          )
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {filteredDocuments.map((doc, idx) => {
              const ext = getExt(doc.fileName, doc.mimeType);
              const isImage = doc.mimeType.includes('image/');
              const isWebLink = doc.mimeType === 'application/x-web-link';
              const isPdf = doc.mimeType === 'application/pdf';
              const isVideo = doc.mimeType.startsWith('video/');
              const previewUrl = filePreviewUrls[doc.id];
              return (
                <div
                  key={doc.id}
                  className={`relative rounded-2xl overflow-hidden h-40 cursor-pointer transition-all duration-300 hover:scale-[1.02] hover:-translate-y-1 hover:shadow-[0_20px_48px_rgba(0,0,0,0.4)] ${selectedIds.includes(doc.id) ? 'ring-2 ring-[#3b82f6] ring-offset-1' : ''}`}
                  onClick={() => { setDrawerDocId(doc.id); setDrawerDocIndex(idx); setDrawerOpen(true); }}
                >
                  {/* Background layer */}
                  {isImage && previewUrl ? (
                    <Image src={previewUrl} alt="" fill className="object-cover" unoptimized />
                  ) : isPdf ? (
                    <iframe
                      src={`/api/files/${doc.id}/proxy`}
                      className="absolute inset-0 w-full h-full border-0 pointer-events-none"
                      title={doc.fileName}
                      loading="lazy"
                    />
                  ) : isWebLink ? (
                    <WebLinkThumbnail url={doc.webLinkUrl} />
                  ) : isVideo ? (
                    <div className="absolute inset-0 bg-gradient-to-br from-slate-800 to-slate-900 flex items-center justify-center">
                      <Video className="w-10 h-10 text-white/30" />
                    </div>
                  ) : (
                    <div className="absolute inset-0 bg-gradient-to-br from-muted to-muted/60 flex items-center justify-center">
                      <File className="w-10 h-10 text-muted-foreground/20" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
                  <div className="absolute inset-0 z-10 flex flex-col justify-between p-3">
                    <div className="flex items-start justify-between gap-1">
                      <span className="text-[9px] font-bold uppercase tracking-wider bg-white/15 backdrop-blur-sm border border-white/20 text-white/80 px-1.5 py-0.5 rounded-md">
                        {ext}
                      </span>
                      <div className="flex items-center gap-1">
                        {doc.analysisState === 'ANALYZING' && (
                          <span className="w-5 h-5 rounded bg-[#8b5cf6]/80 backdrop-blur-sm flex items-center justify-center" title="Analyse en cours">
                            <Loader2 className="w-2.5 h-2.5 text-white animate-spin" />
                          </span>
                        )}
                        {doc.analysisState === 'ANALYZED' && (
                          <span className="w-5 h-5 rounded bg-emerald-600/80 backdrop-blur-sm flex items-center justify-center" title="Analysé automatiquement">
                            <Sparkles className="w-2.5 h-2.5 text-white" />
                          </span>
                        )}
                        {doc.analysisState === 'VALIDATION_REQUIRED' && (
                          <span className="w-5 h-5 rounded bg-amber-600/80 backdrop-blur-sm flex items-center justify-center" title="Validation requise">
                            <AlertTriangle className="w-2.5 h-2.5 text-white" />
                          </span>
                        )}
                        {doc.analysisState === 'CONFLICT_DETECTED' && (
                          <span className="w-5 h-5 rounded bg-red-600/80 backdrop-blur-sm flex items-center justify-center" title="Conflit détecté">
                            <AlertCircle className="w-2.5 h-2.5 text-white" />
                          </span>
                        )}
                        {doc.analysisState === 'ANALYSIS_FAILED' && (
                          <span className="w-5 h-5 rounded bg-gray-600/80 backdrop-blur-sm flex items-center justify-center" title="Analyse impossible">
                            <AlertCircle className="w-2.5 h-2.5 text-white" />
                          </span>
                        )}
                        <div
                          className="w-5 h-5 rounded flex items-center justify-center bg-black/40 backdrop-blur-sm border border-white/20 shrink-0"
                          onClick={(e) => { e.stopPropagation(); toggleSelectDoc(doc.id); }}
                        >
                          {selectedIds.includes(doc.id) && (
                            <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 12 12">
                              <path d="M10 3L5 8.5 2 5.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          )}
                        </div>
                      </div>
                    </div>
                    <div>
                      <p className="font-semibold text-white text-xs leading-tight drop-shadow-lg truncate">{doc.retainedTitle || doc.fileName}</p>
                      {doc.documentType && (
                        <p className="text-white/60 text-[10px] mt-0.5 truncate">{getTypeLabel(doc.documentType)}</p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* List view */
          <div className="space-y-1">
            {filteredDocuments.map((doc, idx) => {
              const ext = getExt(doc.fileName, doc.mimeType);
              const isImage = doc.mimeType.includes('image/');
              const isWebLink = doc.mimeType === 'application/x-web-link';
              const isVideo = doc.mimeType.startsWith('video/');
              const previewUrl = filePreviewUrls[doc.id];
              return (
                <div
                  key={doc.id}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer hover:bg-muted/50 transition-colors group ${selectedIds.includes(doc.id) ? 'bg-[#3b82f6]/5' : ''}`}
                  onClick={() => { setDrawerDocId(doc.id); setDrawerDocIndex(idx); setDrawerOpen(true); }}
                >
                  {/* Select checkbox */}
                  <div
                    className="w-4 h-4 rounded border flex items-center justify-center shrink-0 border-muted-foreground/40"
                    onClick={(e) => { e.stopPropagation(); toggleSelectDoc(doc.id); }}
                  >
                    {selectedIds.includes(doc.id) && (
                      <svg className="w-2.5 h-2.5 text-[#3b82f6]" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                  {/* Thumbnail */}
                  <div className="w-10 h-10 rounded-lg overflow-hidden bg-muted flex items-center justify-center shrink-0">
                    {isImage && previewUrl ? (
                      <Image src={previewUrl} alt={doc.fileName} width={40} height={40} className="w-full h-full object-cover" unoptimized />
                    ) : isWebLink ? (
                      <LinkIcon className="w-5 h-5 text-muted-foreground/50" />
                    ) : isVideo ? (
                      <Video className="w-5 h-5 text-muted-foreground/50" />
                    ) : (
                      <File className="w-5 h-5 text-muted-foreground/50" />
                    )}
                  </div>
                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <p className="text-sm font-medium truncate group-hover:text-[#3b82f6] transition-colors">{doc.retainedTitle || doc.fileName}</p>
                      {doc.analysisState === 'ANALYZING' && (
                        <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-medium text-[#8b5cf6] bg-[#8b5cf6]/10 border border-[#8b5cf6]/20 px-1.5 py-0.5 rounded-full">
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />Analyse…
                        </span>
                      )}
                      {doc.analysisState === 'ANALYZED' && (
                        <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded-full">
                          <Sparkles className="w-2.5 h-2.5" />Analysé
                        </span>
                      )}
                      {doc.analysisState === 'VALIDATION_REQUIRED' && (
                        <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-medium text-amber-600 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded-full">
                          <AlertTriangle className="w-2.5 h-2.5" />Valider
                        </span>
                      )}
                      {doc.analysisState === 'CONFLICT_DETECTED' && (
                        <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-medium text-red-600 bg-red-500/10 border border-red-500/20 px-1.5 py-0.5 rounded-full">
                          <AlertCircle className="w-2.5 h-2.5" />Conflit
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {doc.documentType ? getTypeLabel(doc.documentType) : ext}
                      {doc.asset && <span className="ml-1.5 opacity-60">· {doc.asset.name}</span>}
                    </p>
                  </div>
                  {/* Date */}
                  <span className="text-xs text-muted-foreground shrink-0">
                    {doc.documentDate ? fmtDate(doc.documentDate) : fmtDate(doc.createdAt)}
                  </span>
                  {/* Format badge */}
                  <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">
                    {ext}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Filter Drawer */}
      <Sheet open={filterDrawerOpen} onOpenChange={setFilterDrawerOpen}>
        <SheetContent side="right" className="w-80 flex flex-col p-0">
          <SheetHeader className="px-5 py-4 border-b">
            <SheetTitle>Filtres</SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-0">

            {/* Type de bien */}
            <div className="py-4">
              <p className="text-sm font-semibold mb-3">Type de bien</p>
              <div className="space-y-2.5">
                {assets.map(a => {
                  const val = a.id.toString();
                  const checked = pendingAssets.includes(val);
                  return (
                    <label key={a.id} className="flex items-center gap-3 cursor-pointer group">
                      <div
                        className={[
                          'w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors',
                          checked ? 'bg-[#3b82f6] border-[#3b82f6]' : 'border-muted-foreground/40 group-hover:border-[#3b82f6]/60',
                        ].join(' ')}
                        onClick={() => togglePending(pendingAssets, setPendingAssets, val)}
                      >
                        {checked && <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                      </div>
                      <span className="text-sm text-foreground" onClick={() => togglePending(pendingAssets, setPendingAssets, val)}>{a.name}</span>
                    </label>
                  );
                })}
                {assets.length === 0 && <p className="text-sm text-muted-foreground">Aucun bien</p>}
              </div>
            </div>

            <div className="border-t" />

            {/* Type de document */}
            <div className="py-4">
              <p className="text-sm font-semibold mb-3">Type de document</p>
              <div className="space-y-2.5">
                {documentTypes.map(dt => {
                  const checked = pendingTypes.includes(dt.code);
                  return (
                    <label key={dt.code} className="flex items-center gap-3 cursor-pointer group">
                      <div
                        className={[
                          'w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors',
                          checked ? 'bg-[#3b82f6] border-[#3b82f6]' : 'border-muted-foreground/40 group-hover:border-[#3b82f6]/60',
                        ].join(' ')}
                        onClick={() => togglePending(pendingTypes, setPendingTypes, dt.code)}
                      >
                        {checked && <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                      </div>
                      <span className="text-sm text-foreground" onClick={() => togglePending(pendingTypes, setPendingTypes, dt.code)}>{dt.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="border-t" />

            {/* Format */}
            <div className="py-4">
              <p className="text-sm font-semibold mb-3">Format</p>
              <div className="space-y-2.5">
                {[
                  { value: 'pdf', label: 'PDF' },
                  { value: 'image', label: 'Image' },
                  { value: 'video', label: 'Vidéo' },
                  { value: 'word', label: 'Word' },
                  { value: 'autre', label: 'Autre' },
                ].map(f => {
                  const checked = pendingFormats.includes(f.value);
                  return (
                    <label key={f.value} className="flex items-center gap-3 cursor-pointer group">
                      <div
                        className={[
                          'w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors',
                          checked ? 'bg-[#3b82f6] border-[#3b82f6]' : 'border-muted-foreground/40 group-hover:border-[#3b82f6]/60',
                        ].join(' ')}
                        onClick={() => togglePending(pendingFormats, setPendingFormats, f.value)}
                      >
                        {checked && <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                      </div>
                      <span className="text-sm text-foreground" onClick={() => togglePending(pendingFormats, setPendingFormats, f.value)}>{f.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="border-t" />

            {/* Fournisseur */}
            <div className="py-4">
              <p className="text-sm font-semibold mb-3">Fournisseur</p>
              <Input
                placeholder="Ex: EDF, Leroy Merlin…"
                value={pendingSupplier}
                onChange={e => setPendingSupplier(e.target.value)}
              />
            </div>

            <div className="border-t" />

            {/* Date du document */}
            <div className="py-4">
              <p className="text-sm font-semibold mb-3">Date du document</p>
              <div className="space-y-2">
                <DatePicker
                  value={pendingDateFrom}
                  onChange={v => setPendingDateFrom(v)}
                  placeholder="Date de début"
                />
                <DatePicker
                  value={pendingDateTo}
                  onChange={v => setPendingDateTo(v)}
                  placeholder="Date de fin"
                />
              </div>
            </div>

          </div>

          {/* Footer */}
          <div className="px-5 py-4 border-t space-y-2">
            <Button className="w-full" onClick={applyFilters}>Appliquer</Button>
            <button
              onClick={() => {
                setPendingAssets([]); setPendingTypes([]); setPendingFormats([]);
                setPendingSupplier(''); setPendingDateFrom(''); setPendingDateTo('');
              }}
              className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors py-1"
            >
              Réinitialiser
            </button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Dialogs */}
      {showUploadDialog && (
        <UnifiedDocumentDialog
          open={showUploadDialog}
          onOpenChange={setShowUploadDialog}
          availableAssets={assets}
          onSuccess={loadDocuments}
        />
      )}

      {showEditDialog && documentToEdit && (
        <DocumentEditDialog
          open={showEditDialog}
          onOpenChange={setShowEditDialog}
          document={documentToEdit}
          assets={assets}
          documentTypes={documentTypes}
          onEditComplete={() => { loadDocuments(); setShowEditDialog(false); setDocumentToEdit(null); }}
        />
      )}

      <Dialog open={!!viewingFile} onOpenChange={() => setViewingFile(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh]">
          <DialogHeader><DialogTitle>{viewingFile?.filename}</DialogTitle></DialogHeader>
          <div className="flex-1 overflow-auto">
            {viewingFile && (
              viewingFile.mimeType.startsWith('image/') ? (
                <img src={viewingFile.url} alt={viewingFile.filename} className="max-w-full h-auto" />
              ) : viewingFile.mimeType === 'application/pdf' ? (
                <iframe src={viewingFile.url} className="w-full h-[70vh]" title={viewingFile.filename} />
              ) : (
                <div className="text-center py-12">
                  <FileText className="w-16 h-16 mx-auto mb-4 text-muted-foreground" />
                  <Button onClick={() => {
                    const isFrame = window.self !== window.top;
                    if (isFrame) window.parent.postMessage({ type: 'OPEN_EXTERNAL_URL', data: { url: viewingFile.url } }, '*');
                    else window.open(viewingFile.url, '_blank', 'noopener,noreferrer');
                  }}>Ouvrir dans un nouvel onglet</Button>
                </div>
              )
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer ce document ?</AlertDialogTitle>
            <AlertDialogDescription>Cette action est définitive et irréversible. Le fichier sera supprimé définitivement.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setShowDeleteDialog(false); setDeletingDocId(null); }}>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={isDeleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90 btn-delete">
              {isDeleting ? 'Suppression…' : 'Supprimer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showBulkDeleteDialog} onOpenChange={setShowBulkDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer {selectedIds.length} document{selectedIds.length > 1 ? 's' : ''} ?</AlertDialogTitle>
            <AlertDialogDescription>Cette action est irréversible. Les fichiers seront définitivement supprimés.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBulkDeleting}>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={handleBulkDelete} disabled={isBulkDeleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90 btn-delete">
              {isBulkDeleting ? 'Suppression…' : 'Supprimer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {drawerDocId !== null && (
        <DocumentDrawer
          open={drawerOpen}
          onOpenChange={v => { setDrawerOpen(v); if (!v) { setDrawerDocId(null); setDrawerDocIndex(-1); } }}
          document={(() => {
            const doc = filteredDocuments[drawerDocIndex] ?? filteredDocuments.find(d => d.id === drawerDocId);
            if (!doc) return null;
            return {
              id: doc.id,
              originalFilename: doc.fileName ?? '',
              mimeType: doc.mimeType ?? '',
              documentType: doc.documentType ?? 'AUTRE',
              documentDate: doc.documentDate ?? null,
              uploadedAt: doc.createdAt ?? null,
              size: doc.fileSize ?? undefined,
              assetId: doc.asset?.id ?? 0,
            };
          })()}
          onRefresh={loadDocuments}
          onPrev={() => {
            const newIdx = drawerDocIndex - 1;
            const doc = filteredDocuments[newIdx];
            if (doc) { setDrawerDocId(doc.id); setDrawerDocIndex(newIdx); }
          }}
          onNext={() => {
            const newIdx = drawerDocIndex + 1;
            const doc = filteredDocuments[newIdx];
            if (doc) { setDrawerDocId(doc.id); setDrawerDocIndex(newIdx); }
          }}
          hasPrev={drawerDocIndex > 0}
          hasNext={drawerDocIndex < filteredDocuments.length - 1}
        />
      )}
    </>
  );
}
