"use client"

import { useState, useCallback, useEffect, useRef } from 'react';
import { effectiveStatusLabel } from '@/lib/agenda/effective-status';
import Image from 'next/image';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { DatePicker } from '@/components/ui/date-picker';
import { NumberInput } from '@/components/ui/number-input';
import { formatNumberForInput, MONEY_INPUT, parseMoneyInputToCents } from '@/lib/number-input';
import { Separator } from '@/components/ui/separator';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  FileText, Download, Trash2, ExternalLink, Loader2,
  Calendar, Euro, User, FileQuestion, Pencil, Building2, LayoutGrid, Wrench, Wand2, Check, CalendarPlus, X,
  Sparkles, AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Lock, RefreshCw, ChevronLeft, ChevronRight, Unlink,
} from 'lucide-react';
import dynamic from 'next/dynamic';

const CreateAgendaItemDrawer = dynamic(
  () => import('@/components/agenda/CreateAgendaItemDrawer').then(m => ({ default: m.CreateAgendaItemDrawer })),
  { ssr: false }
);
const AgendaItemDrawer = dynamic(
  () => import('@/components/agenda/AgendaItemDrawer').then(m => ({ default: m.AgendaItemDrawer })),
  { ssr: false }
);
import { ROOM_ASSOCIATIONS_CHANGED } from '@/lib/rooms/room-associations';
import { toast } from 'sonner';
import { analyzeErrorFeedback, type AnalyzeFeedback } from './document-analysis-feedback';
import { apiClient } from '@/lib/api-client';
import { useAnalysisBanner } from '@/contexts/AnalysisBannerContext';
import { SupplierDrawer } from '@/components/suppliers/SupplierDrawer';
import { documentTypeDisplayLabel } from '@/lib/referential/v2';
import { displayDocumentTitle } from '@/lib/documents/document-title-rules';
import { openDrawer, restoreFocusOnClose } from '@/lib/drawers';
import { EntityCard, EntityCardList } from '@/components/drawers/EntityCard';
import type { AgendaItemFull } from '@/services/agenda/AgendaQueryService';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import { parseWriteBlocked, notifyWriteBlocked } from '@/lib/write-blocked';
// Lot 84B (CDC v5 O-3, §8.1, §14.4) : événement de référence + liens précis ; lien manuel vers un élément d'agenda.
import { GroupingPicker } from '@/components/agenda/AgendaGroupingPanel';
import { GROUPING_LABELS } from '@/lib/agenda/grouping-view';
import {
  displayAnalysisState, isProcessingStatus, userMessageText, ANALYSIS_FAILED_FINAL_MESSAGE, type ProcessingStatus,
} from '@/lib/ai/processing-status';
import {
  RubricTypeFields,
  effectiveRubric,
  rubricTypeLabels,
  type RubricTypeValue,
} from '@/components/documents/v2/RubricTypeFields';

export interface DocumentDrawerItem {
  id: number;
  originalFilename: string;
  mimeType: string;
  /** Code V1 historique (colonne `document_type`) : jamais affiché (lot 86E). */
  documentType: string;
  /**
   * Lot 86E : Type V2 enregistré, s'il est connu de l'écran appelant — l'en-tête
   * l'affiche avant le chargement complet du document. Absent : pas de pastille
   * tant que le document n'est pas chargé (jamais « Autre » par défaut).
   */
  documentTypeCode?: string | null;
  documentDate?: string | null;
  uploadedAt?: string | null;
  size?: number;
  assetId: number;
}

interface FullFileData {
  id: number;
  /** Identifiant public, attendu par l'API de classement V2. */
  publicId: string | null;
  /** Classement V2 (Rubrique / Type), CDC V2.0 §5.1. */
  rubricCode: string | null;
  documentTypeCode: string | null;
  originalFilename: string;
  mimeType: string;
  /** Code V1 historique, tel qu'enregistré (jamais réécrit ni affiché par le tiroir, lot 86E). */
  documentType: string | null;
  retainedTitle: string | null;
  retainedFunctionCode: string | null;
  documentDate: string | null;
  uploadedAt: string | null;
  lastAnalysisAt: string | null;
  size: number | null;
  supplier: string | null;
  amountCents: number | null;
  description: string | null;
  notes: string | null;
  substructureId: number | null;
  equipmentId: number | null;
  assetId: number | null;
  analysisState: string | null;
  /**
   * Lot 34C : statut FONCTIONNEL calculé par le serveur (état réel du
   * traitement) et code du référentiel fermé — jamais de motif technique.
   */
  processingStatus: ProcessingStatus | null;
  userMessageCode: string | null;
  processingResumeAt: string | null;
  userEditedFields: Record<string, boolean> | null;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  document: DocumentDrawerItem | null;
  onRefresh: () => void;
  autoAnalyze?: boolean;
  showAnalysisResults?: boolean;
  isPremium?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  /** Lot 76E — élément qui reprend le focus à la fermeture (vignette « À traiter »). */
  returnFocusTo?: HTMLElement | null;
}

const fmt = (d: string | null | undefined) => {
  if (!d) return null;
  try { return new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); }
  catch { return d; }
};

