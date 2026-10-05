"use client";

import { useState, useRef, useEffect, useMemo } from 'react';
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
import { normalizeMimeType } from '@/lib/file-validation';
import {
  ACCEPT_DEPOT, MAX_DOCUMENTS_PAR_DEPOT, TAILLE_MAX_LOT, enMo, trierFichiersPourDepot,
} from '@/lib/upload-limits';
import { fileDepot, estActif, type BilanLot, type MetaConfirmation } from '@/lib/upload-queue';
import { useFileDepot } from '@/hooks/useFileDepot';
import { UploadQueuePanel } from './UploadQueueIndicator';
import { FusionSuggestionModal } from './FusionSuggestionModal';
import type { FusionCandidate } from '@/services/document-ai/fusion-detector';
import { parseWriteBlocked, notifyWriteBlocked, WriteBlockedError, isWriteBlockedError } from '@/lib/write-blocked';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import { messageSelonStatut } from '@/lib/upload-http';

/**
 * Traduit une réponse d'erreur en exception lisible.
 *
 * Un refus de droits ouvre la fenêtre de fin d'essai et lève une
 * `WriteBlockedError`, que le `catch` englobant reconnaît pour ne pas ajouter
 * « Erreur lors de l'ajout du document » par-dessus — c'est ce message
 * générique qui s'affichait sur un compte dont l'essai était terminé.
 */
