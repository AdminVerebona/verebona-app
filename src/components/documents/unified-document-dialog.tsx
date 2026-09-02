"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { NumberInput } from '@/components/ui/number-input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Upload, X, FileIcon, Loader2, Link as LinkIcon, Camera, ImageIcon, LayoutGrid, Settings, Check, ChevronDown, Video } from 'lucide-react';
import dynamic from 'next/dynamic';

const CreateAgendaItemDrawer = dynamic(
  () => import('@/components/agenda/CreateAgendaItemDrawer').then(m => ({ default: m.CreateAgendaItemDrawer })),
  { ssr: false }
);
import { toast } from 'sonner';
import { UploadNoticeBanner } from '@/components/upload-notice-banner';
import { useIsMobile } from '@/hooks/use-mobile';
import { useFeatureFlags } from '@/hooks/useFeatureFlags';
import { apiClient } from '@/lib/api-client';
import { Substructure, Equipment, assetSupportsStructuralFeatures } from '@/types/domain';
import { PICKER_DOCUMENT_TYPES } from '@/lib/document-type-constants';
import { normalizeMimeType, computeFileSha256 } from '@/lib/file-validation';
import { FusionSuggestionModal } from './FusionSuggestionModal';
import type { FusionCandidate } from '@/services/document-ai/fusion-detector';
import { parseWriteBlocked, notifyWriteBlocked } from '@/lib/write-blocked';

/**
 * Echec de la demande d'URL signee.
 *
 * ⚠️ LE MOTIF DU REFUS ETAIT PERDU. Les deux appels a `/api/files/presign`
 * levaient « Échec de la préparation du téléchargement » sans lire le corps
 * de la reponse. Un refus de droits — essai termine, quota documentaire
 * atteint — arrivait donc a l'utilisateur sous la forme d'une panne
 * technique, sans indication ni moyen d'agir.
 */
async function presignError(res: Response): Promise<Error> {
  const body = await res.json().catch(() => ({}));
  const refus = parseWriteBlocked(body);
  if (refus) {
    notifyWriteBlocked(refus);
    return new Error(refus.message);
  }
  return new Error(
    (body as { message?: string })?.message ||
      'Échec de la préparation du téléchargement',
  );
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface UnifiedDocumentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  onFilesUploaded?: (fileIds: number[]) => void;
  preselectedAssetId?: number;
  preselectedSubstructureId?: number | null;
  preselectedEquipmentId?: number | null;
  preselectedEventIds?: number[];
  availableAssets?: Array<{ id: number; name: string }>;
  availableEvents?: Array<{ id: number; title: string; date: string; eventType: string }>;
  initialFiles?: File[];
  initialSource?: 'photo' | 'gallery' | 'file' | 'weblink';
  allowAssetSelection?: boolean;
  allowEventCreation?: boolean;
  allowEventAssociation?: boolean;
}

interface FileWithPreview {
  file: File;
  preview?: string;
}

interface DocumentType {
  id: number;
  code: string;
  label: string;
  isActive: boolean;
  hideFromPicker?: boolean;
}

const FALLBACK_DOCUMENT_TYPES = PICKER_DOCUMENT_TYPES.map((t, i) => ({ id: i + 1, code: t.code, label: t.label, isActive: true }));

const EVENT_CATEGORIES = [
  { value: 'achat', label: 'Achat' },
  { value: 'vente', label: 'Vente' },
  { value: 'entretien', label: 'Entretien' },
  { value: 'reparation', label: 'Réparation' },
  { value: 'sinistre', label: 'Sinistre' },
  { value: 'controle', label: 'Contrôle' },
  { value: 'garantie', label: 'Garantie' },
  { value: 'autre', label: 'Autre' },
];

// ─── Component ─────────────────────────────────────────────────────────────────

