"use client"

import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import NextImage from 'next/image';
import { useRouter } from 'next/navigation';
import JSZip from 'jszip';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';
import {
  Plus,
  List,
  Grid3x3,
  Download,
  FileText,
  Lock,
  MoveHorizontal,
  Trash2,
  MoreVertical,
  Eye,
  Edit,
  File,
  ChevronDown,
  Loader2,
  Receipt,
  ShieldCheck,
  Wrench,
  ScrollText,
  Home,
  Car,
  Landmark,
  FileSearch,
  FileCheck,
  BookOpen,
  Link as LinkIcon,
  Wand2,
  CheckSquare,
  Square,
  Sparkles,
  AlertTriangle,
  AlertCircle,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { DocumentEditDialog } from '@/components/document-edit-dialog';
// ⚡ OPTIMISATION: Lazy load des dialogs lourds - chargés uniquement à la demande
const ExportReventeDialog = lazy(() => import('./export-preset-dialogs').then(m => ({ default: m.ExportReventeDialog })));
const ExportAssuranceDevisDialog = lazy(() => import('./export-preset-dialogs').then(m => ({ default: m.ExportAssuranceDevisDialog })));
const ExportAssuranceSinistreDialog = lazy(() => import('./export-preset-dialogs').then(m => ({ default: m.ExportAssuranceSinistreDialog })));
const ExportSavGarantieDialog = lazy(() => import('./export-preset-dialogs').then(m => ({ default: m.ExportSavGarantieDialog })));
const ExportCilDialog = lazy(() => import('./export-preset-dialogs').then(m => ({ default: m.ExportCilDialog })));
const ExportDossierCompletDialog = lazy(() => import('./export-preset-dialogs').then(m => ({ default: m.ExportDossierCompletDialog })));
const ExportTemplateDialog = lazy(() => import('./export-template-dialog').then(m => ({ default: m.ExportTemplateDialog })));
import { apiClient } from '@/lib/api-client';
import { DOCUMENT_TYPE_LABELS } from '@/lib/document-type-constants';
import { PdfThumbnail } from '@/components/ui/pdf-thumbnail';

// ── Document card visual helpers ─────────────────────────────────────────────
function getDocumentCardBg(documentType?: string | null, mimeType?: string): string {
  if (mimeType === 'application/x-web-link') return 'bg-gradient-to-br from-sky-900/80 to-sky-700/60';
  const t = documentType?.toUpperCase() ?? '';
  if (t.includes('FACTURE') || t.includes('BON DE COMMANDE') || t.includes('INVOICE')) return 'bg-gradient-to-br from-amber-900/80 to-amber-700/60';
  if (t.includes('GARANTIE') || t.includes('WARRANTY')) return 'bg-gradient-to-br from-emerald-900/80 to-emerald-700/60';
  if (t.includes('ASSURANCE') || t.includes('ATTESTATION')) return 'bg-gradient-to-br from-blue-900/80 to-blue-700/60';
  if (t.includes('CONTRAT') || t.includes('BAIL') || t.includes('LOYER')) return 'bg-gradient-to-br from-violet-900/80 to-violet-700/60';
  if (t.includes('CERTIFICAT')) return 'bg-gradient-to-br from-teal-900/80 to-teal-700/60';
  if (t.includes('MANUEL') || t.includes('NOTICE') || t.includes('GUIDE')) return 'bg-gradient-to-br from-indigo-900/80 to-indigo-700/60';
  if (t.includes('DPE') || t.includes('DIAGNOSTIC')) return 'bg-gradient-to-br from-orange-900/80 to-orange-700/60';
  if (t.includes('ACTE') || t.includes('NOTAIRE') || t.includes('VENTE')) return 'bg-gradient-to-br from-rose-900/80 to-rose-700/60';
  if (t.includes('DEVIS') || t.includes('ESTIMATION')) return 'bg-gradient-to-br from-cyan-900/80 to-cyan-700/60';
  if (t.includes('ENTRETIEN') || t.includes('MAINTENANCE') || t.includes('CARNET')) return 'bg-gradient-to-br from-yellow-900/80 to-yellow-700/60';
  if (t.includes('PLAN') || t.includes('CADASTRAL') || t.includes('IMMO')) return 'bg-gradient-to-br from-green-900/80 to-green-700/60';
  if (t.includes('CARTE') || t.includes('V\u00C9HICULE') || t.includes('VEHICULE')) return 'bg-gradient-to-br from-red-900/80 to-red-700/60';
  return 'bg-gradient-to-br from-slate-800/90 to-slate-700/70';
}

function getDocumentCardIcon(documentType?: string | null, mimeType?: string) {
  const cls = 'w-12 h-12 opacity-30';
  if (mimeType === 'application/x-web-link') return <LinkIcon className={cls} />;
  const t = documentType?.toUpperCase() ?? '';
  if (t.includes('FACTURE') || t.includes('BON DE COMMANDE') || t.includes('INVOICE')) return <Receipt className={cls} />;
  if (t.includes('GARANTIE') || t.includes('WARRANTY')) return <ShieldCheck className={cls} />;
  if (t.includes('ASSURANCE') || t.includes('ATTESTATION')) return <ShieldCheck className={cls} />;
  if (t.includes('CONTRAT') || t.includes('BAIL') || t.includes('LOYER')) return <ScrollText className={cls} />;
  if (t.includes('CERTIFICAT')) return <FileCheck className={cls} />;
  if (t.includes('MANUEL') || t.includes('NOTICE') || t.includes('GUIDE')) return <BookOpen className={cls} />;
  if (t.includes('DPE') || t.includes('DIAGNOSTIC')) return <FileSearch className={cls} />;
  if (t.includes('ACTE') || t.includes('NOTAIRE') || t.includes('VENTE')) return <Landmark className={cls} />;
  if (t.includes('DEVIS') || t.includes('ESTIMATION')) return <FileText className={cls} />;
  if (t.includes('ENTRETIEN') || t.includes('MAINTENANCE') || t.includes('CARNET')) return <Wrench className={cls} />;
  if (t.includes('PLAN') || t.includes('CADASTRAL') || t.includes('IMMO')) return <Home className={cls} />;
  if (t.includes('CARTE') || t.includes('V\u00C9HICULE') || t.includes('VEHICULE')) return <Car className={cls} />;
  return <File className={cls} />;
}

type PlanType = 'freemium' | 'premium';

  type DocumentItem = {
    id: string;
    name: string;
    typeLabel: string;
    mimeType: string;
    sizeBytes: number;
    createdAt: string;
    documentDate?: string;
    previewUrl?: string;
    iconType: 'image' | 'pdf' | 'doc' | 'other';
    analysisState?: string | null;
  };


type AssetDocumentsPanelProps = {
  assetId: string;
  assetCategory?: string;
  assetName?: string;
  assetTypeId?: number;
  assetTypeSubcategoryId?: number;
  planType: PlanType;
  documents: DocumentItem[];
  defaultViewMode?: 'list' | 'grid';
  onUploadClick?: () => void;
  onRefresh?: () => void;
  onDocumentClick?: (doc: DocumentItem) => void;
};

interface ExportTemplate {
  id: number;
  code: string;
  label: string;
  exportType?: string;
  isActive: boolean;
  pdfmonkeyTemplateId?: string;
}

interface DocumentType {
  id: number;
  code: string;
  label: string;
  isActive: boolean;
}


export function AssetDocumentsPanel({
  assetId,
  assetCategory = '',
  assetName = 'Bien',
  assetTypeId,
  assetTypeSubcategoryId,
  planType,
  documents,
  defaultViewMode = 'list',
  onUploadClick,
  onRefresh,
  onDocumentClick,
}: AssetDocumentsPanelProps) {
  const router = useRouter();
  
  // View mode state with localStorage persistence
  const [viewMode, setViewMode] = useState<'list' | 'grid'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('assetDocumentsViewMode');
      return (saved as 'list' | 'grid') || defaultViewMode;
    }
    return defaultViewMode;
  });

  // Selection state
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  
  // Modals state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showUpgradeDialog, setShowUpgradeDialog] = useState(false);
  const [targetAssetId, setTargetAssetId] = useState<string>('');
  
  // Add preset dialog states
  const [showReventeDialog, setShowReventeDialog] = useState(false);
  const [showAssuranceDevisDialog, setShowAssuranceDevisDialog] = useState(false);
  const [showAssuranceSinistreDialog, setShowAssuranceSinistreDialog] = useState(false);
  const [showSavGarantieDialog, setShowSavGarantieDialog] = useState(false);
  const [showCilDialog, setShowCilDialog] = useState(false);
  const [showDossierCompletDialog, setShowDossierCompletDialog] = useState(false);
  
  // Add edit dialog state
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingDocument, setEditingDocument] = useState<any>(null);
  const [documentTypes, setDocumentTypes] = useState<DocumentType[]>([]);
  
  // Loading states
  const [isDeleting, setIsDeleting] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [downloadingFiles, setDownloadingFiles] = useState<Set<string>>(new Set());
  const [viewingFile, setViewingFile] = useState<{ url: string; filename: string; mimeType: string } | null>(null);
  
  // Assets for move dialog
  const [assets, setAssets] = useState<{ id: number; name: string }[]>([]);
  
  // Export templates state
  const [exportTemplates, setExportTemplates] = useState<ExportTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);

  // ✅ NEW: Selected template state for dialog
  const [selectedTemplate, setSelectedTemplate] = useState<ExportTemplate | null>(null);
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);

  // ⚡ Mémoïser les valeurs calculées
  const selectedCount = useMemo(() => selectedDocumentIds.length, [selectedDocumentIds.length]);
  const isHousing = useMemo(() => assetCategory === 'IMMOBILIER', [assetCategory]);

  // ✅ Load document types
  const loadDocumentTypes = useCallback(async () => {
    try {
      const token = localStorage.getItem('bearer_token');
      if (!token) return;

      const response = await fetch('/api/document-types', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        const types = data.documentTypes && Array.isArray(data.documentTypes) 
          ? data.documentTypes 
          : (Array.isArray(data) ? data : (data?.data || []));
        setDocumentTypes(types);
      }
    } catch (error) {
      console.error('Error loading document types:', error);
    }
  }, []);

  // ✅ Load export templates filtered by asset type
  const loadExportTemplates = useCallback(async () => {
    try {
      setLoadingTemplates(true);
      const token = localStorage.getItem('bearer_token');
      if (!token) return;

      // Build query params for filtering
      const params = new URLSearchParams();
      params.append('isActive', 'true');
      
      if (assetTypeId) {
        params.append('assetTypeId', assetTypeId.toString());
      }
      if (assetTypeSubcategoryId) {
        params.append('assetTypeSubcategoryId', assetTypeSubcategoryId.toString());
      }

      // ✅ FIXED: Use public API endpoint instead of admin-only endpoint
      const response = await fetch(`/api/export-templates?${params.toString()}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        const templates = data.data || [];
        
        // ✅ DÉDUPLICATION : Garder uniquement un template par pdfmonkeyTemplateId
        const uniqueTemplates = templates.reduce((acc: ExportTemplate[], template: ExportTemplate) => {
          const exists = acc.find(t => t.pdfmonkeyTemplateId === template.pdfmonkeyTemplateId);
          if (!exists) {
            acc.push(template);
          }
          return acc;
        }, []);
        
        setExportTemplates(uniqueTemplates);
      }
    } catch (error) {
      console.error('Error loading export templates:', error);
    } finally {
      setLoadingTemplates(false);
    }
  }, [assetTypeId, assetTypeSubcategoryId]);

  // ⚡ Load assets avec cache
  const loadAssets = useCallback(async () => {
    try {
      const data = await apiClient.get<any>('/api/assets?limit=100', { useCache: true });
      setAssets(Array.isArray(data.data) ? data.data : []);
    } catch (error) {
      console.error('Error loading assets:', error);
    }
  }, []);

  useEffect(() => {
    loadAssets();
    loadExportTemplates();
    loadDocumentTypes();
  }, [loadAssets, loadExportTemplates, loadDocumentTypes]);

  // View mode handlers with localStorage persistence
  const handleViewModeChange = useCallback((mode: 'list' | 'grid') => {
    setViewMode(mode);
    localStorage.setItem('assetDocumentsViewMode', mode);
  }, []);

  // ⚡ Mémoïser les handlers de sélection
  const toggleSelect = useCallback((id: string) => {
    setSelectedDocumentIds(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  }, []);

  const selectAll = useCallback(() => {
    setSelectedDocumentIds(documents.map(d => d.id));
  }, [documents]);

  const deselectAll = useCallback(() => {
    setSelectedDocumentIds([]);
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (selectedCount === documents.length && documents.length > 0) {
      deselectAll();
    } else {
      selectAll();
    }
  }, [selectedCount, documents.length, deselectAll, selectAll]);

  // ⚡ Handle preset clicks
  const handlePresetClick = useCallback((preset: string) => {
    if (planType === 'freemium') {
      setShowUpgradeDialog(true);
      return;
    }

    switch (preset) {
      case 'revente':
        setShowReventeDialog(true);
        break;
      case 'assurance-devis':
        setShowAssuranceDevisDialog(true);
        break;
      case 'assurance-sinistre':
        setShowAssuranceSinistreDialog(true);
        break;
      case 'sav-garantie':
        setShowSavGarantieDialog(true);
        break;
      case 'cil':
        setShowCilDialog(true);
        break;
      case 'dossier-complet':
        setShowDossierCompletDialog(true);
        break;
    }
  }, [planType]);

  // ✅ NEW: Handle edit document
  const handleEdit = useCallback(async (doc: DocumentItem) => {
    try {
      // Trouver le code du type de document à partir du label
      const docType = documentTypes.find(dt => dt.label === doc.typeLabel);
      const documentTypeCode = docType?.code || 'AUTRE';
      
      setEditingDocument({
        id: parseInt(doc.id),
        fileName: doc.name,
        documentType: documentTypeCode,
        asset: {
          id: parseInt(assetId),
          name: assetName,
        },
        createdAt: doc.createdAt,
      });
      setShowEditDialog(true);
    } catch (error) {
      console.error('Error preparing document for edit:', error);
      toast.error('Erreur lors du chargement du document');
    }
  }, [assetId, assetName, documentTypes]);

  const handleEditComplete = useCallback(() => {
    setShowEditDialog(false);
    setEditingDocument(null);
    onRefresh?.();
  }, [onRefresh]);

  // ⚡ Export ZIP handler optimisé
  const handleExportZip = useCallback(async () => {
    // Si aucun document sélectionné, prendre tous les documents
    const docsToExport = selectedCount === 0 ? documents : documents.filter(d => selectedDocumentIds.includes(d.id));
    
    if (docsToExport.length === 0) {
      toast.error('Aucun document disponible');
      return;
    }

    try {
      setIsExporting(true);
      toast.info('Préparation du téléchargement...');
      
      // Create ZIP
      const zip = new JSZip();
      
      // ⚡ Download en parallèle avec Promise.allSettled
      const results = await Promise.allSettled(
        docsToExport.map(async (doc) => {
          const { downloadUrl } = await apiClient.get<{ downloadUrl: string }>(
            `/api/files/${doc.id}/download`
          );
          
          const fileResponse = await fetch(downloadUrl);
          if (!fileResponse.ok) throw new Error(`Failed to download ${doc.name}`);
          
          const blob = await fileResponse.blob();
          return { name: doc.name, blob };
        })
      );

      // Add successful downloads to ZIP
      results.forEach((result) => {
        if (result.status === 'fulfilled') {
          zip.file(result.value.name, result.value.blob);
        }
      });

      // Generate ZIP file
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      
      // Create download link
      const url = URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = url;
      
      const currentAsset = assets.find(a => a.id === parseInt(assetId));
      const zipFilename = `${currentAsset?.name || assetName || 'Documents'}_${new Date().toISOString().split('T')[0]}.zip`;
      link.download = zipFilename;
      
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      URL.revokeObjectURL(url);
      
      toast.success(`${docsToExport.length} document${docsToExport.length > 1 ? 's exportés' : ' exporté'} en ZIP`);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Erreur lors de l\'export');
    } finally {
      setIsExporting(false);
    }
  }, [selectedCount, documents, selectedDocumentIds, assets, assetId, assetName]);

  // Export PDF handler (Premium only)
  const handleExportPdf = useCallback(async () => {
    if (selectedCount === 0) {
      toast.error('Sélectionnez au moins un document');
      return;
    }

    if (planType === 'freemium') {
      setShowUpgradeDialog(true);
      return;
    }

    try {
      setIsExporting(true);
      toast.info('Export PDF en cours de développement...');
    } catch (error) {
      console.error('PDF export error:', error);
      toast.error('Erreur lors de l\'export PDF');
    } finally {
      setIsExporting(false);
    }
  }, [selectedCount, planType]);

  // Change asset handler
  const handleChangeAsset = useCallback(() => {
    if (selectedCount === 0) {
      toast.error('Sélectionnez au moins un document');
      return;
    }
    setShowMoveDialog(true);
  }, [selectedCount]);

  const handleMoveConfirm = useCallback(async () => {
    if (!targetAssetId) {
      toast.error('Veuillez sélectionner un bien');
      return;
    }

    try {
      setIsMoving(true);
      
      const result = await apiClient.post<{ moved: number }>('/api/documents/bulk-move', {
        documentIds: selectedDocumentIds.map(id => parseInt(id)),
        targetAssetId: parseInt(targetAssetId),
      });
      
      const assetName = assets.find(a => a.id === parseInt(targetAssetId))?.name || 'le bien';
      toast.success(`${result.moved} document${result.moved > 1 ? 's déplacés' : ' déplacé'} vers ${assetName}`);
      deselectAll();
      setShowMoveDialog(false);
      setTargetAssetId('');
      onRefresh?.();
    } catch (error) {
      console.error('Error moving documents:', error);
      toast.error('Erreur lors du déplacement');
    } finally {
      setIsMoving(false);
    }
  }, [targetAssetId, selectedDocumentIds, assets, deselectAll, onRefresh]);

  // Delete handler
  const handleDeleteSelected = useCallback(() => {
    if (selectedCount === 0) {
      toast.error('Sélectionnez au moins un document');
      return;
    }
    setShowDeleteDialog(true);
  }, [selectedCount]);

  const handleDeleteConfirm = useCallback(async () => {
    try {
      setIsDeleting(true);
      
      const result = await apiClient.post<{ deleted: number }>('/api/documents/bulk-delete', {
        documentIds: selectedDocumentIds.map(id => parseInt(id))
      });
      
      toast.success(`${result.deleted} document${result.deleted > 1 ? 's supprimés' : ' supprimé'}`);
      deselectAll();
      setShowDeleteDialog(false);
      onRefresh?.();
    } catch (error) {
      console.error('Error deleting documents:', error);
      toast.error('Erreur lors de la suppression');
    } finally {
      setIsDeleting(false);
    }
  }, [selectedDocumentIds, deselectAll, onRefresh]);

  // Individual document handlers
  const handleView = useCallback(async (doc: DocumentItem) => {
    try {
      const { viewUrl } = await apiClient.get<{ viewUrl: string }>(`/api/files/${doc.id}/view`);
      
      if (doc.mimeType.startsWith('image/')) {
        setViewingFile({ url: viewUrl, filename: doc.name, mimeType: doc.mimeType });
      } else {
        const isInIframe = window.self !== window.top;
        if (isInIframe) {
          window.parent.postMessage({ type: 'OPEN_EXTERNAL_URL', data: { url: viewUrl } }, '*');
        } else {
          window.open(viewUrl, '_blank', 'noopener,noreferrer');
        }
        toast.success('Document ouvert dans un nouvel onglet');
      }
    } catch (error) {
      console.error('View error:', error);
      toast.error('Erreur lors de la visualisation');
    }
  }, []);

  const handleDownload = useCallback(async (doc: DocumentItem) => {
    try {
      setDownloadingFiles(prev => new Set(prev).add(doc.id));

      const { downloadUrl } = await apiClient.get<{ downloadUrl: string }>(`/api/files/${doc.id}/download`);

      const isInIframe = window.self !== window.top;
      if (isInIframe) {
        window.parent.postMessage({ type: 'OPEN_EXTERNAL_URL', data: { url: downloadUrl } }, '*');
      } else {
        window.open(downloadUrl, '_blank', 'noopener,noreferrer');
      }

      toast.success('Téléchargement démarré');
    } catch (error) {
      console.error('Download error:', error);
      toast.error('Erreur lors du téléchargement');
    } finally {
      setDownloadingFiles(prev => {
        const newSet = new Set(prev);
        newSet.delete(doc.id);
        return newSet;
      });
    }
  }, []);

  const handleDeleteSingle = useCallback((doc: DocumentItem) => {
    setSelectedDocumentIds([doc.id]);
    setShowDeleteDialog(true);
  }, []);

  // Bulk AI analysis via pipeline unifié
  const handleBulkAnalyze = useCallback(async () => {
    if (selectedCount === 0) {
      toast.error('Sélectionnez au moins un document');
      return;
    }
    try {
      setIsAnalyzing(true);
      const fileIds = selectedDocumentIds.map(id => parseInt(id));
      await apiClient.post('/api/documents/analyze-batch', { fileIds });
      toast.success(`Analyse lancée pour ${selectedCount} document${selectedCount > 1 ? 's' : ''}`);
      deselectAll();
      window.dispatchEvent(new CustomEvent('document-analysis-start', { detail: { fileId: fileIds[0] ?? null } }));
      onRefresh?.();
    } catch (err: any) {
      if (err?.message?.includes('PLAN_UPGRADE_REQUIRED') || err?.status === 403) {
        setShowUpgradeDialog(true);
      } else {
        toast.error('Erreur lors de l\'analyse IA');
      }
    } finally {
      setIsAnalyzing(false);
    }
  }, [selectedCount, selectedDocumentIds, deselectAll, onRefresh]);

  // ✅ NEW: Handle template selection - trigger PDF generation via API
  const handleTemplateSelection = useCallback(async (template: ExportTemplate) => {
    if (planType === 'freemium') {
      setShowUpgradeDialog(true);
      return;
    }
    
    // Ouvrir le dialogue intermédiaire pour ce template
    setSelectedTemplate(template);
    setShowTemplateDialog(true);
  }, [planType]);

  // Utility functions
  const formatFileSize = useCallback((bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }, []);

  const formatDate = useCallback((dateStr: string): string => {
    return new Date(dateStr).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }, []);

  const getFileIcon = useCallback((doc: DocumentItem) => {
    if (doc.iconType === 'image') {
      return <File className="w-6 h-6 text-blue-500" />;
    }
    if (doc.iconType === 'pdf') {
      return <FileText className="w-6 h-6 text-red-500" />;
    }
    if (doc.iconType === 'doc') {
      return <FileText className="w-6 h-6 text-blue-600" />;
    }
    return <File className="w-6 h-6 text-muted-foreground" />;
  }, []);

  const getFileExtension = useCallback((name: string): string => {
    const parts = name.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : '—';
  }, []);

  // ⚡ Mémoïser le sous-titre dynamique
  const subtitle = useMemo(() => {
    if (selectedCount === 0) {
      return `${documents.length} document${documents.length !== 1 ? 's' : ''}`;
    }
    return `${documents.length} document${documents.length !== 1 ? 's' : ''} · ${selectedCount} sélectionné${selectedCount !== 1 ? 's' : ''}`;
  }, [documents.length, selectedCount]);

  return (
    <div className="space-y-4">
      {/* En-tête */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-[color:var(--text-primary)] whitespace-nowrap">
            Documents de {assetName}
          </h2>
          <p className="text-sm text-[color:var(--text-muted)] mt-1">
            {subtitle}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {documents.length > 0 && (
            <Button variant="outline" size="sm" onClick={onUploadClick} className="btn-add">
              <Plus className="w-4 h-4 btn-add-plus-icon mr-2" />
              Ajouter
            </Button>
          )}
          <div className="flex items-center rounded-md border border-border overflow-hidden">
            <button
              onClick={() => handleViewModeChange('grid')}
              className={`p-1.5 transition-colors ${viewMode === 'grid' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              title="Vue grille"
            >
              <Grid3x3 className="w-4 h-4" />
            </button>
            <button
              onClick={() => handleViewModeChange('list')}
              className={`p-1.5 transition-colors ${viewMode === 'list' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              title="Vue liste"
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>


      {/* Bulk action bar */}
      {selectedCount > 0 && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-[#3b82f6]/10 border border-[#3b82f6]/30">
          <button
            onClick={toggleSelectAll}
            className="flex items-center gap-2 text-sm font-medium text-[#3b82f6] hover:text-[#2563eb] shrink-0"
          >
            {selectedCount === documents.length ? (
              <CheckSquare className="w-4 h-4" />
            ) : (
              <Square className="w-4 h-4" />
            )}
            <span>{selectedCount} sélectionné{selectedCount > 1 ? 's' : ''}</span>
          </button>
          <div className="flex-1" />
          {/* Bouton Analyse IA supprimé — analyse auto V4 */}
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={handleExportZip}
            disabled={isExporting}
          >
            {isExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Télécharger
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={handleChangeAsset}
          >
            <MoveHorizontal className="w-3.5 h-3.5" />
            Déplacer
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10"
            onClick={handleDeleteSelected}
            disabled={isDeleting}
          >
            {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            Supprimer
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-muted-foreground"
            onClick={deselectAll}
          >
            ✕
          </Button>
        </div>
      )}

      {/* Zone de contenu */}
      {documents.length === 0 ? (
        <Card className="border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] rounded-2xl shadow-sm">
          <CardContent className="flex items-center gap-4 py-4 px-5">
            <div className="w-8 h-8 rounded-full bg-emerald-500/10 flex items-center justify-center flex-shrink-0">
              <FileText className="w-4 h-4 text-emerald-500" />
            </div>
            <div>
              <p className="text-sm font-medium text-[color:var(--text-primary)]">Aucun document pour le moment</p>
              <p className="text-xs text-[color:var(--text-muted)] mt-0.5">Importez votre premier document</p>
            </div>
            <Button onClick={onUploadClick} className="btn-add px-4 flex-shrink-0">
              <Plus className="btn-add-plus-icon w-4 h-4 mr-2" />
              Ajouter mon premier document
            </Button>
          </CardContent>
        </Card>
      ) : viewMode === 'list' ? (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-muted/50 border-b">
                  <tr>
                    <th className="p-4 w-10">
                      <Checkbox
                        checked={selectedCount === documents.length && documents.length > 0}
                        onCheckedChange={toggleSelectAll}
                      />
                    </th>
                    <th className="text-left p-4 font-medium w-20">Aperçu</th>
                    <th className="text-left p-4 font-medium">Nom du document</th>
                      <th className="text-left p-4 font-medium hidden md:table-cell">Type</th>
                      <th className="text-left p-4 font-medium hidden md:table-cell">Date du doc.</th>
                      <th className="text-left p-4 font-medium hidden lg:table-cell">Taille</th>

                    <th className="text-left p-4 font-medium hidden lg:table-cell">Date d'ajout</th>
                    <th className="text-right p-4 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map((doc) => (
                    <tr
                      key={doc.id}
                      className={`border-b hover:bg-muted/30 transition-colors cursor-pointer ${selectedDocumentIds.includes(doc.id) ? 'bg-[#3b82f6]/5' : ''}`}
                      onClick={(e) => {
                        const target = e.target as HTMLElement;
                        if (target.closest('button') || target.closest('[role="checkbox"]')) return;
                        if (onDocumentClick) { onDocumentClick(doc); } else { handleView(doc); }
                      }}
                    >
                      <td className="p-4" onClick={(e) => { e.stopPropagation(); toggleSelect(doc.id); }}>
                        <Checkbox
                          checked={selectedDocumentIds.includes(doc.id)}
                          onCheckedChange={() => toggleSelect(doc.id)}
                        />
                      </td>
                      <td className="p-4">
                        <div className="w-12 h-12 rounded-lg overflow-hidden bg-muted flex items-center justify-center shadow-relief-sm">
                          {doc.previewUrl ? (
                            <NextImage
                              src={doc.previewUrl}
                              alt={doc.name}
                              width={48}
                              height={48}
                              className="w-full h-full object-cover"
                              unoptimized
                            />
                          ) : doc.iconType === 'pdf' ? (
                            <PdfThumbnail fileId={doc.id} className="w-full h-full" />
                          ) : (
                            getFileIcon(doc)
                          )}
                        </div>
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <span className="font-medium truncate max-w-xs block">
                            {doc.name}
                          </span>
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
                      </td>
                        <td className="p-4 hidden md:table-cell">
                          <Badge variant="outline" className="shadow-relief-sm">
                            {doc.typeLabel}
                          </Badge>
                        </td>
                        <td className="p-4 text-sm text-muted-foreground hidden md:table-cell">
                          {doc.documentDate ? formatDate(doc.documentDate) : '—'}
                        </td>
                        <td className="p-4 text-sm text-muted-foreground hidden lg:table-cell">
                          {formatFileSize(doc.sizeBytes)}
                        </td>

                      <td className="p-4 text-sm text-muted-foreground hidden lg:table-cell">
                        {formatDate(doc.createdAt)}
                      </td>
                      <td className="p-4" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm">
                              <MoreVertical className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="shadow-relief-xl">
                            <DropdownMenuItem onClick={() => handleView(doc)}>
                              <Eye className="w-4 h-4 mr-2" />
                              Visualiser
                            </DropdownMenuItem>
                            <DropdownMenuItem 
                              onClick={() => handleDownload(doc)}
                              disabled={downloadingFiles.has(doc.id)}
                            >
                              <Download className="w-4 h-4 mr-2" />
                              Télécharger
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleEdit(doc)}>
                              <Edit className="w-4 h-4 mr-2" />
                              Modifier
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem 
                              onClick={() => handleDeleteSingle(doc)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              Supprimer
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {documents.map((doc) => {
            const ext = getFileExtension(doc.name);
            const isImage = doc.iconType === 'image';
            const isPdf = doc.iconType === 'pdf';
            return (
            <div
              key={doc.id}
              className={`relative rounded-2xl overflow-hidden h-40 cursor-pointer transition-all duration-300 hover:scale-[1.02] hover:-translate-y-1 hover:shadow-[0_20px_48px_rgba(0,0,0,0.4)] ${selectedDocumentIds.includes(doc.id) ? 'ring-2 ring-[#3b82f6] ring-offset-1' : ''}`}
              onClick={() => onDocumentClick ? onDocumentClick(doc) : handleView(doc)}
            >
              {/* Background layer */}
              {isImage && doc.previewUrl ? (
                <NextImage src={doc.previewUrl} alt="" fill className="object-cover" unoptimized />
              ) : isPdf ? (
                <PdfThumbnail fileId={doc.id} className="absolute inset-0 w-full h-full" />
              ) : (
                <div className={`absolute inset-0 flex items-center justify-center ${getDocumentCardBg(doc.typeLabel, doc.mimeType)}`}>
                  {getDocumentCardIcon(doc.typeLabel, doc.mimeType)}
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
                    <div
                      className="w-5 h-5 rounded flex items-center justify-center bg-black/40 backdrop-blur-sm border border-white/20 shrink-0"
                      onClick={(e) => { e.stopPropagation(); toggleSelect(doc.id); }}
                    >
                      {selectedDocumentIds.includes(doc.id) && (
                        <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 12 12">
                          <path d="M10 3L5 8.5 2 5.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                    </div>
                  </div>
                </div>
                <div className="overflow-hidden min-w-0">
                  <p className="font-semibold text-white text-xs leading-tight drop-shadow-lg truncate">{doc.name}</p>
                  {doc.typeLabel && (
                    <p className="text-white/60 text-[10px] mt-0.5 truncate">{doc.typeLabel}</p>
                  )}
                </div>
              </div>
            </div>
            );
          })}
        </div>
      )}

      {/* Modals */}
      {/* Delete Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Supprimer {selectedCount} document{selectedCount > 1 ? 's' : ''} ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Cette action est irréversible. Les fichiers seront définitivement supprimés.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? 'Suppression...' : 'Supprimer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Move Dialog */}
      <Dialog open={showMoveDialog} onOpenChange={setShowMoveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Changer de bien</DialogTitle>
            <DialogDescription>
              Déplacer {selectedCount} document{selectedCount > 1 ? 's' : ''} vers un autre bien
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Select value={targetAssetId} onValueChange={setTargetAssetId}>
              <SelectTrigger>
                <SelectValue placeholder="Sélectionner un bien" />
              </SelectTrigger>
              <SelectContent>
                {assets.filter(a => a.id !== parseInt(assetId)).map((asset) => (
                  <SelectItem key={asset.id} value={asset.id.toString()}>
                    {asset.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => {
                setShowMoveDialog(false);
                setTargetAssetId('');
              }}
              disabled={isMoving}
            >
              Annuler
            </Button>
            <Button
              onClick={handleMoveConfirm}
              disabled={isMoving || !targetAssetId}
            >
              {isMoving ? 'Déplacement...' : 'Appliquer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <DocumentEditDialog
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
        document={editingDocument}
        assets={assets}
        documentTypes={documentTypes}
        onEditComplete={handleEditComplete}
      />

      {/* Upgrade Dialog (Standard) */}
      <AlertDialog open={showUpgradeDialog} onOpenChange={setShowUpgradeDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Lock className="w-5 h-5" />
              Fonction Premium
            </AlertDialogTitle>
            <AlertDialogDescription>
              Les exports spéciaux sont réservés aux utilisateurs Premium.
              Passez à Premium pour débloquer cette fonctionnalité et bien d'autres.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button onClick={() => {
                setShowUpgradeDialog(false);
                window.location.href = '/mon-compte/offres';
              }}>
                Passer en Premium
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* View Dialog (Images only) */}
      <Dialog open={!!viewingFile} onOpenChange={() => setViewingFile(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>{viewingFile?.filename}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto">
            {viewingFile && (
              <img 
                src={viewingFile.url} 
                alt={viewingFile.filename}
                className="max-w-full h-auto"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {showReventeDialog && (
        <Suspense fallback={<div />}>
          <ExportReventeDialog
            open={showReventeDialog}
            onOpenChange={setShowReventeDialog}
            assetId={assetId}
            assetName={assetName}
            documents={documents}
            preselectedDocIds={selectedDocumentIds}
          />
        </Suspense>
      )}

      {showAssuranceDevisDialog && (
        <Suspense fallback={<div />}>
          <ExportAssuranceDevisDialog
            open={showAssuranceDevisDialog}
            onOpenChange={setShowAssuranceDevisDialog}
            assetId={assetId}
            assetName={assetName}
            documents={documents}
            preselectedDocIds={selectedDocumentIds}
          />
        </Suspense>
      )}

      {showAssuranceSinistreDialog && (
        <Suspense fallback={<div />}>
          <ExportAssuranceSinistreDialog
            open={showAssuranceSinistreDialog}
            onOpenChange={setShowAssuranceSinistreDialog}
            assetId={assetId}
            assetName={assetName}
            documents={documents}
            preselectedDocIds={selectedDocumentIds}
          />
        </Suspense>
      )}

      {showSavGarantieDialog && (
        <Suspense fallback={<div />}>
          <ExportSavGarantieDialog
            open={showSavGarantieDialog}
            onOpenChange={setShowSavGarantieDialog}
            assetId={assetId}
            assetName={assetName}
            documents={documents}
            preselectedDocIds={selectedDocumentIds}
          />
        </Suspense>
      )}

      {isHousing && showCilDialog && (
        <Suspense fallback={<div />}>
          <ExportCilDialog
            open={showCilDialog}
            onOpenChange={setShowCilDialog}
            assetId={assetId}
            assetName={assetName}
            assetCategory={assetCategory}
            documents={documents}
            preselectedDocIds={selectedDocumentIds}
          />
        </Suspense>
      )}

      {showDossierCompletDialog && (
        <Suspense fallback={<div />}>
          <ExportDossierCompletDialog
            open={showDossierCompletDialog}
            onOpenChange={setShowDossierCompletDialog}
            assetId={assetId}
            assetName={assetName}
            documents={documents}
            preselectedDocIds={selectedDocumentIds}
          />
        </Suspense>
      )}

      {/* Template Dialog */}
      {showTemplateDialog && selectedTemplate && (
        <Suspense fallback={<div />}>
          <ExportTemplateDialog
            open={showTemplateDialog}
            onOpenChange={setShowTemplateDialog}
            template={selectedTemplate}
            assetId={assetId}
            assetName={assetName}
            documents={documents}
          />
        </Suspense>
      )}
    </div>
  );
}