async function reponseEnErreur(res: Response, repli: string): Promise<Error> {
  const body = await res.json().catch(() => ({}));
  const refus = parseWriteBlocked(body);
  if (refus) {
    notifyWriteBlocked(refus);
    return new WriteBlockedError(refus);
  }
  return new Error((body as { message?: string })?.message || messageSelonStatut(res.status, repli));
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

/**
 * Limites de dépôt : contrat unique `@/lib/upload-limits`, partagé avec
 * `api/files/presign` et `api/files/confirm` (APP-PERF-28). Le serveur fait
 * autorité ; les appliquer ici évite un transfert voué au refus.
 */

/** Contexte d'un dépôt figé à l'envoi : la fin du lot peut survenir panneau fermé. */
interface ContexteDepot {
  isWl: boolean;
  isPremium: boolean;
  selectedEventIds: number[];
  createEvent: boolean;
  assetId: string;
  eventType: string;
  eventTitle: string;
  substructureId: number | null;
  equipmentId: number | null;
  documentType: string;
  documentDate: string;
  supplier: string;
  title: string;
  amountCents: number | null;
  targetAssetId: number | null;
  webLinkTitle: string;
  webLinkUrl: string;
  premierFichier: { name: string; size: number; mimeType: string } | null;
  /** Événement créé au premier bilan : les reprises tardives s'y rattachent. */
  evenementCreeId?: number | null;
}

/** Associations et création d'événement, puis signaux de rafraîchissement. */
async function associerEtSignaler(ctx: ContexteDepot, fileIds: number[]): Promise<void> {
  if (fileIds.length === 0) return;
  for (const eventId of ctx.selectedEventIds) {
    await fetch(`/api/events/${eventId}/documents`, {
      credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds }),
    }).catch(() => {});
  }
  if (ctx.createEvent && ctx.assetId && ctx.assetId !== '0') {
    if (ctx.evenementCreeId === undefined) {
      ctx.evenementCreeId = null;
      const userStr = localStorage.getItem('user');
      if (userStr) {
        const user = JSON.parse(userStr);
        const eventResponse = await fetch('/api/events', {
          credentials: 'include',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: user.id, assetId: parseInt(ctx.assetId),
            substructureId: ctx.substructureId,
            equipmentId: ctx.equipmentId,
            categorie: ctx.eventType, title: ctx.eventTitle,
            date: ctx.documentDate,
            provider: ctx.supplier || null,
            costCents: ctx.amountCents,
            notes: ctx.title || (ctx.isWl ? ctx.webLinkTitle : ctx.premierFichier?.name),
          }),
        }).catch(() => null);
        if (eventResponse?.ok) {
          const { event } = await eventResponse.json();
          ctx.evenementCreeId = event.id;
        }
      }
    }
    if (ctx.evenementCreeId) {
      await fetch(`/api/events/${ctx.evenementCreeId}/documents`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds }),
      }).catch(() => {});
    }
  }

  if (ctx.isPremium) {
    // Le pipeline tourne côté serveur (mis en file par /api/files/confirm,
    // un travail par document) : il ne dépend plus du client ouvert.
    window.dispatchEvent(new CustomEvent('document-added'));
    // Un signal par document : chacun a sa propre analyse, et la bannière
    // affiche « N analyses en cours ».
    for (const fileId of fileIds) {
      window.dispatchEvent(new CustomEvent('document-analysis-start', { detail: { fileId } }));
    }
    window.dispatchEvent(new CustomEvent('refresh-a-traiter'));
  } else {
    // Standard — pas d'analyse IA
    const f = ctx.premierFichier;
    window.dispatchEvent(new CustomEvent('document-added', { detail: { file: {
      id: fileIds[0],
      fileName: ctx.isWl ? ctx.webLinkTitle : (f?.name ?? ctx.title ?? 'Document'),
      retainedTitle: ctx.isWl ? ctx.webLinkTitle : (ctx.title || f?.name || null),
      mimeType: ctx.isWl ? 'application/x-web-link' : (f?.mimeType ?? 'application/octet-stream'),
      fileSize: ctx.isWl ? null : (f?.size ?? null),
      documentType: ctx.documentType || null,
      documentDate: ctx.documentDate || null,
      supplier: ctx.supplier || null,
      amountCents: ctx.amountCents || null,
      assetId: ctx.targetAssetId,
      webLinkUrl: ctx.isWl ? ctx.webLinkUrl : null,
      createdAt: new Date().toISOString(),
      analysisState: null,
    }}}));
  }
}

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
  // ── Dépôt confié à la file globale (APP-PERF-29) ────────────────────────
  // Le panneau ne porte plus l'envoi : il suit le lot qu'il a lancé. Fermer
  // le panneau ne l'annule pas ; « Annuler l'envoi » l'annule explicitement.
  const lotRef = useRef<string | null>(null);
  const [lotId, setLotIdState] = useState<string | null>(null);
  const setLotId = (id: string | null) => { lotRef.current = id; setLotIdState(id); };
  const monteRef = useRef(true);
  useEffect(() => { monteRef.current = true; return () => { monteRef.current = false; }; }, []);
  const depot = useFileDepot();
  const elementsLot = useMemo(
    () => (lotId ? depot.elements.filter((e) => e.lotId === lotId) : []),
    [depot, lotId],
  );
  const lotActif = elementsLot.some(estActif);

  // ── Mode ────────────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<'file' | 'weblink'>('file');
  const [isDragging, setIsDragging] = useState(false);
  /** Création d'un lien web en cours (les fichiers passent par la file). */
  const [isSubmittingLink, setIsSubmittingLink] = useState(false);
  const isUploading = isSubmittingLink || lotActif;
  const uploadProgress = elementsLot.length > 0
    ? { current: elementsLot.filter((e) => !estActif(e)).length, total: elementsLot.length }
    : null;

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

  // ══════════════════════════════════════════════════════════════════════
  // GARDE À L'OUVERTURE
  //
  // Six écrans ouvrent ce dialogue (accueil, « + », documents d'un bien,
  // rubriques, événements liés, menu mobile). Plusieurs ne gardaient pas le
  // clic : un compte dont l'essai était terminé choisissait son fichier,
  // l'envoyait, et recevait « Erreur lors de l'ajout du document ».
  // ══════════════════════════════════════════════════════════════════════
  const { garder, estBloque } = useWriteGuard();
  const bloque = open && estBloque('documents');
  useEffect(() => {
    if (!open) return;
    let autorise = false;
    garder(() => { autorise = true; }, 'documents');
    if (!autorise) onOpenChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;

    // Fichiers initiaux (menu mobile, appareil photo) : même contrôle que
    // le sélecteur et le glisser-déposer (APP-PERF-28) — ils contournaient
    // `addFiles` et n'étaient refusés qu'au serveur, après transfert.
    if (initialFiles && initialFiles.length > 0) {
      addFiles(initialFiles, []);
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


  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').trim();

  const addFiles = (newFiles: File[], existants: FileWithPreview[] = files) => {
    // ══════════════════════════════════════════════════════════════════════
    // REFUSER AVANT L'ENVOI, PAS APRÈS — contrat `@/lib/upload-limits`
    //
    // Le serveur applique les mêmes limites — il fait seul autorité. Les
    // annoncer ici évite d'attendre un transfert pour apprendre qu'il est
    // refusé. Fichier vide, type non pris en charge, taille (document ou
    // vidéo), nombre et taille cumulée : tous bloquants, tous annoncés.
    // ══════════════════════════════════════════════════════════════════════
    const decrire = (f: File) => ({ name: f.name, size: f.size, mimeType: normalizeMimeType(f) });
    const tri = trierFichiersPourDepot(existants.map((x) => decrire(x.file)), newFiles, decrire);

    // Regroupés par motif : un message par cause, avec les fichiers concernés.
    const parMotif = new Map<string, string[]>();
    for (const { fichier, refus } of tri.refuses) {
      parMotif.set(refus.message, [...(parMotif.get(refus.message) ?? []), fichier.name]);
    }
    for (const [motif, noms] of parMotif) {
      toast.error(`${motif} ${noms.length === 1 ? 'Fichier écarté' : 'Fichiers écartés'} : ${noms.join(', ')}.`);
    }
    if (tri.horsNombre.length > 0) {
      const ecartes = tri.horsNombre.length;
      toast.error(
        `Vous pouvez déposer ${MAX_DOCUMENTS_PAR_DEPOT} documents à la fois. ` +
        `${ecartes} ${ecartes === 1 ? 'a été écarté' : 'ont été écartés'}.`,
      );
    }
    if (tri.horsLot.length > 0) {
      toast.error(
        `Un dépôt ne peut pas dépasser ${enMo(TAILLE_MAX_LOT)}. ` +
        `${tri.horsLot.length === 1 ? 'Ce fichier a été écarté' : 'Ces fichiers ont été écartés'} : ${tri.horsLot.map((f) => f.name).join(', ')}.`,
      );
    }
    if (tri.retenus.length === 0) return;

    const ajouts = tri.retenus.map(file => ({
      file,
      preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
    }));
    setFiles(prev => (existants === files ? [...prev, ...ajouts] : [...existants, ...ajouts]));
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
    setLotId(null);
  };

  // ══════════════════════════════════════════════════════════════════════
  // FERMER N'EST PLUS ANNULER (APP-PERF-29)
  //
  // `handleClose` annulait l'envoi et vidait le formulaire. L'envoi est
  // désormais porté par la file globale : fermer masque le panneau, le
  // transfert continue et reste visible (`UploadQueueIndicator`). Annuler
  // est l'action explicite « Annuler l'envoi ».
  // ══════════════════════════════════════════════════════════════════════
  const handleClose = () => {
    if (lotActif) {
      toast.info("L'envoi continue. Suivez-le dans le panneau « Envoi de documents ».");
    }
    resetForm();
    onOpenChange(false);
  };

  const annulerEnvoi = () => {
    if (lotRef.current) fileDepot.annulerLot(lotRef.current);
  };

  /** Contexte figé du dépôt : la fin du lot peut survenir panneau fermé. */
  const contexteDepot = (): ContexteDepot => {
    const targetAssetId = assetId && assetId !== '0' ? parseInt(assetId) : null;
    const categoryLabel = EVENT_CATEGORIES.find(c => c.value === eventType)?.label;
    const premier = files[0]?.file;
    return {
      isWl: mode === 'weblink',
      isPremium: !!isPremium,
      selectedEventIds: [...selectedEventIds],
      createEvent,
      assetId,
      eventType,
      eventTitle: categoryLabel || documentTypes.find(dt => dt.code === documentType)?.label || 'Document ajouté',
      substructureId: selectedSubstructureId === 'none' ? null : parseInt(selectedSubstructureId),
      equipmentId: selectedEquipmentId === 'none' ? null : parseInt(selectedEquipmentId),
      documentType,
      documentDate,
      supplier,
      title,
      amountCents: amount ? Math.round(parseFloat(amount) * 100) : null,
      targetAssetId,
      webLinkTitle,
      webLinkUrl,
      premierFichier: premier ? { name: premier.name, size: premier.size, mimeType: normalizeMimeType(premier) } : null,
    };
  };

  /** Ce panneau suit-il encore ce lot ? (il a pu être fermé ou réutilisé) */
  const suitLeLot = (id: string) => monteRef.current && lotRef.current === id;

  /**
   * Fin d'un lot : associations, signaux, messages. Exécutée même panneau
   * fermé ou démonté (la file appelle cette fermeture) ; le formulaire n'est
   * réinitialisé et fermé que si le panneau suit encore ce lot.
   */
  const surFinLot = (ctx: ContexteDepot) => async (bilan: BilanLot) => {
    if (bilan.ecritureBloquee) {
      // La fenêtre de fin d'essai est ouverte : on ferme le dépôt pour la
      // laisser lisible, sans message d'erreur par-dessus.
      if (suitLeLot(bilan.lotId)) { resetForm(); onOpenChange(false); }
      return;
    }
    if (bilan.fileIds.length > 0) {
      await associerEtSignaler(ctx, bilan.fileIds);
      onFilesUploaded?.(bilan.fileIds);
      const n = bilan.fileIds.length;
      toast.success(n > 1 ? `${n} documents ajoutés` : '1 document ajouté');
    }
    if (bilan.tardif) return;
    if (bilan.echecs.length > 0) {
      toast.error(
        bilan.fileIds.length === 0 && bilan.echecs.length === 1
          ? bilan.echecs[0].erreur
          : `${bilan.echecs.length} document${bilan.echecs.length > 1 ? 's' : ''} non ajouté${bilan.echecs.length > 1 ? 's' : ''} : ` +
            `${bilan.echecs.map((e) => e.erreur).join(' · ')}. Vous pouvez les reprendre depuis le panneau d'envoi.`,
        { duration: 10000 },
      );
      return; // Le panneau reste ouvert sur l'état du lot (reprise possible).
    }
    if (bilan.fileIds.length > 0 && suitLeLot(bilan.lotId)) {
      onSuccess?.();
      resetForm();
      onOpenChange(false);
    }
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

    const ctx = contexteDepot();

    if (mode === 'file') {
      // ════════════════════════════════════════════════════════════════════
      // UN DÉPÔT DE N FICHIERS = N DÉPÔTS D'UN FICHIER (file globale)
      //
      // Chaque fichier suit le parcours complet d'un dépôt unitaire —
      // empreinte, presign, PUT, SA confirmation — avec une concurrence
      // bornée (`upload-queue.ts`). Jamais de confirmation groupée : elle
      // avait fusionné des documents distincts.
      // ════════════════════════════════════════════════════════════════════
      const meta: MetaConfirmation = {
        assetId: ctx.targetAssetId,
        substructureId: ctx.substructureId,
        equipmentId: ctx.equipmentId,
        documentType,
        documentDate: documentDate || null,
        description: title || null,
        supplier: supplier || null,
        amountCents: ctx.amountCents,
      };
      const aEnvoyer = files.map((f) => f.file);
      // Le formulaire est vidé : les fichiers appartiennent désormais à la
      // file. Un second clic ne peut pas renvoyer un fichier déjà parti.
      files.forEach(f => { if (f.preview) URL.revokeObjectURL(f.preview); });
      setFiles([]);
      const id = fileDepot.ajouterLot(aEnvoyer, meta, { surFin: surFinLot(ctx) });
      setLotId(id);
      return;
    }

    // ── Création du lien web ──────────────────────────────────────────────
    setIsSubmittingLink(true);
    try {
      const wlRes = await fetch('/api/web-links', {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json'},
        body: JSON.stringify({
          url: webLinkUrl,
          title: webLinkTitle,
          documentType,
          assetId: ctx.targetAssetId,
          documentDate: documentDate || null,
          description: title || null,
          supplier: supplier || null,
          amountCents: ctx.amountCents || null,
        }),
      });
      if (!wlRes.ok) {
        throw await reponseEnErreur(wlRes, `Erreur ${wlRes.status}`);
      }
      const { webLink } = await wlRes.json();
      const ids = [webLink.id as number];
      await associerEtSignaler(ctx, ids);
      onFilesUploaded?.(ids);
      toast.success('Lien web ajouté');
      onSuccess?.();
      resetForm();
      onOpenChange(false);
    } catch (error) {
      if (isWriteBlockedError(error)) {
        resetForm();
        onOpenChange(false);
      } else {
        console.error('Web link error:', error);
        toast.error((error as Error)?.message || 'Erreur lors de l\'ajout du document');
      }
    } finally {
      setIsSubmittingLink(false);
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

      {/* Progression du dépôt lancé depuis ce panneau (file globale) */}
      {(isUploading || elementsLot.length > 0) && (
        <div className="flex flex-col gap-2 px-3 py-2.5 rounded-xl bg-white/5 border border-white/10">
          <div className="flex items-center gap-2 text-sm">
            {isUploading
              ? <Loader2 className="w-4 h-4 text-white/60 animate-spin flex-shrink-0" />
              : <Check className="w-4 h-4 text-white/60 flex-shrink-0" />}
            <span className="text-white/80 font-medium">
              {isSubmittingLink
                ? 'Envoi en cours…'
                : uploadProgress && uploadProgress.total > 1
                  ? `${isUploading ? 'Envoi' : 'Terminé'} ${uploadProgress.current}/${uploadProgress.total}${isUploading ? '…' : ''}`
                  : isUploading ? 'Envoi en cours…' : 'Envoi terminé'}
            </span>
          </div>
          {elementsLot.length > 0 && (
            <UploadQueuePanel
              elements={elementsLot}
              mobile={isMobile}
              onAnnuler={(id) => fileDepot.annuler(id)}
              onReprendre={(id) => { try { fileDepot.reprendre(id); } catch (err) { toast.error((err as Error).message); } }}
            />
          )}
          {isUploading && !isSubmittingLink && (
            <p className="text-[11px] text-white/50">Vous pouvez fermer ce panneau : l’envoi continue et reste visible en bas de l’écran.</p>
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
            accept={ACCEPT_DEPOT}
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
        {lotActif ? (
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={handleClose} className="text-muted-foreground">
              Fermer (l'envoi continue)
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={annulerEnvoi} className="text-muted-foreground">
              Annuler l'envoi
            </Button>
          </div>
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={handleClose} className="w-full text-muted-foreground">
            {elementsLot.length > 0 ? 'Fermer' : 'Annuler'}
          </Button>
        )}
      </div>
    );
  })();

  return (
    <>
      <Sheet open={open && !bloque} onOpenChange={handleClose}>
        <SheetContent
          className="p-0 flex flex-col"
          // À droite sur tous les écrans (sur mobile : pleine largeur). Le
          // panneau montait par le bas sur mobile ; règle : jamais par le bas.
          style={{ maxWidth: isMobile ? '100vw' : 580, width: isMobile ? '100vw' : '580px', height: '100dvh' }}
          side="right"
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