const fmtSize = (b?: number | null) => {
  if (!b) return null;
  if (b < 1024) return `${b} o`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} Ko`;
  return `${(b / 1048576).toFixed(1)} Mo`;
};

const fmtAmount = (cents: number | null) => {
  if (!cents) return null;
  return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
};

function PdfPreview({ fileId, viewUrl, filename }: { fileId: number; viewUrl: string | null; filename: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Lot 75L : le cadre affiche l'URL de même origine `/proxy` (en-tête
    // `inline` portant le nom affiché) et non un `blob:` — « Enregistrer »
    // depuis la visionneuse PDF reprenait sinon un nom aléatoire. La sonde
    // (1 octet) garde l'état « Aperçu indisponible » en cas d'erreur.
    const src = `/api/files/${fileId}/proxy`;
    fetch(src, { credentials: 'include', headers: { Range: 'bytes=0-0' } })
      .then(res => {
        if (!res.ok) return res.json().catch(() => null).then(j => Promise.reject(j?.error ?? res.status));
        if (!cancelled) { setBlobUrl(src); setLoading(false); }
      })
      .catch(err => {
        if (!cancelled) { setError(String(err)); setLoading(false); }
      });

    return () => { cancelled = true; };
  }, [fileId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-72 bg-muted/10 rounded-lg border">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border overflow-hidden">
        <div className="flex flex-col items-center justify-center h-48 gap-3 bg-muted/10">
          <FileText className="w-8 h-8 text-muted-foreground/40" />
          <p className="text-xs text-muted-foreground">Aperçu indisponible</p>
          {viewUrl && (
            <a href={viewUrl} target="_blank" rel="noopener noreferrer"
              className="text-xs text-primary flex items-center gap-1 hover:underline">
              <ExternalLink className="w-3 h-3" /> Ouvrir le document
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border overflow-hidden">
      <div className="w-full h-72 bg-muted/10">
        {blobUrl ? (
          <iframe
            src={blobUrl}
            className="w-full h-full border-0"
            title={filename}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <FileText className="w-8 h-8 text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground">Aperçu indisponible</p>
          </div>
        )}
      </div>
      <div className="flex items-center justify-center gap-1.5 py-2 bg-muted/20 border-t">
        <a
          href={viewUrl ?? '#'}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground hover:text-primary transition-colors flex items-center gap-1"
        >
          <ExternalLink className="w-3 h-3" />
          Ouvrir dans un nouvel onglet
        </a>
      </div>
    </div>
  );
}

function DocPreview({ fileId, mimeType, viewUrl, filename }: { fileId: number; mimeType: string; viewUrl: string | null; filename: string }) {

  if (!viewUrl) {
    return (
      <div className="flex flex-col items-center justify-center h-48 bg-muted/40 rounded-lg border">
        <FileQuestion className="w-10 h-10 text-muted-foreground/40 mb-2" />
        <p className="text-sm text-muted-foreground">Aperçu non disponible</p>
      </div>
    );
  }
  if (mimeType.startsWith('image/')) {
    return (
      <div className="relative w-full h-52 rounded-lg overflow-hidden border bg-muted/20">
        <Image src={viewUrl} alt={filename} fill className="object-contain" unoptimized />
      </div>
    );
  }
  if (mimeType === 'application/pdf') {
    return <PdfPreview fileId={fileId} viewUrl={viewUrl} filename={filename} />;
  }
  if (mimeType.startsWith('video/')) {
    return (
      <div className="relative w-full rounded-lg overflow-hidden bg-black border">
        <video
          src={viewUrl}
          controls
          className="w-full max-h-72 object-contain"
          preload="metadata"
        >
          Votre navigateur ne supporte pas la lecture vidéo.
        </video>
      </div>
    );
  }
  // Other non-image files: show a card with open button
  const ext = filename.split('.').pop()?.toUpperCase() ?? '';
  return (
    <a
      href={viewUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex flex-col items-center justify-center gap-3 h-40 rounded-lg border bg-muted/20 hover:bg-muted/40 transition-colors group"
    >
      <div className="w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
        <FileText className="w-7 h-7 text-primary" />
      </div>
      <div className="text-center">
        <p className="text-sm font-medium text-foreground truncate max-w-[200px]">{filename}</p>
        {ext && <p className="text-xs text-muted-foreground mt-0.5">{ext}</p>}
      </div>
      <span className="text-xs text-muted-foreground flex items-center gap-1 group-hover:text-primary transition-colors">
        <ExternalLink className="w-3 h-3" />
        Cliquer pour ouvrir
      </span>
    </a>
  );
}

export function DocumentDrawer({ open, onOpenChange, document: doc, onRefresh, autoAnalyze, showAnalysisResults, isPremium = true, onPrev, onNext, hasPrev, hasNext, returnFocusTo }: Props) {
  const { analysisStartTimes, analyzingFileIds } = useAnalysisBanner();
  const [fullData, setFullData] = useState<FullFileData | null>(null);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Edit mode
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editFilename, setEditFilename] = useState('');
  // Rubrique / Type V2 — auparavant dans un tiroir séparé ouvert par le bas.
  const [editClassement, setEditClassement] = useState<RubricTypeValue>({ rubricCode: null, documentTypeCode: null });
  const [editDocDate, setEditDocDate] = useState('');
  const [editSupplier, setEditSupplier] = useState('');
  const [editAmount, setEditAmount] = useState('');
  const [editAmountError, setEditAmountError] = useState(false);
  const [editDescription, setEditDescription] = useState('');
  const [editNotes, setEditNotes] = useState('');
  // Rattachement
  const [editAssetId, setEditAssetId] = useState<number | null>(null);
  const [editSubstructureId, setEditSubstructureId] = useState<number | null>(null);
  const [editEquipmentId, setEditEquipmentId] = useState<number | null>(null);
  const [assetsList, setAssetsList] = useState<{ id: number; name: string; category: string }[]>([]);
  const [substructuresList, setSubstructuresList] = useState<{ id: number; name: string }[]>([]);
  const [equipmentsList, setEquipmentsList] = useState<{ id: number; name: string }[]>([]);
  const [supplierDrawerOpen, setSupplierDrawerOpen] = useState(false);
  const [supplierDrawerId, setSupplierDrawerId] = useState<number | null>(null);

  // AI analysis — analysisState from DB (live via SSE)
  const [analysisState, setAnalysisState] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [liveProposals, setLiveProposals] = useState<any[]>([]);
  const [showDetectedInfo, setShowDetectedInfo] = useState(false);

  const sseAbortRef = useRef<AbortController | null>(null);
  // Timestamp auquel l'état ANALYZING a été observé pour la première fois dans ce drawer
  const analyzingStartRef = useRef<number | null>(null);
  const [analyzingTooLong, setAnalyzingTooLong] = useState(false);
  // Étape courante reçue via SSE + compteur temps écoulé
  const [sseStage, setSseStage] = useState<string | null>(null);
  const [analyzingElapsed, setAnalyzingElapsed] = useState(0);

  // Legacy analyze UI state (kept for compatibility)
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState('');
  const [analyzeSuccess, setAnalyzeSuccess] = useState(false);
  const [analyzeElapsed, setAnalyzeElapsed] = useState(0);
  const [analyzeStage, setAnalyzeStage] = useState(0);
  const [retryCount, setRetryCount] = useState(0);
  // Toast ID for background analysis progress (when drawer is closed during analysis)
  const bgToastIdRef = useRef<string | number | null>(null);
  const isDrawerOpenRef = useRef(open);
  useEffect(() => { isDrawerOpenRef.current = open; }, [open]);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => { onOpenChangeRef.current = onOpenChange; }, [onOpenChange]);

  // Agenda suggestions (from AI analysis) and creation drawer
  interface AgendaSuggestion { label: string; dateValue: string | null; dateType: string; rawText: string; proposalId?: number; }
  const [agendaSuggestions, setAgendaSuggestions] = useState<AgendaSuggestion[]>([]);
  const [agendaDrawerOpen, setAgendaDrawerOpen] = useState(false);
  const [agendaPrefill, setAgendaPrefill] = useState<{ title: string; startDate: string }>({ title: '', startDate: '' });
  const [pendingAgendaProposalId, setPendingAgendaProposalId] = useState<number | null>(null);

  // Linked agenda items (already created)
  interface LinkedAgendaItem { id: number; title: string; startDate: string | null; effectiveStatus: string; }
  const [linkedAgendaItems, setLinkedAgendaItems] = useState<LinkedAgendaItem[]>([]);

  // Propositions de l'analyse (lecture seule : suggestions d'agenda). Lot 71B :
  // plus de validation sur la fiche — les données fiables sont déjà écrites par
  // les moteurs, les autres sont des cartes « À traiter ».
  interface AiFieldProposal { id: number; targetKey: string; proposedValueJson: string; status: string; proposalType: string; }

  // Lot 84B (§14.4) : nature des liens du document avec l'agenda (lien précis, ou par
  // l'ensemble vers son événement de référence) — relue à chaque relecture de la liste.
  const [agendaLinkInfo, setAgendaLinkInfo] = useState<Map<number, { direct: boolean; viaGroup: boolean; isMain: boolean }>>(new Map());
  const [agendaPickerOpen, setAgendaPickerOpen] = useState(false);
  useEffect(() => {
    if (!open || !doc) return;
    let annule = false;
    apiClient.get<{ links: Array<{ itemId: number; direct: boolean; viaGroup: boolean; isMain: boolean }> }>(`/api/documents/${doc.id}/agenda-liens`)
      .then((r) => { if (!annule) setAgendaLinkInfo(new Map((r?.links ?? []).map((l) => [l.itemId, l]))); })
      .catch(() => { if (!annule) setAgendaLinkInfo(new Map()); });
    return () => { annule = true; };
  }, [open, doc?.id, linkedAgendaItems]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadAgendaCandidates = useCallback(async (q: string) => {
    if (!doc) return [];
    const r = await apiClient.get<{ candidates: Array<{ id: number; title: string; meta: string | null }> }>(`/api/documents/${doc.id}/agenda-liens?candidats=1&q=${encodeURIComponent(q)}`);
    return r?.candidates ?? [];
  }, [doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Lot 86D : liste des éléments liés relue après un geste, ici ou dans un autre tiroir
  // (`agenda-mutated` : tiroir d'un élément d'agenda ouvert en même temps) — synchronisation immédiate.
  const rechargerElementsAgenda = useCallback(async () => {
    if (!doc) return;
    try {
      const r = await fetch(`/api/agenda?fileId=${doc.id}&period=all&includeCancelled=false`, { credentials: 'include' });
      const data = r.ok ? await r.json() : null;
      if (data?.items) setLinkedAgendaItems(data.items.map((i: any) => ({ id: i.id, title: i.title, startDate: i.startDate ?? null, effectiveStatus: i.effectiveStatus })));
    } catch { /* liste inchangée */ }
  }, [doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open || !doc) return;
    const h = () => { void rechargerElementsAgenda(); };
    window.addEventListener('agenda-mutated', h);
    return () => window.removeEventListener('agenda-mutated', h);
  }, [open, doc?.id, rechargerElementsAgenda]); // eslint-disable-line react-hooks/exhaustive-deps
  const relierAgenda = async (itemId: number) => {
    if (!doc) return;
    try {
      await apiClient.post(`/api/documents/${doc.id}/agenda-liens`, { itemId });
      toast.success('Document relié');
      window.dispatchEvent(new CustomEvent('agenda-mutated'));
      await rechargerElementsAgenda();
    } catch (err: any) {
      if (err?.status !== 403) toast.error(err?.serverMessage || err?.message || 'Le lien n’a pas pu être créé');
    }
  };
  // Lot 86D (ticket « Documents / Agenda » §2) : détacher ce document d'UN élément d'agenda —
  // le document, l'élément et leurs autres liens restent ; décision mémorisée côté serveur.
  const [detachingAgendaId, setDetachingAgendaId] = useState<number | null>(null);
  const detacherAgenda = async (itemId: number) => {
    if (!doc) return;
    setDetachingAgendaId(itemId);
    try {
      await apiClient.delete(`/api/documents/${doc.id}/agenda-liens?itemId=${itemId}`);
      setLinkedAgendaItems((l) => l.filter((x) => x.id !== itemId));
      toast.success(GROUPING_LABELS.detachedToast);
      window.dispatchEvent(new CustomEvent('agenda-mutated'));
      await rechargerElementsAgenda();
    } catch (err: any) {
      if (err?.status !== 403) toast.error(err?.serverMessage || err?.message || 'Le lien n’a pas pu être retiré');
    } finally {
      setDetachingAgendaId(null);
    }
  };

  // Sub-drawers
  // Lot 75H : pièce et équipement s'ouvrent en tiroir empilé (GlobalDrawerHost,
  // fiche relue par son identifiant — statut réel, plus « En service » supposé).
  const [agendaDrawerItem, setAgendaDrawerItem] = useState<AgendaItemFull | null>(null);
  const [loadingAgendaItem, setLoadingAgendaItem] = useState<number | null>(null);
  // Carte « Éléments agenda » : échéance ouverte dans le tiroir local
  // ci-dessous (sa modification relit la liste des éléments liés).
  const openLinkedAgendaItem = async (agendaId: number) => {
    setLoadingAgendaItem(agendaId);
    try {
      const res = await fetch(`/api/agenda/${agendaId}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setAgendaDrawerItem(data.item ?? data);
      }
    } catch { /* ignore */ } finally {
      setLoadingAgendaItem(null);
    }
  };

  // SSE subscription for live analysis state
  useEffect(() => {
    if (!open || !doc || !analysisState || analysisState !== 'ANALYZING') return;
    const ctrl = new AbortController();
    sseAbortRef.current = ctrl;

    (async () => {
      try {
        const res = await fetch(`/api/documents/${doc.id}/stream`, {
      credentials: 'include',
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) return;

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(line.slice(6));
              if (evt.analysisState) setAnalysisState(displayAnalysisState(evt.analysisState, null));
              if (evt.proposals) setLiveProposals(evt.proposals);
              if (evt.type === 'progress' && evt.stage) setSseStage(evt.stage);
              if (evt.type === 'done' || evt.type === 'error' || evt.type === 'timeout') {
                setSseStage(null);
                return;
              }
            } catch { /* ignore */ }
          }
        }
      } catch { /* aborted or error */ }
    })();

    return () => { ctrl.abort(); sseAbortRef.current = null; };
  }, [open, doc?.id, analysisState]); // eslint-disable-line react-hooks/exhaustive-deps

  // Compteur temps écoulé pendant l'analyse (ANALYZING ou isAnalyzing)
  // Utilise le timestamp de début mémorisé dans le contexte pour compter depuis le vrai début
  const isCurrentlyAnalyzing = analysisState === 'ANALYZING' || isAnalyzing;
  useEffect(() => {
    if (!isCurrentlyAnalyzing) { setAnalyzingElapsed(0); setSseStage(null); return; }
    // Calculer l'offset initial depuis le vrai début de l'analyse (si connu)
    const startTime = doc?.id ? (analysisStartTimes[doc.id] ?? Date.now()) : Date.now();
    const getElapsed = () => Math.floor((Date.now() - startTime) / 1000);
    setAnalyzingElapsed(getElapsed());
    const timer = setInterval(() => setAnalyzingElapsed(getElapsed()), 1000);
    return () => clearInterval(timer);
  }, [isCurrentlyAnalyzing, doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Détecter un ANALYZING bloqué — après 30s sans progression SSE, proposer "Relancer"
  useEffect(() => {
    if (analysisState === 'ANALYZING') {
      if (!analyzingStartRef.current) analyzingStartRef.current = Date.now();
      setAnalyzingTooLong(false);
      const timeout = setTimeout(() => setAnalyzingTooLong(true), 30_000);
      return () => clearTimeout(timeout);
    } else {
      analyzingStartRef.current = null;
      setAnalyzingTooLong(false);
    }
  }, [analysisState]);

  useEffect(() => {
    if (!open || !doc) {
      setAnalyzingTooLong(false);
      analyzingStartRef.current = null;
      setFullData(null);
      setViewUrl(null);
      setIsEditing(false);
      setIsAnalyzing(false);
      setAnalyzeError('');
      setAnalyzeSuccess(false);
      setAnalyzeElapsed(0);
      setAnalyzeStage(0);
      setAgendaSuggestions([]);
      setLinkedAgendaItems([]);
      setAnalysisState(null);
      setLiveProposals([]);
      setShowDetectedInfo(false);
      if (sseAbortRef.current) { sseAbortRef.current.abort(); sseAbortRef.current = null; }
      return;
    }
    // Si le contexte global sait que ce document est en analyse, l'afficher immédiatement
    if (analyzingFileIds.includes(doc.id)) {
      setAnalysisState('ANALYZING');
      setShowDetectedInfo(true);
    }
    let cancelled = false;
    const load = async () => {
      setIsLoadingPreview(true);
      try {
        const [fileData, viewData, assetsData, proposalsRes, agendaRes] = await Promise.allSettled([
          apiClient.get<any>(`/api/files/${doc.id}`),
          apiClient.get<{ viewUrl: string }>(`/api/files/${doc.id}/view`),
          apiClient.get<any>('/api/assets?limit=100', { useCache: true }),
          fetch(`/api/documents/${doc.id}/analysis-proposals`, { credentials: 'include' }),
          fetch(`/api/agenda?fileId=${doc.id}&period=all&includeCancelled=false`, { credentials: 'include' }),
        ]);
        if (cancelled) return;
        if (fileData.status === 'fulfilled') {
          const f = fileData.value;
          const fd: FullFileData = {
            id: f.id,
            publicId: f.publicId ?? f.public_id ?? null,
            rubricCode: f.rubricCode ?? f.rubric_code ?? null,
            documentTypeCode: f.documentTypeCode ?? f.document_type_code ?? null,
            originalFilename: f.originalFilename ?? f.original_filename,
            mimeType: f.mimeType ?? f.mime_type,
            documentType: f.documentType ?? f.document_type ?? null,
            retainedTitle: f.retainedTitle ?? f.retained_title ?? null,
            retainedFunctionCode: f.retainedFunctionCode ?? f.retained_function_code ?? null,
            documentDate: f.documentDate ?? f.document_date ?? null,
            uploadedAt: f.uploadedAt ?? f.uploaded_at ?? null,
            lastAnalysisAt: f.lastAnalysisAt ?? f.last_analysis_at ?? null,
            size: f.size ?? null,
            supplier: f.supplier ?? null,
            amountCents: f.amountCents ?? f.amount_cents ?? null,
            description: f.description ?? null,
            notes: f.notes ?? null,
            substructureId: f.substructureId ?? f.substructure_id ?? null,
            equipmentId: f.equipmentId ?? f.equipment_id ?? null,
            assetId: f.assetId ?? f.asset_id ?? null,
            analysisState: f.analysisState ?? f.analysis_state ?? null,
            processingStatus: isProcessingStatus(f.processingStatus) ? f.processingStatus : null,
            userMessageCode: typeof f.userMessageCode === 'string' ? f.userMessageCode : null,
            processingResumeAt: typeof f.processingResumeAt === 'string' ? f.processingResumeAt : null,
            userEditedFields: f.userEditedFields ?? f.user_edited_fields ?? null,
          };
          setFullData(fd);
          // Lot 34C : l'affichage suit le statut fonctionnel (job réel), pas
          // l'état transitoire du document.
          setAnalysisState(displayAnalysisState(fd.analysisState, fd.processingStatus));
        }
        if (viewData.status === 'fulfilled') {
          setViewUrl(viewData.value.viewUrl ?? null);
        }
        if (assetsData.status === 'fulfilled') {
          const raw = assetsData.value;
          const list = Array.isArray(raw) ? raw : (raw?.data ?? []);
          setAssetsList(list.map((a: any) => ({ id: a.id, name: a.name, category: a.category })));
        }

        // Load linked agenda items — keep parsed data to filter suggestions below
        const existingAgendaTitles = new Set<string>();
        if (agendaRes.status === 'fulfilled') {
          const res = agendaRes.value as Response;
          if (res.ok) {
            const { items } = await res.json();
            const mapped = ((items ?? []) as any[]).map(i => ({ id: i.id, title: i.title, startDate: i.startDate ?? null, effectiveStatus: i.effectiveStatus }));
            if (!cancelled) setLinkedAgendaItems(mapped);
            mapped.forEach(i => existingAgendaTitles.add(i.title.toLowerCase().trim()));
          }
        }

        // Load existing agenda suggestions from prior analysis — filter out already-created items
        if (proposalsRes.status === 'fulfilled') {
          const res = proposalsRes.value as Response;
          if (res.ok) {
            const { proposals } = await res.json();
            const allProposals = (proposals ?? []) as AiFieldProposal[];
            const suggestions: AgendaSuggestion[] = allProposals
              .filter(p => p.proposalType === 'agenda_suggestion' && p.status !== 'rejected')
              .reduce<AgendaSuggestion[]>((acc, p) => {
                try { const s = JSON.parse(p.proposedValueJson) as AgendaSuggestion; if (s?.label) acc.push({ ...s, proposalId: p.id }); } catch { /* ignore */ }
                return acc;
              }, [])
              .filter(s => !existingAgendaTitles.has(s.label.toLowerCase().trim()));
            if (!cancelled) setAgendaSuggestions(suggestions);

            // Ouvert depuis une notification d'analyse : le bloc « Automatique »
            // est déplié (lecture seule — lot 71B, plus de validation).
            if (showAnalysisResults && !cancelled) setShowDetectedInfo(true);
          }
        }

        // Load substructures + equipments for view mode display
        const assetId = fileData.status === 'fulfilled'
          ? (fileData.value.assetId ?? fileData.value.asset_id ?? null)
          : null;
        const assetCategory = assetsData.status === 'fulfilled'
          ? (Array.isArray(assetsData.value) ? assetsData.value : (assetsData.value?.data ?? []))
              .find((a: any) => a.id === assetId)?.category
          : null;
        if (assetId && assetCategory === 'IMMOBILIER') {
          const [subData, eqData] = await Promise.all([
            apiClient.get<any>(`/api/assets/${assetId}/substructures`).catch(() => []),
            apiClient.get<any>(`/api/assets/${assetId}/equipments`).catch(() => []),
          ]);
          if (!cancelled) {
            setSubstructuresList(Array.isArray(subData) ? subData : (subData?.data ?? []));
            setEquipmentsList(Array.isArray(eqData) ? eqData : (eqData?.data ?? []));
          }
        }
      } catch { /* ignore */ } finally {
        if (!cancelled) setIsLoadingPreview(false);
      }
    };
    load().then(() => {
      if (!cancelled && autoAnalyze) handleAnalyze();
    });
    return () => { cancelled = true; };
  }, [open, doc?.id, refreshTrigger]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lot 75B : pièce du document modifiée depuis le tiroir Pièce (empilé
  // au-dessus) : la fiche est relue — rattachement affiché à jour.
  useEffect(() => {
    if (!open || !doc) return;
    const relire = (e: Event) => {
      const ids = (e as CustomEvent<{ fileIds?: number[] }>)?.detail?.fileIds;
      if (Array.isArray(ids) && ids.includes(doc.id)) setRefreshTrigger(prev => prev + 1);
    };
    window.addEventListener(ROOM_ASSOCIATIONS_CHANGED, relire);
    return () => window.removeEventListener(ROOM_ASSOCIATIONS_CHANGED, relire);
  }, [open, doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh drawer completely when background analysis finishes
  useEffect(() => {
    if (!open || !doc) return;
    const handleComplete = (e: Event) => {
      const fileId = (e as CustomEvent)?.detail?.fileId;
      if (fileId === doc.id) {
        setRefreshTrigger(prev => prev + 1);
      }
    };
    window.addEventListener('document-analysis-complete', handleComplete);
    return () => {
      window.removeEventListener('document-analysis-complete', handleComplete);
    };
  }, [open, doc?.id]);

  // Timer + stage cycling while analyzing (analyse lancée depuis le drawer)
  useEffect(() => {
    if (!isAnalyzing) return;
    // Partir du temps réel de début si connu dans le contexte, sinon 0
    const startTime = doc?.id ? (analysisStartTimes[doc.id] ?? Date.now()) : Date.now();
    const getElapsed = () => Math.floor((Date.now() - startTime) / 1000);
    setAnalyzeElapsed(getElapsed());
    setAnalyzeStage(0);
    const timer = setInterval(() => setAnalyzeElapsed(getElapsed()), 1000);
    const stages = setInterval(() => {
      setAnalyzeStage(s => Math.min(s + 1, 3));
    }, 3500);
    return () => { clearInterval(timer); clearInterval(stages); };
  }, [isAnalyzing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Les trois boutons « Modifier » du tiroir passent par ici. La garde
  // précède le chargement des données d'édition : inutile d'aller les
  // chercher pour une écriture que le serveur refusera.
  const { garder, estBloque } = useWriteGuard();

  // Filet de sécurité : QUEL QUE SOIT le chemin qui passe le tiroir en
  // édition (bouton « Modifier », mode
  // d'ouverture), un compte sans droit d'écriture en ressort aussitôt et
  // voit la fenêtre de fin d'essai.
  useEffect(() => {
    if (!isEditing || !estBloque()) return;
    setIsEditing(false);
    garder(() => {});
  }, [isEditing, estBloque, garder]);

  const enterEditMode = useCallback(async () => {
    let autorise = false;
    garder(() => { autorise = true; });
    if (!autorise) return;

    if (!fullData) {
      // fullData not yet loaded — should not normally happen, but guard against it
      setIsEditing(true);
      return;
    }
    // Lot 33C : le champ part du titre AFFICHÉ (titre métier), plus du nom
    // de fichier — réenregistrer écrasait le titre par « <uuid>.pdf ».
    setEditFilename(displayDocumentTitle(fullData, ''));
    setEditClassement({ rubricCode: fullData.rubricCode, documentTypeCode: fullData.documentTypeCode });
    setEditDocDate(fullData.documentDate ?? '');
    setEditSupplier(fullData.supplier ?? '');
    setEditAmount(fullData.amountCents != null ? formatNumberForInput(fullData.amountCents / 100) : '');
    setEditAmountError(false);
    setEditDescription(fullData.description ?? '');
    setEditNotes(fullData.notes ?? '');
    const currentAssetId = fullData.assetId ?? null;
    setEditAssetId(currentAssetId);
    setEditSubstructureId(fullData.substructureId ?? null);
    setEditEquipmentId(fullData.equipmentId ?? null);
    setIsEditing(true);

    // Load user plan + rooms/equipments for current asset (assets already loaded on open)
    try {
      const meData = await apiClient.get<any>('/api/users/me', { useCache: true });
      if (currentAssetId) {
        const selectedAsset = assetsList.find((a) => a.id === currentAssetId);
        if (selectedAsset?.category === 'IMMOBILIER') {
          // Only reload if not already loaded for this asset
          if (substructuresList.length === 0 || !substructuresList.some(s => s)) {
            const [subData, eqData] = await Promise.all([
              apiClient.get<any>(`/api/assets/${currentAssetId}/substructures`),
              apiClient.get<any>(`/api/assets/${currentAssetId}/equipments`),
            ]);
            setSubstructuresList(Array.isArray(subData) ? subData : (subData?.data ?? []));
            setEquipmentsList(Array.isArray(eqData) ? eqData : (eqData?.data ?? []));
          }
        } else {
          setSubstructuresList([]);
          setEquipmentsList([]);
        }
      }
    } catch { /* ignore */ }
  }, [fullData]);

  const handleAssetChange = useCallback(async (newAssetIdStr: string) => {
    const newAssetId = newAssetIdStr === 'none' ? null : parseInt(newAssetIdStr);
    setEditAssetId(newAssetId);
    setEditSubstructureId(null);
    setEditEquipmentId(null);
    setSubstructuresList([]);
    setEquipmentsList([]);
    if (!newAssetId) return;
    const selectedAsset = assetsList.find(a => a.id === newAssetId);
    if (selectedAsset?.category === 'IMMOBILIER') {
      try {
        const [subData, eqData] = await Promise.all([
          apiClient.get<any>(`/api/assets/${newAssetId}/substructures`),
          apiClient.get<any>(`/api/assets/${newAssetId}/equipments`),
        ]);
        setSubstructuresList(Array.isArray(subData) ? subData : (subData?.data ?? []));
        setEquipmentsList(Array.isArray(eqData) ? eqData : (eqData?.data ?? []));
      } catch { /* ignore */ }
    }
  }, [assetsList]);

  const handleSave = useCallback(async () => {
    if (!doc || !fullData) return;
    if (!editFilename.trim()) { toast.error('Le titre du document est requis'); return; }
    // Lot 58A : montant converti à la validation ; saisie invalide → aucun envoi.
    const montant = parseMoneyInputToCents(editAmount);
    if (!montant.ok) { setEditAmountError(true); toast.error(`Montant : ${montant.error}`); return; }
    setIsSaving(true);
    try {
      const amountCents = montant.cents;
      // Lot 86E : le tiroir ne modifie plus le code V1 historique. Le
      // « normaliser » ici transformait une nature reconnue sans équivalent V1
      // (« BON_COMMANDE ») en « AUTRE » à chaque enregistrement — et la marquait
      // comme un choix de l'utilisateur. Le Type se modifie par le classement
      // (Rubrique / Type), seule valeur affichée.
      // Compute userEditedFields: mark fields that differ from what AI detected
    const userEdited: Record<string, boolean> = { ...(fullData.userEditedFields ?? {}) };
    if (fullData.lastAnalysisAt) {
      if (editFilename.trim() !== displayDocumentTitle(fullData, '')) userEdited.retainedTitle = true;
      if ((editDocDate || null) !== fullData.documentDate) userEdited.documentDate = true;
      if ((editSupplier.trim() || null) !== fullData.supplier) userEdited.supplier = true;
      const newAmt = amountCents;
      if (newAmt !== fullData.amountCents) userEdited.amountCents = true;
    }

    const response = await fetch(`/api/documents/${doc.id}`, {
      credentials: 'include',
        method: 'PUT',
        headers: { 'Content-Type': 'application/json'},
        body: JSON.stringify({
          fileName: editFilename.trim(),
          retainedTitle: editFilename.trim(),
          documentDate: editDocDate || null,
          assetId: editAssetId,
          substructureId: editSubstructureId,
          equipmentId: editEquipmentId,
          supplier: editSupplier.trim() || null,
          description: editDescription.trim() || null,
          notes: editNotes.trim() || null,
          amountCents,
          userEditedFields: userEdited,
        }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        // Lot 85D : refus de droits (403, lecture seule) → fenêtre habituelle,
        // pas de message d'erreur générique par-dessus.
        const refus = parseWriteBlocked(err);
        if (refus) {
          notifyWriteBlocked(refus);
          setIsEditing(false);
          return;
        }
        throw new Error(err.message || 'Erreur lors de la sauvegarde');
      }

      // Classement V2 : enregistré par sa route dédiée (validation du
      // référentiel, origine USER, résolution des actions « À traiter »),
      // seulement s'il a changé.
      const classementChange =
        effectiveRubric(editClassement) !== effectiveRubric({ rubricCode: fullData.rubricCode, documentTypeCode: fullData.documentTypeCode })
        || editClassement.documentTypeCode !== fullData.documentTypeCode;
      if (classementChange && fullData.publicId) {
        await apiClient.patch(`/api/v2/documents/${fullData.publicId}/classification`, {
          rubricCode: effectiveRubric(editClassement),
          documentTypeCode: editClassement.documentTypeCode,
        });
      }

      setFullData(prev => prev ? {
        ...prev,
        retainedTitle: editFilename.trim(),
        documentDate: editDocDate || null,
        supplier: editSupplier.trim() || null,
        amountCents: isNaN(amountCents as number) ? null : amountCents,
        description: editDescription.trim() || null,
        notes: editNotes.trim() || null,
        rubricCode: effectiveRubric(editClassement),
        documentTypeCode: editClassement.documentTypeCode,
      } : prev);
      // Lot 28 : un rattachement ou une donnée corrigés ici ferment l'action
      // « À traiter » correspondante — page et pastille relues.
      window.dispatchEvent(new CustomEvent('refresh-a-traiter'));
      toast.success('Document mis à jour');
      setIsEditing(false);
      onRefresh();
    } catch (err: any) {
      toast.error(err?.message ?? 'Erreur lors de la sauvegarde');
    } finally {
      setIsSaving(false);
    }
  }, [doc, fullData, editFilename, editClassement, editDocDate, editSupplier, editAmount, editDescription, editNotes, editAssetId, editSubstructureId, editEquipmentId, onRefresh]);

  const handleAnalyze = useCallback(async () => {
    if (!doc) return;
    if (analysisState === 'ANALYSIS_FAILED') setRetryCount(c => c + 1);
    setIsAnalyzing(true);
    setAnalyzeError('');
    setAnalyzeSuccess(false);
    setAgendaSuggestions([]);
    window.dispatchEvent(new CustomEvent('document-analysis-start', { detail: { fileId: doc.id } }));

    try {
      // Si le document est bloqué en ANALYZING, le réinitialiser d'abord
      if (analysisState === 'ANALYZING') {
        await fetch(`/api/documents/${doc.id}/reset-analysis`, {
      credentials: 'include',
          method: 'POST',
        }).catch(() => { /* non-bloquant */ });
        setAnalysisState('ANALYSIS_FAILED');
      }

      // Stream SSE pour éviter le timeout HTTP de 120s
      // skipNotification=true: drawer is open — no bell needed; client will create it if drawer closes
      const startRes = await fetch(`/api/documents/${doc.id}/analyze`, {
      credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json'},
        body: JSON.stringify({ skipNotification: true }),
      });
      if (!startRes.ok || !startRes.body) {
        const err = await startRes.json().catch(() => ({}));
        const retour = analyzeErrorFeedback({ code: err.error, message: err.message });
        setAnalyzeError(retour.message);
        toast.error(retour.message, { duration: 8000 });
        setIsAnalyzing(false);
        return;
      }

      // Lire le stream SSE jusqu'à l'événement "done" ou "error"
      const reader = startRes.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let analysisError: string | null = null;
      let analysisFeedback: AnalyzeFeedback | null = null;
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'done') break outer;
            if (evt.type === 'progress' && evt.stage) setSseStage(evt.stage);
            if (evt.type === 'error') {
              // Lot 16b-3 : motif du serveur (échec motivé du master T1,
              // analyse déjà en file…) rendu par un toast.
              analysisFeedback = analyzeErrorFeedback(evt);
              analysisError = analysisFeedback.message;
              break outer;
            }
          } catch { /* ignore malformed line */ }
        }
      }

      if (analysisError) {
        setAnalyzeError(analysisError);
        setIsAnalyzing(false);
        if (analysisFeedback?.level === 'info') toast.info(analysisError, { duration: 6000 });
        else toast.error(analysisError, { duration: 8000 });
        // État relu : après un échec, le document est remis en file durable
        // (« En file ») ou reste en échec motivé — jamais l'état local périmé.
        const relu = await apiClient.get<any>(`/api/files/${doc.id}`).catch(() => null);
        if (relu) {
          const etat = relu.analysisState ?? relu.analysis_state ?? null;
          const statut = isProcessingStatus(relu.processingStatus) ? relu.processingStatus : null;
          setAnalysisState(displayAnalysisState(etat, statut));
          setFullData(prev => prev ? {
            ...prev, analysisState: etat, processingStatus: statut,
            userMessageCode: typeof relu.userMessageCode === 'string' ? relu.userMessageCode : null,
            processingResumeAt: typeof relu.processingResumeAt === 'string' ? relu.processingResumeAt : null,
          } : prev);
        }
        window.dispatchEvent(new CustomEvent('document-analysis-complete', { detail: { fileId: doc.id } }));
        return;
      }

      // Relecture complète : les informations détectées sont déjà enregistrées (lot 71B).
      const [refreshedFile, propRes] = await Promise.all([
        apiClient.get<any>(`/api/files/${doc.id}`).catch(() => null),
        fetch(`/api/documents/${doc.id}/analysis-proposals`, {
      credentials: 'include',
        }),
      ]);

      if (refreshedFile) {
        const rf = refreshedFile;
        const fd: FullFileData = {
          id: rf.id,
          publicId: rf.publicId ?? rf.public_id ?? null,
          rubricCode: rf.rubricCode ?? rf.rubric_code ?? null,
          documentTypeCode: rf.documentTypeCode ?? rf.document_type_code ?? null,
          originalFilename: rf.originalFilename ?? rf.original_filename,
          mimeType: rf.mimeType ?? rf.mime_type,
          documentType: rf.documentType ?? rf.document_type ?? null,
          retainedTitle: rf.retainedTitle ?? rf.retained_title ?? null,
          retainedFunctionCode: rf.retainedFunctionCode ?? rf.retained_function_code ?? null,
          documentDate: rf.documentDate ?? rf.document_date ?? null,
          uploadedAt: rf.uploadedAt ?? rf.uploaded_at ?? null,
          lastAnalysisAt: rf.lastAnalysisAt ?? rf.last_analysis_at ?? null,
          size: rf.size ?? null,
          supplier: rf.supplier ?? null,
          amountCents: rf.amountCents ?? rf.amount_cents ?? null,
          description: rf.description ?? null,
          notes: rf.notes ?? null,
          substructureId: rf.substructureId ?? rf.substructure_id ?? null,
          equipmentId: rf.equipmentId ?? rf.equipment_id ?? null,
          assetId: rf.assetId ?? rf.asset_id ?? null,
          analysisState: rf.analysisState ?? rf.analysis_state ?? null,
          processingStatus: isProcessingStatus(rf.processingStatus) ? rf.processingStatus : null,
          userMessageCode: typeof rf.userMessageCode === 'string' ? rf.userMessageCode : null,
          processingResumeAt: typeof rf.processingResumeAt === 'string' ? rf.processingResumeAt : null,
          userEditedFields: rf.userEditedFields ?? rf.user_edited_fields ?? null,
        };
        setFullData(fd);
        setAnalysisState(displayAnalysisState(fd.analysisState, fd.processingStatus));
      }

      if (propRes.ok) {
        const { proposals } = await propRes.json();
        const allProposals = (proposals ?? []) as AiFieldProposal[];

        // Extract agenda suggestions — filter out titles that already exist as linked agenda items
        const existingTitlesNow = new Set(linkedAgendaItems.map(i => i.title.toLowerCase().trim()));
        const suggestions: AgendaSuggestion[] = allProposals
          .filter(p => p.proposalType === 'agenda_suggestion' && p.status !== 'rejected')
          .reduce<AgendaSuggestion[]>((acc, p) => {
            try { const s = JSON.parse(p.proposedValueJson) as AgendaSuggestion; if (s?.label) acc.push({ ...s, proposalId: p.id }); } catch { /* ignore */ }
            return acc;
          }, [])
          .filter(s => !existingTitlesNow.has(s.label.toLowerCase().trim()));
        setAgendaSuggestions(suggestions);

        setIsAnalyzing(false);
        setAnalyzeSuccess(true);
        window.dispatchEvent(new CustomEvent('document-analysis-complete', { detail: { fileId: doc.id } }));

        const completionMsg = 'Analyse terminée — informations enregistrées';

        const drawerWasClosed = bgToastIdRef.current !== null;
        if (drawerWasClosed) {
          // Drawer was closed — update the in-progress toast to show completion
          toast.success(completionMsg, {
            id: bgToastIdRef.current!,
            duration: 8000,
            action: {
              label: 'Voir le document',
              onClick: () => { onOpenChangeRef.current(true); },
            },
          });
          bgToastIdRef.current = null;
        }

      } else {
        // Propositions illisibles : l'analyse est terminée, rien à valider.
        setIsAnalyzing(false);
        setAnalyzeSuccess(true);
        window.dispatchEvent(new CustomEvent('document-analysis-complete', { detail: { fileId: doc.id } }));

        const drawerWasClosed = bgToastIdRef.current !== null;
        if (drawerWasClosed) {
          toast.success('Analyse terminée', {
            id: bgToastIdRef.current!,
            duration: 8000,
            action: { label: 'Voir le document', onClick: () => { onOpenChangeRef.current(true); } },
          });
          bgToastIdRef.current = null;
        }
      }

      // Dispatch event so NotificationBell refreshes
      window.dispatchEvent(new CustomEvent('notifications-refresh'));

      // Refresh parent list (missing_analysis motif now resolved)
      onRefresh();
    } catch {
      setAnalyzeError("Erreur lors de l'analyse. Veuillez réessayer.");
      setIsAnalyzing(false);
      if (bgToastIdRef.current !== null) {
        toast.error("Erreur lors de l'analyse", { id: bgToastIdRef.current, duration: 6000 });
        bgToastIdRef.current = null;
      } else {
        toast.error("Erreur lors de l'analyse. Veuillez réessayer.", { duration: 6000 });
      }
    }
  }, [doc, onRefresh]);

  const handleDownload = useCallback(async () => {
    if (!doc) return;
    try {
      // `/download` et non `/view` : l'URL signée porte un en-tête
      // « attachment » avec le titre du document comme nom de fichier. Le
      // lien de consultation, lui, est « inline » — et l'attribut `download`
      // est ignoré sur une URL d'une autre origine.
      const data = await apiClient.get<{ downloadUrl: string; filename?: string; isWebLink?: boolean }>(`/api/files/${doc.id}/download`);
      if (data.downloadUrl) {
        const a = document.createElement('a');
        a.href = data.downloadUrl;
        a.rel = 'noopener';
        // Même nom que l'en-tête de l'URL signée (lot 75L), qui fait foi.
        if (data.filename && !data.isWebLink) a.download = data.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch { toast.error('Impossible de télécharger le fichier'); }
  }, [doc]);

  const handleDelete = useCallback(async () => {
    if (!doc) return;
    setIsDeleting(true);
    try {
      await apiClient.delete(`/api/files/${doc.id}`);
      toast.success('Document supprimé');
      window.dispatchEvent(new CustomEvent('document-deleted', { detail: { fileId: doc.id } }));
      onOpenChange(false);
      onRefresh();
    } catch (err: any) {
      toast.error(err?.message ?? 'Erreur lors de la suppression');
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  }, [doc, onOpenChange, onRefresh]);

  // Intercept drawer close: if analysis in progress, block close entirely
  const handleOpenChange = useCallback((v: boolean) => {
    if (!v && isAnalyzing) {
      toast.info('Analyse en cours…', { duration: 3000 });
      return;
    }
    onOpenChange(v);
  }, [isAnalyzing, onOpenChange]);

  if (!doc) return null;

  // Lot 86E (ticket §5) : un seul libellé de Type, celui du Type ENREGISTRÉ
  // (référentiel V2), le même que la liste et la section « Informations » —
  // plus le code V1 historique (« BON_COMMANDE » brut, ou « Autre » par défaut).
  const typeLabel = fullData
    ? documentTypeDisplayLabel(fullData.documentTypeCode)
    : doc.documentTypeCode !== undefined ? documentTypeDisplayLabel(doc.documentTypeCode) : null;
  // Lot 33C (AC8) : titre métier → nom original exploitable → nom technique.
  const filename = displayDocumentTitle(fullData ?? { originalFilename: doc.originalFilename }, doc.originalFilename);

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          className="w-full sm:max-w-lg flex flex-col p-0"
          onInteractOutside={isAnalyzing ? (e) => e.preventDefault() : undefined}
          onEscapeKeyDown={isAnalyzing ? (e) => e.preventDefault() : undefined}
          // Lot 76E : focus rendu à l'élément d'origine, s'il est fourni.
          onCloseAutoFocus={(e) => { restoreFocusOnClose(e, returnFocusTo); }}
        >
          <SheetHeader className="px-5 pt-5 pb-3">
            {/* Title row — icon + name + badge (close ✕ is absolute top-right from shadcn) */}
            <div className="flex items-start gap-3 pr-8">
              <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <FileText className="w-4 h-4 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <SheetTitle className="leading-tight line-clamp-2 text-left">
                  {isEditing ? editFilename || filename : filename}
                </SheetTitle>
                {typeLabel && <Badge variant="outline" className="mt-1.5 text-xs">{typeLabel}</Badge>}
              </div>
            </div>

            {/* Navigation row — separated from the close button */}
            {(onPrev || onNext) && (
              <div className="flex items-center gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 px-3 gap-1.5"
                  onClick={onPrev}
                  disabled={!hasPrev}
                  title="Document précédent"
                >
                  <ChevronLeft className="w-4 h-4" />
                  <span className="text-xs">Précédent</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 px-3 gap-1.5"
                  onClick={onNext}
                  disabled={!hasNext}
                  title="Document suivant"
                >
                  <span className="text-xs">Suivant</span>
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            )}
          </SheetHeader>

          <div className="flex-1 overflow-y-auto">
            {/* Preview */}
            <div className="px-5 pb-4">
              {isLoadingPreview ? (
                <div className="flex items-center justify-center h-40 bg-muted/30 rounded-lg border">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <DocPreview fileId={doc.id} mimeType={fullData?.mimeType ?? doc.mimeType} viewUrl={viewUrl} filename={filename} />
              )}
            </div>

            <Separator />

            {isAnalyzing && (() => {
              const STAGES = [
                { label: 'Chargement du document…', pct: 10 },
                { label: 'Préparation de l\'analyse…', pct: 20 },
                { label: 'Passe 1 — Extraction des métadonnées…', pct: 45 },
                { label: 'Passe 2 — Transcription et agenda…', pct: 75 },
                { label: 'Finalisation des suggestions…', pct: 92 },
              ];
              const stage = STAGES[analyzeStage];
              const fmtTime = (s: number) => s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
              return (
                <div className="px-5 py-6 space-y-5">
                  {/* Icon + label */}
                  <div className="flex flex-col items-center gap-3 text-center">
                    <div className="relative w-14 h-14">
                      <div className="absolute inset-0 rounded-full bg-[color:var(--accent-soft)] animate-pulse" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Wand2 className="w-6 h-6 text-[color:var(--accent)]" />
                      </div>
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-foreground">Analyse en cours</p>
                      <p className="text-xs text-muted-foreground mt-0.5 transition-all">{stage.label}</p>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="space-y-1.5">
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-[color:var(--accent)] transition-all duration-[2000ms] ease-out"
                        style={{ width: `${stage.pct}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>{stage.pct}%</span>
                      <span>{fmtTime(analyzeElapsed)} écoulé</span>
                    </div>
                  </div>

                  {/* Steps */}
                  <div className="space-y-2">
                    {STAGES.map((s, i) => (
                      <div key={i} className="flex items-center gap-2.5">
                        <div className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 transition-all ${
                          i < analyzeStage ? 'bg-[color:var(--accent)]' : i === analyzeStage ? 'border-2 border-[color:var(--accent)]' : 'border border-muted-foreground/30'
                        }`}>
                          {i < analyzeStage && <Check className="w-2.5 h-2.5 text-[color:var(--on-accent)]" />}
                          {i === analyzeStage && <div className="w-1.5 h-1.5 rounded-full bg-[color:var(--accent)] animate-pulse" />}
                        </div>
                        <span className={`text-xs transition-all ${
                          i < analyzeStage ? 'text-[color:var(--accent)]' : i === analyzeStage ? 'text-foreground font-medium' : 'text-muted-foreground/50'
                        }`}>{s.label.replace('…', '')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* ── Bloc "Informations détectées" par l'IA ─────────────────── */}
            {!isEditing && !isAnalyzing && analysisState && analysisState !== null && (() => {
              const proposals = liveProposals.length > 0
                ? liveProposals
                : [];

              const stateConfig: Record<string, { label: string; icon: React.ReactNode; color: string; bg: string }> = {
                // Dépôt multiple : le document attend son tour dans la file
                // d'analyse du serveur.
                UPLOADED: {
                  label: 'En file d\u2019attente',
                  icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
                  color: 'text-[color:var(--accent)]',
                  bg: 'bg-[color:var(--accent-soft)] border-[color:var(--border-info)]',
                },
                ANALYZING: {
                  label: 'Analyse en cours…',
                  icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
                  color: 'text-[color:var(--accent)]',
                  bg: 'bg-[color:var(--accent-soft)] border-[color:var(--border-info)]',
                },
                ANALYZED: {
                  label: 'Analysé',
                  icon: <CheckCircle2 className="w-3.5 h-3.5" />,
                  color: 'text-[color:var(--text-success)]',
                  bg: 'bg-[color:var(--bg-success)] border-[color:var(--border-success)]',
                },
                CONFLICT_DETECTED: {
                  label: 'Conflit détecté',
                  icon: <AlertCircle className="w-3.5 h-3.5" />,
                  color: 'text-[color:var(--danger)]',
                  bg: 'bg-[color:var(--danger-soft)] border-[color:var(--danger-edge)]',
                },
                FUSION_SUGGESTED: {
                  label: 'Doublon possible',
                  icon: <AlertCircle className="w-3.5 h-3.5" />,
                  color: 'text-[color:var(--attention-on-soft)]',
                  bg: 'bg-[color:var(--attention-soft)] border-[color:var(--attention-edge)]',
                },
                ANALYSIS_FAILED: {
                  label: fullData?.processingStatus === 'NEEDS_USER_ACTION' ? 'Action requise' : 'Analyse non finalisée',
                  icon: <AlertCircle className="w-3.5 h-3.5" />,
                  color: 'text-muted-foreground',
                  bg: 'bg-muted/30 border-border',
                },
              };

              // Un état inconnu n'est pas un échec : on n'affiche plus
              // « Analyse impossible » par défaut. `UPLOADING` (envoi en
              // cours) est rattaché à la file d'attente.
              if (analysisState === 'UPLOADING') stateConfig.UPLOADING = stateConfig.UPLOADED;
              const cfg = stateConfig[analysisState] ?? stateConfig['ANALYZED'];

              return (
                <div className="px-5 py-3 border-t border-border/40">
                  <div className="space-y-1.5">
                    {/* Header compact */}
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        className={`flex items-center gap-1.5 ${cfg.color} opacity-70 hover:opacity-100 transition-opacity`}
                        onClick={() => setShowDetectedInfo(v => !v)}
                      >
                        {cfg.icon}
                        <span className="text-[12px] font-semibold">Automatique — {cfg.label}</span>
                        {showDetectedInfo ? <ChevronUp className="w-3 h-3 ml-0.5" /> : <ChevronDown className="w-3 h-3 ml-0.5" />}
                      </button>
                      {/* Bouton relancer sur échec uniquement */}
                      {(analysisState === 'ANALYSIS_FAILED' && retryCount < 2) ? (
                        <Button size="sm" variant="outline"
                          className="h-6 px-2 text-[10px] border-border text-muted-foreground hover:bg-muted/40 shrink-0"
                          onClick={handleAnalyze}
                          disabled={isAnalyzing}>
                          {isAnalyzing
                            ? <Loader2 className="w-3 h-3 animate-spin" />
                            : <><RefreshCw className="w-3 h-3 mr-1" />Relancer</>}
                        </Button>
                      ) : null}
                    </div>

                    {/* Lot 22 : analyse reportée (plafond IA du mois du compte) — motif et date de reprise.
                        Lot 34C : texte du référentiel fermé (code + date), plus le motif brut du document. */}
                    {analysisState === 'UPLOADED' && fullData?.userMessageCode === 'ANALYSIS_DEFERRED_COST_CAP' && (
                      <p className="text-[10px] text-muted-foreground/70 leading-relaxed pl-1">
                        {userMessageText(fullData.userMessageCode, { resumeAt: fullData.processingResumeAt })}
                      </p>
                    )}

                    {showDetectedInfo && (analysisState === 'ANALYZING' || isAnalyzing) && !analyzingTooLong && (() => {
                      const STAGE_HINTS: Record<string, string> = {
                        lecture:      'Lecture du document…',
                        extraction:   'Extraction des données…',
                        analyse:      'Analyse et structuration…',
                        alimentation: 'Alimentation de la fiche…',
                      };
                      const STAGES_ORDER = ['lecture', 'extraction', 'analyse', 'alimentation'];
                      const STAGE_LABELS = ['Lecture', 'Extraction', 'Analyse', 'Alimentation'];
                      const currentKey = sseStage && STAGES_ORDER.includes(sseStage) ? sseStage : (isAnalyzing ? 'lecture' : 'lecture');
                      const hint = STAGE_HINTS[currentKey] ?? 'Analyse en cours…';
                      const stepIdx = STAGES_ORDER.indexOf(currentKey);
                      const elapsedStr = analyzingElapsed > 0 ? `${analyzingElapsed}s` : '';
                      return (
                        <div className="pl-1 pt-1 space-y-2">
                          <div className="flex items-center gap-2">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-[color:var(--accent)] shrink-0" />
                            <span className="text-[11px] text-muted-foreground">{hint}</span>
                            {elapsedStr && (
                              <span className="ml-auto text-[10px] text-muted-foreground/40 tabular-nums shrink-0">{elapsedStr}</span>
                            )}
                          </div>
                          <div className="space-y-1">
                            <div className="flex items-center gap-1">
                              {STAGES_ORDER.map((s, i) => (
                                <div key={s} className={`h-0.5 flex-1 rounded-full transition-all duration-700 ${
                                  i < stepIdx ? 'bg-[color:var(--accent)]' : i === stepIdx ? 'bg-[color:var(--accent)]/50' : 'bg-muted/30'
                                }`} />
                              ))}
                            </div>
                            <div className="flex items-center justify-between">
                              {STAGE_LABELS.map((lbl, i) => (
                                <span key={lbl} className={`text-[9px] transition-colors duration-500 ${
                                  i < stepIdx ? 'text-[color:var(--accent)]' : i === stepIdx ? 'text-[color:var(--accent)] font-medium' : 'text-muted-foreground/30'
                                }`}>{lbl}</span>
                              ))}
                            </div>
                          </div>
                        </div>
                      );
                    })()}


                    {/* Lot 34C : au plus le message fonctionnel du référentiel fermé —
                        jamais de motif technique (modèle, schéma, champ…), qui reste
                        dans BO › Exécutions IA. */}
                    {analysisState === 'ANALYSIS_FAILED' && !isAnalyzing && (
                      <div className="pl-1 space-y-1">
                        <p className="text-[10px] text-muted-foreground/70 leading-relaxed" data-testid="document-analysis-user-message">
                          {userMessageText(fullData?.userMessageCode ?? 'ANALYSIS_FAILED_FINAL') ?? ANALYSIS_FAILED_FINAL_MESSAGE}
                        </p>
                      </div>
                    )}

                    {showDetectedInfo && proposals.length > 0 && analysisState !== 'ANALYZING' && (
                      <div className="space-y-1.5 pt-1 pl-1 border-l border-border/50 ml-1">
                        {proposals
                          .filter((p: any) => p.proposalType === 'field' && p.status !== 'rejected')
                          .map((p: any) => {
                            let displayVal = '';
                            try { displayVal = JSON.parse(p.proposedValueJson); } catch { displayVal = p.proposedValueJson; }
                            const isEdited = fullData?.userEditedFields?.[p.targetKey] === true;
                            return (
                              <div key={p.id} className="flex items-start justify-between gap-2 text-xs">
                                <span className="text-muted-foreground shrink-0">{p.displayLabel ?? p.targetKey}</span>
                                <div className="flex items-center gap-1.5 min-w-0 text-right">
                                  <span className="font-medium truncate max-w-[160px]">{String(displayVal)}</span>
                                  {!isEdited && (
                                    <Sparkles className="w-2.5 h-2.5 text-[color:var(--accent)] shrink-0" aria-label="Détecté automatiquement" />
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        {/* Agenda suggestions */}
                        {proposals.filter((p: any) => p.proposalType === 'agenda_suggestion' && p.status !== 'rejected').length > 0 && (
                          <div className="pt-1 border-t border-current/10">
                            <p className="vb-app-label mb-1.5">Suggestions agenda</p>
                            <div className="space-y-1">
                              {proposals
                                .filter((p: any) => p.proposalType === 'agenda_suggestion' && p.status !== 'rejected')
                                .map((p: any) => {
                                  let s: any = {};
                                  try { s = JSON.parse(p.proposedValueJson); } catch { /* ignore */ }
                                  return (
                                    <div key={p.id} className="flex items-center justify-between gap-2">
                                      <div className="flex-1 min-w-0">
                                        <p className="text-xs font-medium truncate">{s.label ?? p.displayLabel}</p>
                                        {s.dateValue && <p className="text-[10px] text-muted-foreground">{fmt(s.dateValue)}</p>}
                                      </div>
                                      <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] shrink-0"
                                        onClick={() => {
                                          setAgendaPrefill({ title: s.label ?? '', startDate: s.dateValue ?? '' });
                                          setPendingAgendaProposalId(p.id);
                                          setAgendaDrawerOpen(true);
                                        }}>
                                        <CalendarPlus className="w-2.5 h-2.5 mr-1" />Ajouter
                                      </Button>
                                    </div>
                                  );
                                })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {showDetectedInfo && proposals.length === 0 && analysisState === 'ANALYZED' && (
                      <p className="text-[10px] text-muted-foreground/60 pl-1">Informations déjà complètes.</p>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Standard : bloc Premium verrouillé */}
            {!isEditing && !isAnalyzing && !isPremium && !analysisState && fullData && (
              <div className="px-5 pb-4">
                <div className="rounded-xl border border-[color:var(--border-info)] bg-[color:var(--accent-soft)] p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-[color:var(--accent-soft)] flex items-center justify-center shrink-0">
                      <Lock className="w-3.5 h-3.5 text-[color:var(--accent)]" />
                    </div>
                    <p className="text-sm font-semibold text-foreground">Analyse automatique</p>
                  </div>
                  <ul className="space-y-1.5 text-xs text-muted-foreground">
                    {['Détection automatique du type, date, fournisseur', 'Suggestions agenda et équipements', 'Indicateurs de confiance sur chaque champ', 'Détection des doublons lors de l\'upload'].map(f => (
                      <li key={f} className="flex items-center gap-2">
                        <Sparkles className="w-3 h-3 text-[color:var(--accent)] shrink-0" />
                        {f}
                      </li>
                    ))}
                  </ul>
                  <a
                    href="/mon-compte/offres"
                    className="flex items-center justify-center gap-2 w-full py-2 rounded-[12px] bg-[color:var(--accent)] text-[color:var(--on-accent)] text-xs font-bold hover:bg-[color:var(--accent-hover)] transition-colors"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    Passer Premium
                  </a>
                </div>
              </div>
            )}

            {isEditing ? (
              <div className="px-5 py-4 space-y-4">
                <p className="vb-app-subsection">Modifier le document</p>

                {/* Rattachement */}
                <div className="space-y-3 pb-2 border-b">
                  <p className="text-xs font-medium text-muted-foreground">Rattachement</p>
                  <div className="space-y-1.5">
                    <Label>Bien</Label>
                    <Select value={editAssetId ? String(editAssetId) : 'none'} onValueChange={handleAssetChange}>
                      <SelectTrigger><SelectValue placeholder="Aucun bien" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Aucun bien</SelectItem>
                        {assetsList.map(a => (
                          <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {/* Pièce + Équipement : visible si bien IMMOBILIER et compte premium */}
                  {editAssetId && assetsList.find(a => a.id === editAssetId)?.category === 'IMMOBILIER' && (
                    <>
                      <div className="space-y-1.5">
                        <Label>Pièce</Label>
                        <Select value={editSubstructureId ? String(editSubstructureId) : 'none'} onValueChange={v => setEditSubstructureId(v === 'none' ? null : parseInt(v))}>
                          <SelectTrigger><SelectValue placeholder="Aucune pièce" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">Aucune pièce</SelectItem>
                            {substructuresList.map(s => (
                              <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label>Équipement</Label>
                        <Select value={editEquipmentId ? String(editEquipmentId) : 'none'} onValueChange={v => setEditEquipmentId(v === 'none' ? null : parseInt(v))}>
                          <SelectTrigger><SelectValue placeholder="Aucun équipement" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">Aucun équipement</SelectItem>
                            {equipmentsList.map(e => (
                              <SelectItem key={e.id} value={String(e.id)}>{e.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label>Titre du document</Label>
                  <Input value={editFilename} onChange={e => setEditFilename(e.target.value)} />
                </div>
                {/* Rubrique et Type (classement V2) : intégrés ici, à la place de
                    l'ancien « Type de document » V1 et du tiroir « Classer »
                    qui s'ouvrait par le bas. Le type V1 est conservé tel quel
                    à l'enregistrement. */}
                <RubricTypeFields value={editClassement} onChange={setEditClassement} idPrefix={`doc-${doc.id}`} />
                <div className="space-y-1.5">
                  <Label>Date du document</Label>
                  <DatePicker value={editDocDate} onChange={v => setEditDocDate(v)} placeholder="jj/mm/aaaa" />
                </div>
                <div className="space-y-1.5">
                  <Label>Fournisseur</Label>
                  <Input value={editSupplier} onChange={e => setEditSupplier(e.target.value)} placeholder="Ex: Garage Dupont" />
                </div>
                <div className="space-y-1.5">
                  <Label>Montant (€)</Label>
                  <NumberInput value={editAmount} onValueChange={setEditAmount} parseOptions={MONEY_INPUT} showError={editAmountError} placeholder="Ex : 150,00" showButtons={false} />
                </div>
                <div className="space-y-1.5">
                  <Label>Description</Label>
                  <Textarea value={editDescription} onChange={e => setEditDescription(e.target.value)} rows={2} placeholder="Description du document..." />
                </div>
                <div className="space-y-1.5">
                  <Label>Notes</Label>
                  <Textarea value={editNotes} onChange={e => setEditNotes(e.target.value)} rows={2} placeholder="Notes internes..." />
                </div>

                {/* Agenda suggestions from AI — visible in edit mode too */}
                {agendaSuggestions.length > 0 && (
                  <div className="pt-2 border-t">
                    <p className="vb-app-label mb-2 flex items-center gap-1">
                      <CalendarPlus className="w-3 h-3" />Suggestions agenda
                    </p>
                    <div className="space-y-1.5">
                      {agendaSuggestions.map((s, i) => (
                        <div key={i} className="flex items-center justify-between gap-2 bg-primary/5 rounded-lg px-3 py-2 text-xs">
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate">{s.label}</p>
                            {s.dateValue && <p className="text-muted-foreground">{fmt(s.dateValue)}</p>}
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs shrink-0"
                            onClick={() => {
                              setAgendaPrefill({ title: s.label, startDate: s.dateValue ?? '' });
                              setPendingAgendaProposalId(s.proposalId ?? null);
                              setAgendaDrawerOpen(true);
                            }}
                          >
                            <CalendarPlus className="w-3 h-3 mr-1" />Ajouter
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <>
                {/* Metadata */}
                <div className="px-5 py-4 space-y-4">
                  <p className="vb-app-subsection">Informations</p>

                  <div className="space-y-2 text-sm">
                    {/* Titre retenu */}
                    {fullData?.retainedTitle && fullData.retainedTitle !== fullData.originalFilename && (
                      <div className="flex items-start justify-between gap-3">
                        <span className="flex items-center gap-1.5 text-muted-foreground shrink-0"><FileText className="w-3.5 h-3.5" />Titre</span>
                        <div className="flex items-center gap-1">
                          <span className="font-medium text-right text-xs">{fullData.retainedTitle}</span>
                          {fullData.lastAnalysisAt && !fullData.userEditedFields?.retainedTitle && (
                            <Sparkles className="w-2.5 h-2.5 text-[color:var(--accent)] shrink-0" aria-label="Détecté automatiquement" />
                          )}
                        </div>
                      </div>
                    )}
                    {/* Rubrique (classement V2) */}
                    {fullData && rubricTypeLabels(fullData).rubric && (
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Rubrique</span>
                        <span className="font-medium text-xs">{rubricTypeLabels(fullData).rubric}</span>
                      </div>
                    )}
                    {/* Type : toujours le Type V2 enregistré (lot 86E), « Type à compléter » sinon */}
                    {fullData && (
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Type</span>
                        <span className="font-medium text-xs">{rubricTypeLabels(fullData).type}</span>
                      </div>
                    )}
                    {/* Date du document */}
                    {(fullData?.documentDate ?? doc.documentDate) && (
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1.5 text-muted-foreground"><Calendar className="w-3.5 h-3.5" />Date du document</span>
                        <div className="flex items-center gap-1">
                          <span className="font-medium">{fmt(fullData?.documentDate ?? doc.documentDate)}</span>
                          {fullData?.lastAnalysisAt && !fullData?.userEditedFields?.documentDate && (
                            <Sparkles className="w-2.5 h-2.5 text-[color:var(--accent)] shrink-0" aria-label="Détecté automatiquement" />
                          )}
                        </div>
                      </div>
                    )}
                    {/* Fournisseur — name only, no coordinates; click opens SupplierDrawer */}
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-muted-foreground"><User className="w-3.5 h-3.5" />Fournisseur</span>
                      {fullData?.supplier ? (
                        <div className="flex items-center gap-1">
                          <button
                            className="font-medium text-[color:var(--accent)] hover:underline text-sm"
                            onClick={async () => {
                              try {
                                const data = await apiClient.get<{ suppliers: { id: number; name: string }[] }>(
                                  `/api/suppliers?search=${encodeURIComponent(fullData.supplier ?? '')}`
                                );
                                const match = data.suppliers?.[0];
                                if (match) {
                                  setSupplierDrawerId(match.id);
                                  setSupplierDrawerOpen(true);
                                } else {
                                  const created = await apiClient.post<{ supplier: { id: number } }>(
                                    '/api/suppliers',
                                    { name: fullData.supplier, source: 'manual' }
                                  );
                                  setSupplierDrawerId(created.supplier.id);
                                  setSupplierDrawerOpen(true);
                                }
                              } catch {
                                toast.error('Impossible d\'ouvrir la fiche fournisseur');
                              }
                            }}
                          >
                            {fullData.supplier}
                          </button>
                          {fullData.lastAnalysisAt && !fullData.userEditedFields?.supplier && (
                            <Sparkles className="w-2.5 h-2.5 text-[color:var(--accent)] shrink-0" aria-label="Détecté automatiquement" />
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-sm">Non renseigné</span>
                      )}
                    </div>
                    {/* Montant */}
                    {fullData?.amountCents != null && (
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1.5 text-muted-foreground"><Euro className="w-3.5 h-3.5" />Montant</span>
                        <div className="flex items-center gap-1">
                          <span className="font-medium">{fmtAmount(fullData.amountCents)}</span>
                          {fullData.lastAnalysisAt && !fullData.userEditedFields?.amountCents && (
                            <Sparkles className="w-2.5 h-2.5 text-[color:var(--accent)] shrink-0" aria-label="Détecté automatiquement" />
                          )}
                        </div>
                      </div>
                    )}
                    {/* Bien */}
                    {fullData?.assetId && (
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1.5 text-muted-foreground"><Building2 className="w-3.5 h-3.5" />Bien</span>
                        <a href={`/assets/${fullData.assetId}`} className="font-medium text-primary hover:underline text-xs">
                          {assetsList.find(a => a.id === fullData.assetId)?.name ?? `Bien #${fullData.assetId}`}
                        </a>
                      </div>
                    )}
                    {/* Pièce */}
                    {fullData?.substructureId && fullData?.assetId && (
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1.5 text-muted-foreground"><LayoutGrid className="w-3.5 h-3.5" />Pièce</span>
                        <button
                          type="button"
                          className="font-medium text-xs hover:text-primary hover:underline transition-colors"
                          onClick={() => openDrawer({ kind: 'piece', id: fullData.substructureId! }, { stack: true })}
                        >
                          {substructuresList.find(s => s.id === fullData.substructureId)?.name ?? `Pièce #${fullData.substructureId}`}
                        </button>
                      </div>
                    )}
                    {/* Équipement */}
                    {fullData?.equipmentId && fullData?.assetId && (
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1.5 text-muted-foreground"><Wrench className="w-3.5 h-3.5" />Équipement</span>
                        <button
                          type="button"
                          className="font-medium text-xs hover:text-primary hover:underline transition-colors"
                          onClick={() => openDrawer({ kind: 'equipement', id: fullData.equipmentId! }, { stack: true })}
                        >
                          {equipmentsList.find(e => e.id === fullData.equipmentId)?.name ?? `Équipement #${fullData.equipmentId}`}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Description — courte, 2 lignes max */}
                  {fullData?.description && (
                    <div className="pt-1">
                      <p className="vb-app-label mb-1">Description</p>
                      <p className="text-sm text-muted-foreground leading-relaxed line-clamp-2">{fullData.description}</p>
                    </div>
                  )}

                  {/* Notes */}
                  {fullData?.notes && (
                    <div className="pt-1">
                      <p className="vb-app-label mb-1">Notes</p>
                      <p className="text-sm text-muted-foreground leading-relaxed line-clamp-2">{fullData.notes}</p>
                    </div>
                  )}

                  {/* Linked agenda items */}
                  {linkedAgendaItems.length > 0 && (
                    <div className="pt-2 border-t">
                      <p className="vb-app-label mb-2 flex items-center gap-1">
                        <Calendar className="w-3 h-3" />Éléments agenda
                      </p>
                      <EntityCardList>
                        {linkedAgendaItems.map(item => (
                          <EntityCard
                            key={item.id}
                            kind="echeance"
                            id={item.id}
                            title={item.title}
                            meta={item.startDate ? fmt(item.startDate) : undefined}
                            // Tiroir local : sa modification relit la liste ci-dessus.
                            onOpen={() => { void openLinkedAgendaItem(item.id); }}
                            // Lot 86D : détachement individuel (desktop et mobile : cible 44 px sur mobile).
                            actions={(
                              <button type="button" disabled={detachingAgendaId === item.id}
                                onClick={() => garder(() => { void detacherAgenda(item.id); })}
                                aria-label={GROUPING_LABELS.detachItemFromDocument(item.title)} title={GROUPING_LABELS.detach}
                                data-testid={`document-detacher-agenda-${item.id}`}
                                className="inline-flex size-11 sm:size-8 items-center justify-center rounded-[10px] text-[color:var(--text-muted)] hover:bg-[color:var(--danger-soft)] hover:text-[color:var(--danger)] disabled:opacity-40">
                                {detachingAgendaId === item.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Unlink className="w-3.5 h-3.5" aria-hidden />}
                              </button>
                            )}
                            badges={loadingAgendaItem === item.id ? (
                              <Loader2 className="w-3 h-3 animate-spin shrink-0 text-muted-foreground" />
                            ) : (<>
                              {agendaLinkInfo.get(item.id)?.isMain && agendaLinkInfo.get(item.id)?.viaGroup && (
                                <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[color:var(--accent-soft)] text-[color:var(--accent)]">{GROUPING_LABELS.mainBadge}</span>
                              )}
                              {agendaLinkInfo.get(item.id)?.direct && agendaLinkInfo.get(item.id)?.viaGroup && (
                                <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">{GROUPING_LABELS.directLink}</span>
                              )}
                              <span className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                                item.effectiveStatus === 'realise' ? 'bg-[color:var(--bg-success)] text-[color:var(--text-success)]' :
                                item.effectiveStatus === 'annule' ? 'bg-muted text-muted-foreground' :
                                item.effectiveStatus === 'en_retard' ? 'bg-[color:var(--danger-soft)] text-[color:var(--danger)]' :
                                item.effectiveStatus === 'a_confirmer' ? 'bg-[color:var(--attention-soft)] text-[color:var(--attention-on-soft)]' :
                                'bg-primary/10 text-primary'
                              }`}>
                                {item.effectiveStatus === 'aujourd_hui' ? "Aujourd'hui" : effectiveStatusLabel(item.effectiveStatus || 'a_venir')}
                              </span>
                            </>)}
                          />
                        ))}
                      </EntityCardList>
                    </div>
                  )}

                  {/* Lot 84B (§8.1, AC01) : lien manuel vers un élément d'agenda — le document rejoint son ensemble. */}
                  <div className={linkedAgendaItems.length > 0 ? 'pt-1' : 'pt-2 border-t'}>
                    <Button type="button" variant="secondary" size="sm" className="min-h-11 sm:min-h-8"
                      onClick={() => garder(() => setAgendaPickerOpen(true))} data-testid="document-relier-agenda">
                      <Calendar className="w-3.5 h-3.5" aria-hidden />{GROUPING_LABELS.documentAgendaTitle}
                    </Button>
                  </div>

                  {/* Agenda suggestions from AI */}
                  {agendaSuggestions.length > 0 && (
                    <div className="pt-2">
                      <p className="vb-app-label mb-2 flex items-center gap-1">
                        <CalendarPlus className="w-3 h-3" />Suggestions agenda
                      </p>
                      <div className="space-y-1.5">
                        {agendaSuggestions.map((s, i) => (
                          <div key={i} className="flex items-center justify-between gap-2 bg-primary/5 rounded-lg px-3 py-2 text-xs">
                            <div className="flex-1 min-w-0">
                              <p className="font-medium truncate">{s.label}</p>
                              {s.dateValue && <p className="text-muted-foreground">{fmt(s.dateValue)}</p>}
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-xs shrink-0"
                              onClick={() => {
                                setAgendaPrefill({ title: s.label, startDate: s.dateValue ?? '' });
                                setPendingAgendaProposalId(s.proposalId ?? null);
                                setAgendaDrawerOpen(true);
                              }}
                            >
                              <CalendarPlus className="w-3 h-3 mr-1" />Ajouter
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <Separator />

                {/* Action bar — sans bouton Analyser (auto-analyse) */}
                <div className="px-5 py-4">
                  <div className="flex items-stretch rounded-xl border border-border bg-muted/30 overflow-hidden">
                    <button
                      className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-muted/60 transition-colors text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                      onClick={() => viewUrl && window.open(viewUrl, '_blank', 'noopener,noreferrer')}
                      disabled={!viewUrl || isLoadingPreview}
                    >
                      <ExternalLink className="w-4 h-4" />
                      <span className="text-[12px] font-semibold">Ouvrir</span>
                    </button>
                    <div className="w-px bg-border" />
                    <button
                      className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-muted/60 transition-colors text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                      onClick={enterEditMode}
                      disabled={isLoadingPreview || !fullData}
                    >
                      <Pencil className="w-4 h-4" />
                      <span className="text-[12px] font-semibold">Modifier</span>
                    </button>
                    <div className="w-px bg-border" />
                    <button
                      className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-muted/60 transition-colors text-foreground"
                      onClick={handleDownload}
                    >
                      <Download className="w-4 h-4" />
                      <span className="text-[12px] font-semibold">Télécharger</span>
                    </button>
                    <div className="w-px bg-border" />
                    <button
                      className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-destructive/10 transition-colors text-destructive disabled:opacity-40"
                      onClick={() => setShowDeleteConfirm(true)}
                      disabled={isDeleting}
                    >
                      <Trash2 className="w-4 h-4" />
                      <span className="text-[12px] font-semibold">Supprimer</span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Footer in edit mode */}
          {isEditing && (
            <div className="px-5 py-4 border-t">
              <div className="flex items-stretch rounded-xl border border-border bg-muted/30 overflow-hidden">
                <button
                  type="button"
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-muted/60 transition-colors text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={() => setIsEditing(false)}
                  disabled={isSaving}
                >
                  <X className="w-4 h-4" />
                  <span className="text-[12px] font-semibold">Annuler</span>
                </button>
                <div className="w-px bg-border" />
                <button
                  type="button"
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-primary/10 transition-colors text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={handleSave}
                  disabled={isSaving}
                >
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  <span className="text-[12px] font-semibold">{isSaving ? 'Sauvegarde…' : 'Enregistrer'}</span>
                </button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer le document ?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{filename}&quot; sera définitivement supprimé. Cette action est irréversible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Supprimer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CreateAgendaItemDrawer
        open={agendaDrawerOpen}
        onClose={() => { setAgendaDrawerOpen(false); setPendingAgendaProposalId(null); }}
        onMutated={() => {
          setAgendaDrawerOpen(false);
          // Mark the proposal as rejected so the suggestion never comes back, even if the user renamed it
          if (pendingAgendaProposalId && doc) {
            fetch(`/api/documents/${doc.id}/analysis-proposals`, {
      credentials: 'include',
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json'},
              body: JSON.stringify({ proposalId: pendingAgendaProposalId, action: 'reject' }),
            }).catch(() => {});
            setAgendaSuggestions(prev => prev.filter(s => s.proposalId !== pendingAgendaProposalId));
            setPendingAgendaProposalId(null);
          }
          // Refresh linked agenda items
          if (doc) {
            fetch(`/api/agenda?fileId=${doc.id}&period=all&includeCancelled=false`, { credentials: 'include' })
              .then(r => r.ok ? r.json() : null)
              .then(data => { if (data?.items) setLinkedAgendaItems(data.items.map((i: any) => ({ id: i.id, title: i.title, startDate: i.startDate ?? null, effectiveStatus: i.effectiveStatus }))); })
              .catch(() => {});
          }
          onRefresh();
        }}
        prefilledAssetId={fullData?.assetId ?? doc.assetId ?? undefined}
        prefilledFileId={doc.id}
        prefilledSubstructureId={fullData?.substructureId ?? undefined}
        prefilledEquipmentId={fullData?.equipmentId ?? undefined}
        prefilledTitle={agendaPrefill.title || undefined}
        prefilledStartDate={agendaPrefill.startDate || undefined}
      />

      <GroupingPicker
        open={agendaPickerOpen}
        title={GROUPING_LABELS.documentAgendaTitle}
        load={loadAgendaCandidates}
        onClose={() => setAgendaPickerOpen(false)}
        onPick={(c) => { setAgendaPickerOpen(false); void relierAgenda(c.id); }}
      />

      {/* Agenda item sub-drawer */}
      {agendaDrawerItem && (
        <AgendaItemDrawer
          open={!!agendaDrawerItem}
          item={agendaDrawerItem}
          onClose={() => setAgendaDrawerItem(null)}
          onMutated={() => {
            setAgendaDrawerItem(null);
            // Refresh linked agenda items list
            if (doc) {
              fetch(`/api/agenda?fileId=${doc.id}&period=all&includeCancelled=true`, { credentials: 'include' })
                .then(r => r.ok ? r.json() : null)
                .then(data => { if (data?.items) setLinkedAgendaItems(data.items.map((i: any) => ({ id: i.id, title: i.title, startDate: i.startDate ?? null, effectiveStatus: i.effectiveStatus }))); })
                .catch(() => {});
            }
            onRefresh();
          }}
        />
      )}

      {/* Supplier drawer — opened by clicking supplier name in view mode */}
      <SupplierDrawer
        supplierId={supplierDrawerId}
        open={supplierDrawerOpen}
        onOpenChange={setSupplierDrawerOpen}
        onUpdated={() => {}}
      />
    </>
  );
}
