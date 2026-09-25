"use client"

/**
 * Documents (vue transverse) — métadonnées seulement.
 *
 * CDC Back-Office V1 SEC-001 / REC-ACC-07 : l'administrateur ne peut jamais
 * ouvrir, prévisualiser ni télécharger le contenu d'un document d'un autre
 * compte — l'action « Télécharger » est retirée. SEC-003 / GEN-001 : ni
 * modification, ni changement de bien, ni suppression depuis le BO.
 */

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Search, FileIcon, Image, FileText,
  AlertCircle, Clock, CheckCircle2, XCircle, MoreHorizontal, Database, Brain, Calendar, Tag, Hash, FileType2, User,
  Sparkles, LinkIcon, Copy, Check,
} from 'lucide-react';
import Link from 'next/link';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AdminDocument {
  // Identity
  id: number;
  publicId: string;
  filename: string;
  originalFilename: string;
  mimeType: string;
  fileExtension: string | null;
  size: number;
  sha256Hash: string | null;

  // Storage
  s3Key: string | null;
  s3Bucket: string | null;
  s3Region: string | null;

  // Status
  uploadStatus: string;
  uploadedAt: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;

  // Classification
  documentType: string;
  documentDate: string | null;
  scope: string;
  isDraft: boolean;
  isIgnored: boolean;
  isWebLink: boolean;
  webLinkUrl: string | null;
  webLinkTitle: string | null;

  // Metadata
  description: string | null;
  supplier: string | null;
  amountCents: number | null;
  notes: string | null;

  // AI fields
  retainedTitle: string | null;
  retainedFunctionCode: string | null;
  cilRubricCodes: string[] | null;
  extractedText: string | null;
  lastAnalysisAt: string | null;

  // Relations
  userId: number;
  accountId: number;
  assetId: number | null;
  linkedAssetId: number | null;
  linkedRoomId: number | null;
  substructureId: number | null;
  equipmentId: number | null;

  // Joined
  user: { id: number; email: string; firstName: string; lastName: string } | null;
  asset: { id: number; name: string; category: string } | null;
}

interface User {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
}

interface Asset {
  id: number;
  name: string;
  userId: number;
}

interface DocumentType {
  id: number;
  code: string;
  label: string;
  isActive: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CANONICAL_FUNCTION_LABELS: Record<string, string> = {
  PHOTO_BIEN: 'Photo du bien',
  ASSURANCE: 'Assurance',
  CONTRAT: 'Contrat',
  GARANTIE: 'Garantie',
  ENTRETIEN_INTERVENTION: 'Entretien / Intervention',
  CONTROLE_CONFORMITE: 'Contrôle / Conformité',
  TRAVAUX_INSTALLATION: 'Travaux / Installation',
  ACHAT_JUSTIFICATIF: 'Achat / Justificatif',
  DOCUMENT_ADMINISTRATIF: 'Document administratif',
  SINISTRE_INCIDENT: 'Sinistre / Incident',
  FINANCEMENT: 'Financement',
  AUTRE: 'Autre',
};

const FORMAT_OPTIONS = [
  { value: 'all', label: 'Tous les formats' },
  { value: 'pdf', label: 'PDF' },
  { value: 'image', label: 'Images' },
  { value: 'word', label: 'Word' },
  { value: 'excel', label: 'Excel' },
  { value: 'other', label: 'Autre' },
];

const SORT_OPTIONS = [
  { value: 'uploadedAt_desc', label: "Date d'ajout (↓)" },
  { value: 'uploadedAt_asc', label: "Date d'ajout (↑)" },
  { value: 'originalFilename_asc', label: 'Nom (A-Z)' },
  { value: 'originalFilename_desc', label: 'Nom (Z-A)' },
  { value: 'size_desc', label: 'Taille (↓)' },
  { value: 'size_asc', label: 'Taille (↑)' },
];

const UPLOAD_STATUS_CONFIG = {
  PENDING: { label: 'En attente', icon: Clock, color: 'text-yellow-500' },
  COMPLETED: { label: 'Complété', icon: CheckCircle2, color: 'text-green-500' },
  FAILED: { label: 'Échoué', icon: XCircle, color: 'text-red-500' },
};

// ─── Detail field helpers ─────────────────────────────────────────────────────

function DetailRow({ label, value, mono = false, wrap = false }: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  wrap?: boolean;
}) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="flex gap-3 py-2 border-b border-[color:var(--border-subtle)] last:border-0">
      <span className="text-xs text-[color:var(--text-muted)] w-36 shrink-0 pt-0.5">{label}</span>
      <span className={`text-xs flex-1 min-w-0 ${mono ? 'font-mono break-all' : ''} ${wrap ? 'whitespace-pre-wrap break-words' : 'truncate'} text-[color:var(--text-primary)]`}>
        {value}
      </span>
    </div>
  );
}