export function UnifiedDocumentDialog({
  open,
  onOpenChange,
  onSuccess,
  onFilesUploaded,
  preselectedAssetId,
  preselectedSubstructureId,
  preselectedEquipmentId,
  preselectedEventIds = [],
  availableAssets: providedAssets,
  availableEvents: providedEvents,
  initialFiles,
  initialSource,
  allowAssetSelection = true,
  allowEventCreation = true,
  allowEventAssociation = true,
}: UnifiedDocumentDialogProps) {
  const isMobile = useIsMobile();
  const { isPremium } = useFeatureFlags();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);

  // ── Mode ────────────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<'file' | 'weblink'>('file');
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);

  // ── Files (pending, not yet uploaded) ───────────────────────────────────────
  const [files, setFiles] = useState<FileWithPreview[]>([]);

  // ── Form fields ─────────────────────────────────────────────────────────────
  const [title, setTitle] = useState('');
  const [documentType, setDocumentType] = useState('AUTRE');
  const [documentDate, setDocumentDate] = useState(new Date().toISOString().split('T')[0]);
  const [assetId, setAssetId] = useState<string>(preselectedAssetId?.toString() || '0');
  const [supplier, setSupplier] = useState('');
  const [amount, setAmount] = useState('');
  const [webLinkUrl, setWebLinkUrl] = useState('');
  const [webLinkTitle, setWebLinkTitle] = useState('');
  const [showExtraFields, setShowExtraFields] = useState(false);

  // ── Events ──────────────────────────────────────────────────────────────────
  const [selectedEventIds, setSelectedEventIds] = useState<number[]>(preselectedEventIds);
  const [createEvent, setCreateEvent] = useState(false);
  const [eventType, setEventType] = useState('');

  // ── Substructures & Equipments ──────────────────────────────────────────────
  const [substructures, setSubstructures] = useState<Substructure[]>([]);
  const [equipments, setEquipments] = useState<Equipment[]>([]);
  const [selectedSubstructureId, setSelectedSubstructureId] = useState<string>(preselectedSubstructureId?.toString() || 'none');
  const [selectedEquipmentId, setSelectedEquipmentId] = useState<string>(preselectedEquipmentId?.toString() || 'none');
  const [loadingRelations, setLoadingRelations] = useState(false);

  // ── Data from API ───────────────────────────────────────────────────────────
  const [documentTypes, setDocumentTypes] = useState<DocumentType[]>(FALLBACK_DOCUMENT_TYPES);
  const [loadingTypes, setLoadingTypes] = useState(true);
  const [internalAssets, setInternalAssets] = useState<Array<{ id: number; name: string }>>([]);
  const [internalEvents, setInternalEvents] = useState<Array<{ id: number; title: string; date: string; eventType: string }>>([]);
  const [loadingData, setLoadingData] = useState(false);

  // ── Pending AI room/equipment references (matched after substructures/equipments load) ─
  const [pendingRoomRef, setPendingRoomRef] = useState<string | null>(null);
  const [pendingEquipmentRef, setPendingEquipmentRef] = useState<string | null>(null);

  // ── Fusion suggestion state ───────────────────────────────────────────────────
  const [fusionModalOpen, setFusionModalOpen] = useState(false);
  const [fusionNewFileId, setFusionNewFileId] = useState<number | null>(null);
  const [fusionNewFilename, setFusionNewFilename] = useState('');
  const [fusionCandidate, setFusionCandidate] = useState<FusionCandidate | null>(null);

  // ── Agenda drawer ────────────────────────────────────────────────────────────
  const [agendaDrawerOpen, setAgendaDrawerOpen] = useState(false);
  const [agendaPrefill, setAgendaPrefill] = useState<{ title: string; startDate: string }>({ title: '', startDate: '' });

  // ── Computed ────────────────────────────────────────────────────────────────
  const assets = useMemo(() => providedAssets || internalAssets, [providedAssets, internalAssets]);
  const events = useMemo(() => providedEvents || internalEvents, [providedEvents, internalEvents]);

  const selectedAssetSupportsStructural = useMemo(() => {
    if (!assetId || assetId === '0') return false;
    const selectedAsset = assets.find(a => a.id.toString() === assetId);
    if (!selectedAsset) return false;
    return assetSupportsStructuralFeatures(selectedAsset as any);
  }, [assetId, assets]);

  useEffect(() => {
    if (!open) return;

    // Load initial files
    if (initialFiles && initialFiles.length > 0) {
      setFiles(initialFiles.map(file => ({
        file,
        preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
      })));
    }
    if (initialSource) {
      setMode(initialSource === 'weblink' ? 'weblink' : 'file');
    }

    const fetchData = async () => {
      setLoadingTypes(true);
      setLoadingData(true);
      try {
        const headers = {};

        const dtResponse = await fetch('/api/document-types', { headers });
        if (dtResponse.ok) {
          const data = await dtResponse.json();
          if (data.documentTypes) {
            setDocumentTypes(data.documentTypes.filter((dt: DocumentType) => dt.isActive && !dt.hideFromPicker));
          }
        }

        if (!providedAssets) {
          const assetsData = await apiClient.get<any>('/api/assets?limit=100');
          setInternalAssets(assetsData.data || []);
        }
      } catch (error) {
        console.error('Failed to load data:', error);
      } finally {
        setLoadingTypes(false);
        setLoadingData(false);
      }
    };

    fetchData();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load relations when asset changes
  useEffect(() => {
    if (!open || !assetId || assetId === '0') {
      setSubstructures([]);
      setEquipments([]);
      setSelectedSubstructureId('none');
      setSelectedEquipmentId('none');
      return;
    }
    const aid = parseInt(assetId);
    setLoadingRelations(true);
    Promise.all([
      providedEvents ? Promise.resolve({ data: providedEvents }) : apiClient.get<any>(`/api/events?assetId=${aid}&limit=10`),
      apiClient.get<Substructure[]>(`/api/assets/${aid}/substructures`),
      apiClient.get<Equipment[]>(`/api/assets/${aid}/equipments`),
    ]).then(([eventsData, subs, eqs]) => {
      if (!providedEvents) setInternalEvents((eventsData as any).data || []);
      setSubstructures(subs || []);
      setEquipments(eqs || []);
    }).catch(console.error).finally(() => setLoadingRelations(false));
  }, [open, assetId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync event date
  useEffect(() => {
    if (selectedEventIds.length > 0 && events.length > 0) {
      const ev = events.find(e => e.id === selectedEventIds[0]);
      if (ev) setDocumentDate(ev.date);
    }
  }, [selectedEventIds, events]);

  // Apply pending AI room/equipment references once substructures/equipments are loaded
  useEffect(() => {
    if (pendingRoomRef && substructures.length > 0) {
      const ref = pendingRoomRef.toLowerCase();
      const match = substructures.find(s => s.name.toLowerCase().includes(ref) || ref.includes(s.name.toLowerCase()));
      if (match) setSelectedSubstructureId(match.id.toString());
      setPendingRoomRef(null);
    }
  }, [substructures, pendingRoomRef]);

  useEffect(() => {
    if (pendingEquipmentRef && equipments.length > 0) {
      const ref = pendingEquipmentRef.toLowerCase();
      const match = equipments.find(e => e.name.toLowerCase().includes(ref) || ref.includes(e.name.toLowerCase()));
      if (match) setSelectedEquipmentId(match.id.toString());
      setPendingEquipmentRef(null);
    }
  }, [equipments, pendingEquipmentRef]);

  // Sync preselected asset
  useEffect(() => {
    if (preselectedAssetId) setAssetId(preselectedAssetId.toString());
  }, [preselectedAssetId]);


  // ── File helpers ────────────────────────────────────────────────────────────
  const calculateHash = async (file: File): Promise<string> => {
    try { return await computeFileSha256(file); } catch { return 'placeholder-hash'; }
  };

  // ── IA analysis — fire & forget after drawer closes ─────────────────────────

  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').trim();

  // ── Core upload helper (presign → S3 PUT → confirm) ─────────────────────────
  const doUpload = useCallback(async (file: File): Promise<number> => {
    const targetAssetId = assetId && assetId !== '0' ? parseInt(assetId) : null;
    const sha256Hash = await calculateHash(file);

    const presignRes = await fetch('/api/files/presign', {
      credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json'},
      body: JSON.stringify({ filename: file.name, mimeType: normalizeMimeType(file), size: file.size, sha256Hash, assetId: targetAssetId }),
    });
    if (!presignRes.ok) throw await presignError(presignRes);
    const { uploadUrl, fileId } = await presignRes.json();

    const uploadController = new AbortController();
    const uploadTimeout = setTimeout(() => uploadController.abort(), 120_000); // 2 min max
    let uploadRes: Response;
    try {
      uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': normalizeMimeType(file) },
        signal: uploadController.signal,
      });
    } catch (e) {
      // ══════════════════════════════════════════════════════════════════
      // UN `TypeError: Failed to fetch` SUR S3 SIGNIFIE PRESQUE TOUJOURS CORS
      //
      // Le navigateur envoie le fichier DIRECTEMENT au stockage objet, sur
      // un autre domaine. Si le bucket n'autorise pas l'origine de
      // l'application, le contrôle préalable échoue et `fetch` lève un
      // TypeError nu — sans code, sans statut, sans en-tête.
      //
      // Le message générique « Échec du téléchargement » envoyait alors
      // chercher un défaut applicatif là où c'est une autorisation de
      // bucket qui manque. La distinction fait gagner des heures.
      // ══════════════════════════════════════════════════════════════════
      if ((e as Error).name === 'AbortError') {
        throw new Error("Le téléchargement a dépassé deux minutes. Réessayez avec un fichier plus léger.");
      }
      throw new Error(
        "Le stockage a refusé le fichier. L'origine de l'application n'est " +
        'probablement pas autorisée sur le bucket (CORS). ' +
        'Consultez la console du navigateur pour le détail.',
      );
    } finally {
      clearTimeout(uploadTimeout);
    }
    if (!uploadRes.ok) {
      throw new Error(
        `Le stockage a refusé le fichier (${uploadRes.status}). ` +
        (uploadRes.status === 403
          ? "L'URL signée est peut-être expirée : réessayez."
          : 'Réessayez, ou signalez ce code.'),
      );
    }

    const confirmRes = await fetch('/api/files/confirm', {
      credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json'},
      body: JSON.stringify({
        fileId, assetId: targetAssetId,
        substructureId: selectedSubstructureId === 'none' ? null : parseInt(selectedSubstructureId),
        equipmentId: selectedEquipmentId === 'none' ? null : parseInt(selectedEquipmentId),
        documentType, documentDate: documentDate || null,
        description: title || null, supplier: supplier || null, amountCents: null,
      }),
    });
    if (!confirmRes.ok) throw new Error('Échec de la confirmation du téléchargement');
    return fileId as number;
   
  }, [assetId, selectedSubstructureId, selectedEquipmentId, documentType, documentDate, title, supplier]);


  const addFiles = (newFiles: File[]) => {
    // Just add to list — user chooses next action via footer buttons
    setFiles(prev => [...prev, ...newFiles.map(file => ({
      file,
      preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
    }))]);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(Array.from(e.target.files));
    }
    e.target.value = '';
  };

  const removeFile = (index: number) => {
    setFiles(prev => {
      const next = [...prev];
      if (next[index].preview) URL.revokeObjectURL(next[index].preview!);
      next.splice(index, 1);
      return next;
    });
  };

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  // ── Reset ────────────────────────────────────────────────────────────────────
  const resetForm = () => {
    files.forEach(f => { if (f.preview) URL.revokeObjectURL(f.preview); });
    setFiles([]);
    setTitle('');
    setDocumentType('AUTRE');
    setDocumentDate(new Date().toISOString().split('T')[0]);
    setAssetId(preselectedAssetId?.toString() || '0');
    setSupplier('');
    setAmount('');
    setSelectedEventIds([]);
    setCreateEvent(false);
    setEventType('');
    setMode('file');
    setWebLinkUrl('');
    setWebLinkTitle('');
    setUploadProgress(null);
  };

  const handleClose = () => {
    if (isUploading) {
      uploadAbortRef.current?.abort();
      uploadAbortRef.current = null;
      setIsUploading(false);
      setUploadProgress(null);
    }
    resetForm();
    onOpenChange(false);
  };

  // ── Submit ───────────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (mode === 'file' && files.length === 0) {
      toast.error('Veuillez sélectionner au moins un fichier');
      return;
    }
    if (mode === 'weblink' && !webLinkUrl) {
      toast.error('Veuillez saisir une URL');
      return;
    }
    if (mode === 'weblink' && !webLinkTitle) {
      toast.error('Veuillez saisir un nom pour le document');
      return;
    }
    if (createEvent && (!assetId || assetId === '0')) {
      toast.error('Veuillez sélectionner un bien pour créer un événement');
      return;
    }
    if (createEvent && !eventType) {
      toast.error('Veuillez sélectionner un type d\'événement');
      return;
    }

    setIsUploading(true);
    const targetAssetId = assetId && assetId !== '0' ? parseInt(assetId) : null;
    const amountCents = amount ? Math.round(parseFloat(amount) * 100) : null;

    try {
      let uploadedFileIds: number[] = [];

      if (mode === 'weblink') {
        // ── Création du lien web ──────────────────────────────────────────────
        const wlRes = await fetch('/api/web-links', {
      credentials: 'include',
          method: 'POST',
          headers: { 'Content-Type': 'application/json'},
          body: JSON.stringify({
            url: webLinkUrl,
            title: webLinkTitle,
            documentType,
            assetId: targetAssetId,
            documentDate: documentDate || null,
            description: title || null,
            supplier: supplier || null,
            amountCents: amountCents || null,
          }),
        });
        if (!wlRes.ok) {
          const err = await wlRes.json().catch(() => ({}));
          toast.error(err.message || `Erreur ${wlRes.status}`);
          setIsUploading(false);
          return;
        }
        const { webLink } = await wlRes.json();
        uploadedFileIds.push(webLink.id);

      } else {
        uploadAbortRef.current = new AbortController();
        const abortSignal = uploadAbortRef.current.signal;
        let completedCount = 0;
        setUploadProgress({ current: 0, total: files.length });

        // Étape 1 : presign + S3 PUT pour chaque fichier en parallèle
        const uploadOne = async (file: File): Promise<number> => {
          if (abortSignal.aborted) throw new Error('Upload annulé');
          const sha256Hash = await calculateHash(file);

          const presignResponse = await fetch('/api/files/presign', {
      credentials: 'include',
            method: 'POST',
            headers: { 'Content-Type': 'application/json'},
            body: JSON.stringify({
              filename: file.name,
              mimeType: normalizeMimeType(file),
              size: file.size,
              sha256Hash,
              assetId: targetAssetId,
            }),
            signal: abortSignal,
          });
          if (!presignResponse.ok) throw await presignError(presignResponse);
          const { uploadUrl, fileId } = await presignResponse.json();

          const uploadTmo = setTimeout(() => uploadAbortRef.current?.abort(), 120_000);
          let uploadResponse: Response;
          try {
            uploadResponse = await fetch(uploadUrl, {
              method: 'PUT',
              body: file,
              headers: { 'Content-Type': normalizeMimeType(file) },
              signal: abortSignal,
            });
          } finally {
            clearTimeout(uploadTmo);
          }
          if (!uploadResponse.ok) throw new Error('Échec du téléchargement du fichier');

          completedCount++;
          setUploadProgress({ current: completedCount, total: files.length });
          return fileId as number;
        };

        // Upload tous les fichiers en parallèle vers S3
        const allFileIds = await Promise.all(files.map(f => uploadOne(f.file)));

        // Étape 2 : un seul confirm avec tous les fileIds du batch
        // Le pipeline unifié côté serveur gère le regroupement et l'analyse en une seule passe
        const confirmResponse = await fetch('/api/files/confirm', {
      credentials: 'include',
          method: 'POST',
          headers: { 'Content-Type': 'application/json'},
          body: JSON.stringify({
            fileId: allFileIds[0],
            fileIds: allFileIds,
            assetId: targetAssetId,
            substructureId: selectedSubstructureId === 'none' ? null : parseInt(selectedSubstructureId),
            equipmentId: selectedEquipmentId === 'none' ? null : parseInt(selectedEquipmentId),
            documentType, documentDate: documentDate || null,
            description: title || null,
            supplier: supplier || null,
            amountCents,
          }),
        });
        if (!confirmResponse.ok) throw new Error('Échec de la confirmation du téléchargement');

        uploadedFileIds = allFileIds;
      }

      // Associate with events
      for (const eventId of selectedEventIds) {
        await fetch(`/api/events/${eventId}/documents`, {
      credentials: 'include',
          method: 'POST',
          headers: { 'Content-Type': 'application/json'},
          body: JSON.stringify({ fileIds: uploadedFileIds }),
        }).catch(() => {});
      }

      // Create new event
      if (createEvent && assetId && assetId !== '0') {
        const userStr = localStorage.getItem('user');
        if (userStr) {
          const user = JSON.parse(userStr);
          const categoryLabel = EVENT_CATEGORIES.find(c => c.value === eventType)?.label;
          const eventTitle = categoryLabel || documentTypes.find(dt => dt.code === documentType)?.label || 'Document ajouté';
          const eventResponse = await fetch('/api/events', {
      credentials: 'include',
            method: 'POST',
            headers: { 'Content-Type': 'application/json'},
            body: JSON.stringify({
              userId: user.id, assetId: parseInt(assetId),
              substructureId: selectedSubstructureId === 'none' ? null : parseInt(selectedSubstructureId),
              equipmentId: selectedEquipmentId === 'none' ? null : parseInt(selectedEquipmentId),
              categorie: eventType, title: eventTitle,
              date: documentDate,
              provider: supplier || null,
              costCents: amountCents,
              notes: title || (mode === 'weblink' ? webLinkTitle : files[0].file.name),
            }),
          });
          if (eventResponse.ok) {
            const { event } = await eventResponse.json();
            await fetch(`/api/events/${event.id}/documents`, {
      credentials: 'include',
              method: 'POST',
              headers: { 'Content-Type': 'application/json'},
              body: JSON.stringify({ fileIds: uploadedFileIds }),
            }).catch(() => {});
          }
        }
      }

      onFilesUploaded?.(uploadedFileIds);

      if (isPremium) {
        // Upload terminé — le pipeline unifié tourne déjà en arrière-plan côté serveur
        // (déclenché par /api/files/confirm avec fileIds[]).
        // On signal le début d'analyse (bannière) et on ferme le dialog.
        const count = uploadedFileIds.length;
        const isWl = mode === 'weblink';
        toast.success(isWl ? 'Lien web ajouté' : count > 1 ? `${count} documents ajoutés` : '1 document ajouté');
        window.dispatchEvent(new CustomEvent('document-added'));
        // Signal une seule fois pour l'ensemble du batch (bannière d'analyse)
        // On passe le premier fileId pour permettre l'ouverture du drawer via "Voir →"
        const firstUploadedId = uploadedFileIds[0] ?? null;
        window.dispatchEvent(new CustomEvent('document-analysis-start', { detail: { fileId: firstUploadedId } }));
        window.dispatchEvent(new CustomEvent('refresh-a-traiter'));
        onFilesUploaded?.(uploadedFileIds);
        onSuccess?.();
        resetForm();
        onOpenChange(false);
      } else {
        // Standard — pas d'analyse IA
        const isWl = mode === 'weblink';
        const singleFileId = uploadedFileIds[0];
        toast.success(isWl ? 'Lien web ajouté' : '1 document ajouté');
        resetForm();
        window.dispatchEvent(new CustomEvent('document-added', { detail: { file: {
          id: singleFileId,
          fileName: isWl ? webLinkTitle : (files[0]?.file?.name ?? title ?? 'Document'),
          retainedTitle: isWl ? webLinkTitle : (title || files[0]?.file?.name || null),
          mimeType: isWl ? 'application/x-web-link' : (files[0]?.file ? normalizeMimeType(files[0].file) : 'application/octet-stream'),
          fileSize: isWl ? null : (files[0]?.file?.size ?? null),
          documentType: documentType || null,
          documentDate: documentDate || null,
          supplier: supplier || null,
          amountCents: amountCents || null,
          assetId: targetAssetId,
          webLinkUrl: isWl ? webLinkUrl : null,
          createdAt: new Date().toISOString(),
          analysisState: null,
        }}}));
        onSuccess?.();
        onOpenChange(false);
      }
    } catch (error) {
      const isAbort = (error as Error)?.name === 'AbortError' || (error as Error)?.message === 'Upload annulé';
      if (!isAbort) {
        console.error('Upload error:', error);
        toast.error('Erreur lors de l\'ajout du document');
      }
    } finally {
      uploadAbortRef.current = null;
      setIsUploading(false);
    }
  };

  // ── Derived state ────────────────────────────────────────────────────────────
  const canSubmit = mode === 'file'
    ? files.length > 0 && !isUploading
    : !!webLinkUrl && !!webLinkTitle && !isUploading;

  // ── Render ───────────────────────────────────────────────────────────────────
  const formContent = (
    <div className="flex flex-col gap-5">
      <UploadNoticeBanner />

      {/* Upload progress banner */}
      {isUploading && (
        <div className="flex flex-col gap-1.5 px-3 py-2.5 rounded-xl bg-white/5 border border-white/10">
          <div className="flex items-center gap-2 text-sm">
            <Loader2 className="w-4 h-4 text-white/60 animate-spin flex-shrink-0" />
            <span className="text-white/80 font-medium">
              {uploadProgress && uploadProgress.total > 1
                ? `Envoi ${uploadProgress.current}/${uploadProgress.total}…`
                : 'Envoi en cours…'}
            </span>
            {uploadProgress && uploadProgress.total > 1 && (
              <span className="text-white/40 text-xs ml-auto">{Math.round((uploadProgress.current / uploadProgress.total) * 100)}%</span>
            )}
          </div>
          {uploadProgress && uploadProgress.total > 1 && (
            <div className="h-1 rounded-full bg-[#7c3aed]/20 overflow-hidden">
              <div
                className="h-full rounded-full bg-[#7c3aed] transition-all duration-500"
                style={{ width: `${Math.round((uploadProgress.current / uploadProgress.total) * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}
      {/* Mode toggle — only if not a specific capture source */}
      {(!initialSource || initialSource === 'file' || initialSource === 'weblink') && (
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant={mode === 'file' ? 'default' : 'outline'}
            onClick={() => { setMode('file'); if (mode !== 'file') return; openFilePicker(); }}
            disabled={isUploading}
          >
            <Upload className="w-4 h-4 mr-2" />
            {isMobile ? 'Fichier' : 'Importer un fichier'}
          </Button>
          <Button
            type="button"
            variant={mode === 'weblink' ? 'default' : 'outline'}
            onClick={() => setMode('weblink')}
            disabled={isUploading}
          >
            <LinkIcon className="w-4 h-4 mr-2" />
            {isMobile ? 'Lien' : 'Lien web'}
          </Button>
        </div>
      )}

      {/* Mobile capture source indicator */}
      {isMobile && initialSource && initialSource !== 'file' && initialSource !== 'weblink' && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[color:var(--accent-soft)] text-[color:var(--accent)] text-sm">
          {initialSource === 'photo' ? <Camera className="w-4 h-4" /> : <ImageIcon className="w-4 h-4" />}
          <span className="font-medium">Source : {initialSource === 'photo' ? 'Appareil photo' : 'Galerie'}</span>
        </div>
      )}

      {/* File zone */}
      {mode === 'file' && (
        <div className="space-y-3">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,video/mp4,video/quicktime,video/x-msvideo,video/webm,video/x-matroska,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/csv"
            className="hidden"
            onChange={handleFileSelect}
          />

          {/* Drop zone — click opens file picker */}
          <div
            onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={e => { e.preventDefault(); setIsDragging(false); addFiles(Array.from(e.dataTransfer.files)); }}
            onClick={openFilePicker}
            className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all select-none
              ${isDragging ? 'border-[color:var(--accent)] bg-[color:var(--accent-soft)]' : 'border-[color:var(--border-subtle)] hover:border-[color:var(--accent)] hover:bg-[color:var(--accent-soft)]/30'}`}
          >
            <Upload className="w-10 h-10 mx-auto mb-3 text-[color:var(--text-muted)]" />
            <p className="text-sm font-medium text-[color:var(--text-primary)]">
              {isMobile ? 'Toucher pour sélectionner un fichier' : 'Glissez vos fichiers ici ou cliquez pour parcourir'}
            </p>
            <p className="text-xs text-[color:var(--text-muted)] mt-1">PDF, images, vidéos, Word, Excel…</p>
          </div>

          {/* Selected files list */}
          {files.length > 0 && (
            <div className="space-y-2">
              {files.map((fileItem, index) => (
                <div key={index} className="flex items-center gap-3 p-2 border border-[color:var(--border-subtle)] rounded-xl bg-[color:var(--bg-card)]">
                  <div className="w-10 h-10 flex-shrink-0 bg-[color:var(--bg-page)] rounded-lg overflow-hidden border border-[color:var(--border-subtle)] flex items-center justify-center">
                    {fileItem.preview
                      ? <img src={fileItem.preview} alt="" className="w-full h-full object-cover" />
                      : fileItem.file.type.startsWith('video/')
                        ? <Video className="w-5 h-5 text-[color:var(--text-muted)]" />
                        : <FileIcon className="w-5 h-5 text-[color:var(--text-muted)]" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate text-[color:var(--text-primary)]">{fileItem.file.name}</p>
                    <p className="text-[10px] text-[color:var(--text-muted)]">
                      {fileItem.file.size >= 1024 * 1024
                        ? `${(fileItem.file.size / 1024 / 1024).toFixed(1)} MB`
                        : `${(fileItem.file.size / 1024).toFixed(1)} KB`}
                    </p>
                  </div>
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-full flex-shrink-0" onClick={() => removeFile(index)}>
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Web link fields */}
      {mode === 'weblink' && (
        <div className="space-y-4 p-4 border border-[color:var(--border-subtle)] rounded-xl bg-[color:var(--bg-card)]">
          <div className="space-y-2">
            <Label htmlFor="webLinkUrl">Adresse du lien (URL) *</Label>
            <Input id="webLinkUrl" type="url" value={webLinkUrl} onChange={e => setWebLinkUrl(e.target.value)} placeholder="https://…" disabled={isUploading} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="webLinkTitle">Nom du document *</Label>
            <Input id="webLinkTitle" value={webLinkTitle} onChange={e => setWebLinkTitle(e.target.value)} placeholder="Ex: Manuel en ligne" disabled={isUploading} />
          </div>
        </div>
      )}

      {/* Informations complémentaires — tiroir */}
      <div className="border border-[color:var(--border-subtle)] rounded-xl overflow-hidden">
        <button
          type="button"
          className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/40 transition-colors text-left"
          onClick={() => setShowExtraFields(v => !v)}
        >
          <span className="text-sm font-medium text-[color:var(--text-primary)]">Informations complémentaires</span>
          <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform duration-200 ${showExtraFields ? 'rotate-180' : ''}`} />
        </button>

        {showExtraFields && (
          <div className="px-4 pb-4 space-y-4 border-t border-[color:var(--border-subtle)]">
            <div className="pt-4 space-y-2">
              <Label htmlFor="doc-title">Titre / Description</Label>
              <Input id="doc-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="Ex: Facture chaudière – Salon" disabled={isUploading} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Type de document</Label>
                <Select value={documentType} onValueChange={setDocumentType} disabled={isUploading || loadingTypes}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {documentTypes.map(type => <SelectItem key={type.code} value={type.code}>{type.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Date du document</Label>
                <DatePicker value={documentDate} onChange={setDocumentDate} disabled={isUploading} />
              </div>
            </div>

            {allowAssetSelection && (
              <div className="space-y-2">
                <Label>Bien associé</Label>
                <Select value={assetId} onValueChange={setAssetId} disabled={isUploading || !!preselectedAssetId || loadingData}>
                  <SelectTrigger><SelectValue placeholder="Aucun bien" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">Aucun bien</SelectItem>
                    {assets.map(asset => <SelectItem key={asset.id} value={asset.id.toString()}>{asset.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}

            {assetId && assetId !== '0' && selectedAssetSupportsStructural && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Pièce associée</Label>
                  <Select value={selectedSubstructureId} onValueChange={setSelectedSubstructureId} disabled={isUploading || loadingRelations}>
                    <SelectTrigger><LayoutGrid className="w-4 h-4 mr-2 text-muted-foreground" /><SelectValue placeholder="Aucune" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Aucune (Bien principal)</SelectItem>
                      {substructures.map(sub => <SelectItem key={sub.id} value={sub.id.toString()}>{sub.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Équipement associé</Label>
                  <Select value={selectedEquipmentId} onValueChange={setSelectedEquipmentId} disabled={isUploading || loadingRelations}>
                    <SelectTrigger><Settings className="w-4 h-4 mr-2 text-muted-foreground" /><SelectValue placeholder="Aucun" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Aucun</SelectItem>
                      {equipments.map(eq => <SelectItem key={eq.id} value={eq.id.toString()}>{eq.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Fournisseur</Label>
                <Input value={supplier} onChange={e => setSupplier(e.target.value)} placeholder="Ex: Renault, EDF, AXA…" disabled={isUploading} />
              </div>
              <div className="space-y-2">
                <Label>Montant (€)</Label>
                <NumberInput step={0.01} value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" disabled={isUploading} showButtons={false} />
              </div>
            </div>
          </div>
        )}
      </div>

    </div>
  );

  const footerContent = (() => {
    const noFileYet = mode === 'file' && files.length === 0;
    return (
      <div className="space-y-3">
        <div className="flex items-stretch rounded-xl border border-border bg-muted/30 overflow-hidden">
          <button
            type="button"
            className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-muted/60 transition-colors text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => handleSubmit()}
            disabled={!canSubmit || isUploading}
          >
            {isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            <span className="text-[10px] font-semibold uppercase tracking-wider">
              {isUploading
                ? (uploadProgress && uploadProgress.total > 1 ? `Envoi ${uploadProgress.current}/${uploadProgress.total}…` : 'Envoi…')
                : mode === 'weblink' ? 'Ajouter'
                : noFileYet ? 'Importer'
                : files.length > 1 ? `Importer (${files.length} fichiers)` : 'Importer'}
            </span>
          </button>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={handleClose} className="w-full text-muted-foreground">
          {isUploading ? 'Annuler l\'envoi' : 'Annuler'}
        </Button>
      </div>
    );
  })();

  return (
    <>
      <Sheet open={open} onOpenChange={handleClose}>
        <SheetContent
          className="p-0 flex flex-col"
          style={{ maxWidth: isMobile ? undefined : 580, width: isMobile ? undefined : '580px', height: isMobile ? '95dvh' : '100dvh' }}
          side={isMobile ? 'bottom' : 'right'}
        >
          <>
            {/* Header — fixed */}
            <div className="flex-shrink-0 px-6 pt-6 pb-4 border-b border-[color:var(--border-subtle)]">
              <SheetHeader>
                <SheetTitle>Ajouter un document</SheetTitle>
                <SheetDescription>
                  {isMobile ? 'Renseignez les informations du document' : 'Importez vos documents ou ajoutez des liens web'}
                </SheetDescription>
              </SheetHeader>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {formContent}
            </div>

            {/* Footer — fixed */}
            <div className="flex-shrink-0 px-6 py-4 border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-page)]">
              {footerContent}
            </div>
          </>
        </SheetContent>
      </Sheet>

      <CreateAgendaItemDrawer
        open={agendaDrawerOpen}
        onClose={() => setAgendaDrawerOpen(false)}
        onMutated={() => setAgendaDrawerOpen(false)}
        prefilledTitle={agendaPrefill.title || undefined}
        prefilledStartDate={agendaPrefill.startDate || undefined}
      />

      {/* Fusion suggestion modal — affichée après détection de doublon */}
      {fusionModalOpen && fusionCandidate && fusionNewFileId && (
        <FusionSuggestionModal
          open={fusionModalOpen}
          onOpenChange={setFusionModalOpen}
          newFileId={fusionNewFileId}
          newFilename={fusionNewFilename}
          candidate={fusionCandidate}
          onAction={(action) => {
            if (action === 'merge' || action === 'replace') {
              window.dispatchEvent(new CustomEvent('document-added'));
              onSuccess?.();
            }
          }}
        />
      )}
    </>
  );
}