function SectionTitle({ icon: Icon, label }: { icon: React.ElementType; label: string }) {
  return (
    <div className="flex items-center gap-2 pt-4 pb-1">
      <Icon className="w-3.5 h-3.5 text-[#a78bfa]" />
      <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">{label}</span>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={handleCopy}
      className="ml-1 p-0.5 rounded hover:bg-[color:var(--bg-hover)] transition-colors shrink-0"
      title="Copier"
    >
      {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-[color:var(--text-muted)]" />}
    </button>
  );
}

// ─── Document Detail Sheet ────────────────────────────────────────────────────

function DocumentDetailSheet({
  doc,
  open,
  onClose,
  getDocumentTypeLabel,
}: {
  doc: AdminDocument | null;
  open: boolean;
  onClose: () => void;
  getDocumentTypeLabel: (code: string) => string;
}) {
  if (!doc) return null;

  const formatDate = (d: string | null) => {
    if (!d) return null;
    try {
      return new Date(d).toLocaleString('fr-FR', {
        day: 'numeric', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch { return d; }
  };

  const formatBytes = (n: number) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  };

  const formatMoney = (cents: number | null) => {
    if (cents === null) return null;
    return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
  };

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-lg overflow-y-auto bg-[color:var(--bg-page)] border-l border-[color:var(--border-subtle)] p-0"
      >
        {/* Header */}
        <SheetHeader className="px-5 py-4 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] sticky top-0 z-10">
          <SheetTitle className="flex items-center gap-2 text-sm font-semibold text-[color:var(--text-primary)]">
            <Database className="w-4 h-4 text-[#a78bfa]" />
            Données complètes — document #{doc.id}
          </SheetTitle>
          <p className="text-xs text-[color:var(--text-muted)] truncate mt-0.5">{doc.originalFilename}</p>
        </SheetHeader>

        <div className="px-5 pb-8">
          {/* ── Identity ── */}
          <SectionTitle icon={Hash} label="Identité" />
          <div>
            <DetailRow label="ID (interne)" value={
              <span className="flex items-center gap-1 font-mono">{doc.id}<CopyButton value={String(doc.id)} /></span>
            } />
            <DetailRow label="UUID public" value={
              <span className="flex items-center gap-1 font-mono text-[10px]">{doc.publicId}<CopyButton value={doc.publicId} /></span>
            } />
            <DetailRow label="Nom original" value={doc.originalFilename} />
            <DetailRow label="Nom stocké" value={doc.filename} mono />
            <DetailRow label="Extension" value={doc.fileExtension} />
            <DetailRow label="MIME type" value={doc.mimeType} mono />
            <DetailRow label="Taille" value={formatBytes(doc.size)} />
            <DetailRow label="SHA-256" value={
              doc.sha256Hash
                ? <span className="flex items-center gap-1 font-mono text-[10px]">{doc.sha256Hash}<CopyButton value={doc.sha256Hash} /></span>
                : null
            } />
          </div>

          {/* ── Storage ── */}
          {(doc.s3Key || doc.s3Bucket) && (
            <>
              <SectionTitle icon={Database} label="Stockage S3" />
              <div>
                <DetailRow label="Bucket" value={doc.s3Bucket} mono />
                <DetailRow label="Clé S3" value={doc.s3Key} mono wrap />
                <DetailRow label="Région" value={doc.s3Region} mono />
              </div>
            </>
          )}

          {/* ── Web link ── */}
          {doc.isWebLink && (
            <>
              <SectionTitle icon={LinkIcon} label="Lien web" />
              <div>
                <DetailRow label="URL" value={doc.webLinkUrl} wrap />
                <DetailRow label="Titre" value={doc.webLinkTitle} />
              </div>
            </>
          )}

          {/* ── Status & dates ── */}
          <SectionTitle icon={Calendar} label="Statut et dates" />
          <div>
            <DetailRow label="Statut upload" value={
              <Badge variant={doc.uploadStatus === 'COMPLETED' ? 'default' : doc.uploadStatus === 'FAILED' ? 'destructive' : 'secondary'} className="text-[10px] h-4">
                {doc.uploadStatus}
              </Badge>
            } />
            <DetailRow label="Date document" value={doc.documentDate ? new Date(doc.documentDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : null} />
            <DetailRow label="Uploadé le" value={formatDate(doc.uploadedAt)} />
            <DetailRow label="Créé le" value={formatDate(doc.createdAt)} />
            <DetailRow label="Mis à jour le" value={formatDate(doc.updatedAt)} />
            <DetailRow label="Supprimé le" value={doc.deletedAt ? <span className="text-red-500">{formatDate(doc.deletedAt)}</span> : null} />
            <DetailRow label="Dernière analyse IA" value={formatDate(doc.lastAnalysisAt)} />
          </div>

          {/* ── Classification ── */}
          <SectionTitle icon={Tag} label="Classification" />
          <div>
            <DetailRow label="Type document" value={`${getDocumentTypeLabel(doc.documentType)} (${doc.documentType})`} />
            <DetailRow label="Portée" value={doc.scope} />
            <DetailRow label="Brouillon" value={doc.isDraft ? 'Oui' : null} />
            <DetailRow label="Ignoré" value={doc.isIgnored ? 'Oui' : null} />
          </div>

          {/* ── AI fields ── */}
          <SectionTitle icon={Brain} label="Analyse IA" />
          <div>
            <DetailRow label="Titre retenu" value={doc.retainedTitle} />
            <DetailRow label="Fonction" value={
              doc.retainedFunctionCode
                ? `${CANONICAL_FUNCTION_LABELS[doc.retainedFunctionCode] ?? doc.retainedFunctionCode} (${doc.retainedFunctionCode})`
                : null
            } />
            <DetailRow label="Rubriques CIL" value={doc.cilRubricCodes?.join(', ') || null} />
            <DetailRow label="Description" value={doc.description} wrap />
            <DetailRow label="Fournisseur" value={doc.supplier} />
            <DetailRow label="Montant" value={formatMoney(doc.amountCents)} />
            <DetailRow label="Notes" value={doc.notes} wrap />
          </div>

          {/* ── Extracted text ── */}
          {doc.extractedText && (
            <>
              <SectionTitle icon={FileType2} label="Description interne détaillée (indexation)" />
              <div className="mt-1 p-3 rounded-lg bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] text-xs text-[color:var(--text-secondary)] leading-relaxed whitespace-pre-wrap break-words max-h-48 overflow-y-auto font-mono">
                {doc.extractedText}
              </div>
            </>
          )}

          {/* ── Relations ── */}
          <SectionTitle icon={User} label="Relations" />
          <div>
            <DetailRow label="User ID" value={
              <span className="flex items-center gap-1 font-mono">{doc.userId}<CopyButton value={String(doc.userId)} /></span>
            } />
            {doc.user && (
              <DetailRow label="Utilisateur" value={
                <Link href={`/admin/users/${doc.user.id}`} className="text-[#3b82f6] hover:underline">
                  {doc.user.firstName} {doc.user.lastName} ({doc.user.email})
                </Link>
              } />
            )}
            <DetailRow label="Account ID" value={
              <span className="font-mono">{doc.accountId}</span>
            } />
            <DetailRow label="Asset ID" value={
              doc.assetId != null
                ? <span className="flex items-center gap-1 font-mono">{doc.assetId}<CopyButton value={String(doc.assetId)} /></span>
                : null
            } />
            {doc.asset && (
              <DetailRow label="Bien" value={
                <Link href={`/admin/assets/${doc.asset.id}`} className="text-[#3b82f6] hover:underline">
                  {doc.asset.name} ({doc.asset.category})
                </Link>
              } />
            )}
            <DetailRow label="Asset lié (ID)" value={doc.linkedAssetId != null ? <span className="font-mono">{doc.linkedAssetId}</span> : null} />
            <DetailRow label="Pièce liée (ID)" value={doc.linkedRoomId != null ? <span className="font-mono">{doc.linkedRoomId}</span> : null} />
            <DetailRow label="Sous-structure (ID)" value={doc.substructureId != null ? <span className="font-mono">{doc.substructureId}</span> : null} />
            <DetailRow label="Équipement (ID)" value={doc.equipmentId != null ? <span className="font-mono">{doc.equipmentId}</span> : null} />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function AdminDocumentsPage() {
  const [documents, setDocuments] = useState<AdminDocument[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [documentTypes, setDocumentTypes] = useState<DocumentType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [userFilter, setUserFilter] = useState<string>('all');
  const [assetFilter, setAssetFilter] = useState<string>('all');
  const [formatFilter, setFormatFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [sortOption, setSortOption] = useState<string>('uploadedAt_desc');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [page, setPage] = useState(1);
  const limit = 50;

  // Detail sheet
  const [detailDoc, setDetailDoc] = useState<AdminDocument | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const getDocumentTypeLabel = (code: string): string => {
    const dt = documentTypes.find(d => d.code === code);
    return dt?.label || code;
  };

  useEffect(() => {
    loadUsers();
    loadAssets();
    loadDocumentTypes();
  }, []);

  useEffect(() => {
    loadDocuments();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, userFilter, assetFilter, formatFilter, typeFilter, sortOption, includeDeleted, page]);


  const loadUsers = async () => {
    try {
      const res = await fetch('/api/admin/users', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      setUsers(data.data || data.users || []);
    } catch { /* ignore */ }
  };

  const loadAssets = async () => {
    try {
      const res = await fetch('/api/admin/assets', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      setAssets(data.assets || data.data || []);
    } catch { /* ignore */ }
  };

  const loadDocumentTypes = async () => {
    try {
      const res = await fetch('/api/admin/document-types', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      setDocumentTypes(data);
    } catch { /* ignore */ }
  };

  const loadDocuments = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const params = new URLSearchParams({ limit: limit.toString(), includeDeleted: includeDeleted.toString() });
      if (search) params.append('search', search);
      if (userFilter !== 'all') params.append('userId', userFilter);
      if (assetFilter !== 'all') params.append('assetId', assetFilter);

      const res = await fetch(`/api/admin/files?${params}`, {
      credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error('Erreur lors du chargement des documents');

      const result = await res.json();
      let docs: AdminDocument[] = result.data || result;
      if (!Array.isArray(docs)) docs = [];

      if (formatFilter !== 'all') docs = docs.filter(d => matchesFormat(d.originalFilename, formatFilter));
      if (typeFilter !== 'all') docs = docs.filter(d => d.documentType === typeFilter);
      docs = applySorting(docs, sortOption);
      setDocuments(docs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsLoading(false);
    }
  };

  const matchesFormat = (fileName: string, format: string): boolean => {
    const ext = getFileExtension(fileName).toLowerCase();
    switch (format) {
      case 'pdf': return ext === 'pdf';
      case 'image': return ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext);
      case 'word': return ['doc', 'docx'].includes(ext);
      case 'excel': return ['xls', 'xlsx', 'csv'].includes(ext);
      case 'other': return !['pdf', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'doc', 'docx', 'xls', 'xlsx', 'csv'].includes(ext);
      default: return true;
    }
  };

  const applySorting = (docs: AdminDocument[], sortOpt: string): AdminDocument[] => {
    const [field, direction] = sortOpt.split('_');
    return [...docs].sort((a, b) => {
      let aVal: number | string, bVal: number | string;
      if (field === 'uploadedAt') { aVal = new Date(a.uploadedAt).getTime(); bVal = new Date(b.uploadedAt).getTime(); }
      else if (field === 'originalFilename') { aVal = a.originalFilename.toLowerCase(); bVal = b.originalFilename.toLowerCase(); }
      else { aVal = a.size; bVal = b.size; }
      if (direction === 'asc') return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
    });
  };

  const formatDate = (d: string) =>
    new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const getFileIcon = (mimeType: string) => {
    if (mimeType?.startsWith('image/')) return <Image className="h-5 w-5 text-blue-500" />;
    if (mimeType === 'application/pdf') return <FileText className="h-5 w-5 text-red-500" />;
    if (mimeType?.includes('document') || mimeType?.includes('word')) return <FileText className="h-5 w-5 text-blue-600" />;
    if (mimeType?.includes('sheet') || mimeType?.includes('excel')) return <FileText className="h-5 w-5 text-green-600" />;
    return <FileIcon className="h-5 w-5 text-muted-foreground" />;
  };

  const getFileExtension = (fileName: string): string => {
    const parts = (fileName || '').split('.');
    return parts.length > 1 ? parts[parts.length - 1] : '';
  };

  const getUploadStatusBadge = (status: string) => {
    const config = UPLOAD_STATUS_CONFIG[status as keyof typeof UPLOAD_STATUS_CONFIG] || { label: status, icon: AlertCircle, color: 'text-muted-foreground' };
    const Icon = config.icon;
    return (
      <Badge variant={status === 'COMPLETED' ? 'default' : status === 'FAILED' ? 'destructive' : 'secondary'} className="gap-1">
        <Icon className={`h-3 w-3 ${config.color}`} />
        {config.label}
      </Badge>
    );
  };

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <p className="text-center text-destructive">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl md:text-3xl font-bold">Gestion des documents</h1>
        <p className="text-muted-foreground mt-1">
          Liste complète de tous les documents uploadés sur la plateforme ({documents.length})
        </p>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Filtres</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <div className="relative">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Rechercher un document..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                className="pl-9"
              />
            </div>

            <Select value={userFilter} onValueChange={setUserFilter}>
              <SelectTrigger><SelectValue placeholder="Tous les utilisateurs" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les utilisateurs</SelectItem>
                {users.map(u => <SelectItem key={u.id} value={u.id.toString()}>{u.firstName} {u.lastName}</SelectItem>)}
              </SelectContent>
            </Select>

            <Select value={assetFilter} onValueChange={setAssetFilter}>
              <SelectTrigger><SelectValue placeholder="Tous les biens" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les biens</SelectItem>
                {assets.map(a => <SelectItem key={a.id} value={a.id.toString()}>{a.name}</SelectItem>)}
              </SelectContent>
            </Select>

            <Select value={formatFilter} onValueChange={setFormatFilter}>
              <SelectTrigger><SelectValue placeholder="Tous les formats" /></SelectTrigger>
              <SelectContent>
                {FORMAT_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>

            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger><SelectValue placeholder="Tous les types" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les types</SelectItem>
                {documentTypes.map(dt => <SelectItem key={dt.code} value={dt.code}>{dt.label}</SelectItem>)}
              </SelectContent>
            </Select>

            <Select value={sortOption} onValueChange={setSortOption}>
              <SelectTrigger><SelectValue placeholder="Trier par..." /></SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="includeDeleted"
                checked={includeDeleted}
                onChange={(e) => { setIncludeDeleted(e.target.checked); setPage(1); }}
                className="h-4 w-4 rounded border-gray-300"
              />
              <label htmlFor="includeDeleted" className="text-sm font-medium">Inclure les supprimés</label>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Documents list */}
      <Card>
        <CardHeader>
          <CardTitle>Documents ({documents.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-24" />)}
            </div>
          ) : documents.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">Aucun document trouvé</div>
          ) : (
            <div className="space-y-2">
              {documents.map((doc) => (
                <div
                  key={doc.id}
                  className={`flex items-start gap-3 p-3.5 rounded-lg border transition-colors ${
                    doc.deletedAt ? 'bg-muted/50 opacity-60' : 'hover:bg-muted/30'
                  }`}
                >
                  {/* Icon */}
                  <div className="shrink-0 mt-0.5">{getFileIcon(doc.mimeType)}</div>

                  {/* Main info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="font-medium text-sm truncate max-w-xs">{doc.originalFilename}</span>
                      {getUploadStatusBadge(doc.uploadStatus)}
                      <Badge variant="outline" className="text-[10px] h-4">{getDocumentTypeLabel(doc.documentType)}</Badge>
                      {doc.retainedFunctionCode && (
                        <Badge variant="outline" className="text-[10px] h-4 border-[#a78bfa]/40 text-[#a78bfa] gap-0.5">
                          <Sparkles className="w-2.5 h-2.5" />
                          {CANONICAL_FUNCTION_LABELS[doc.retainedFunctionCode] ?? doc.retainedFunctionCode}
                        </Badge>
                      )}
                      {doc.deletedAt && <Badge variant="destructive" className="text-[10px] h-4">Supprimé</Badge>}
                    </div>

                    <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      <span>{formatFileSize(doc.size)}</span>
                      <span>·</span>
                      <span>{formatDate(doc.uploadedAt)}</span>
                      {doc.user && (
                        <>
                          <span>·</span>
                          <Link href={`/admin/users/${doc.user.id}`} className="text-primary hover:underline truncate max-w-[180px]">
                            {doc.user.firstName} {doc.user.lastName}
                          </Link>
                        </>
                      )}
                      {doc.asset && (
                        <>
                          <span>·</span>
                          <Link href={`/admin/assets/${doc.asset.id}`} className="text-primary hover:underline truncate max-w-[150px]">
                            {doc.asset.name}
                          </Link>
                        </>
                      )}
                      {doc.retainedTitle && (
                        <>
                          <span>·</span>
                          <span className="italic truncate max-w-[200px]">{doc.retainedTitle}</span>
                        </>
                      )}
                    </div>

                    {doc.uploadStatus === 'FAILED' && (
                      <div className="flex items-center gap-1.5 text-destructive text-xs mt-1">
                        <AlertCircle className="h-3.5 w-3.5" />
                        <span>Upload échoué</span>
                      </div>
                    )}
                    {doc.deletedAt && (
                      <p className="text-xs text-destructive mt-1">Supprimé le {formatDate(doc.deletedAt)}</p>
                    )}
                  </div>

                  {/* Actions dropdown */}
                  <div className="shrink-0">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        {/* Always: view details */}
                        <DropdownMenuItem
                          onClick={() => { setDetailDoc(doc); setDetailOpen(true); }}
                          className="gap-2"
                        >
                          <Database className="h-4 w-4 text-[#a78bfa]" />
                          Voir les données DB
                        </DropdownMenuItem>

                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Detail Sheet ── */}
      <DocumentDetailSheet
        doc={detailDoc}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        getDocumentTypeLabel={getDocumentTypeLabel}
      />

    </div>
  );
}
