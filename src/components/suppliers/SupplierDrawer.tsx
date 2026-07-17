"use client";

import { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Building2, Mail, Phone, Globe, MapPin, FileText, Pencil, X,
  Loader2, AlertTriangle, CheckCircle2, HelpCircle, Archive, ChevronRight, Check,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import type { DocumentDrawerItem } from '@/components/assets/DocumentDrawer';

const DocumentDrawer = dynamic(
  () => import('@/components/assets/DocumentDrawer').then(m => ({ default: m.DocumentDrawer })),
  { ssr: false }
);

// ─── Types ────────────────────────────────────────────────────────────────────

interface SupplierDoc {
  documentId: number;
  role: string | null;
  isConfirmed: boolean;
  filename: string | null;
  documentType: string | null;
  documentDate: string | null;
  assetId: number | null;
  assetName: string | null;
}

interface ReviewItem {
  id: number;
  publicId: string;
  itemType: string;
  conflictingField: string | null;
  currentValue: string | null;
  detectedValue: string | null;
  detectedName: string | null;
  documentId: number | null;
  status: string;
}

export interface SupplierData {
  id: number;
  publicId: string;
  name: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  siren: string | null;
  siret: string | null;
  vatNumber: string | null;
  iban: string | null;
  ibanHolderName: string | null;
  source: string;
  contactStatus: string;
  status: string;
  scope: string;
}

interface Props {
  supplierId: number | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onUpdated?: () => void;
}

const CONTACT_STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  unverified: { label: 'Non vérifié', color: 'text-[#f59e0b] bg-[#f59e0b]/10 border-[#f59e0b]/30', icon: <HelpCircle className="w-3 h-3" /> },
  partially_verified: { label: 'Partiellement vérifié', color: 'text-[#3b82f6] bg-[#3b82f6]/10 border-[#3b82f6]/30', icon: <CheckCircle2 className="w-3 h-3" /> },
  verified: { label: 'Vérifié', color: 'text-[#22c55e] bg-[#22c55e]/10 border-[#22c55e]/30', icon: <CheckCircle2 className="w-3 h-3" /> },
};

const SOURCE_CONFIG: Record<string, { label: string; color: string }> = {
  manual: { label: 'Saisie manuelle', color: 'text-[color:var(--text-muted)] bg-[rgba(255,255,255,0.05)] border-[color:var(--border-subtle)]' },
  document_extraction: { label: 'Extraction IA', color: 'text-[#8b5cf6] bg-[#8b5cf6]/10 border-[#8b5cf6]/30' },
  imported: { label: 'Importé', color: 'text-[#3b82f6] bg-[#3b82f6]/10 border-[#3b82f6]/30' },
};

const CONFLICT_FIELD_LABELS: Record<string, string> = {
  email: 'Email',
  phone: 'Téléphone',
  website: 'Site web',
  addressLine1: 'Adresse',
  postalCode: 'Code postal',
  city: 'Ville',
  country: 'Pays',
  siren: 'SIREN',
  siret: 'SIRET',
  vatNumber: 'N° TVA',
  iban: 'IBAN',
  ibanHolderName: 'Titulaire IBAN',
};

export function SupplierDrawer({ supplierId, open, onOpenChange, onUpdated }: Props) {
  const [loading, setLoading] = useState(false);
  const [supplier, setSupplier] = useState<SupplierData | null>(null);
  const [documents, setDocuments] = useState<SupplierDoc[]>([]);
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [hasUnsaved, setHasUnsaved] = useState(false);
  const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false);
  const [docDrawerItem, setDocDrawerItem] = useState<DocumentDrawerItem | null>(null);
  const [docDrawerOpen, setDocDrawerOpen] = useState(false);

  // Edit state
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editWebsite, setEditWebsite] = useState('');
  const [editAddressLine1, setEditAddressLine1] = useState('');
  const [editAddressLine2, setEditAddressLine2] = useState('');
  const [editPostalCode, setEditPostalCode] = useState('');
  const [editCity, setEditCity] = useState('');
  const [editCountry, setEditCountry] = useState('');
  const [editSiren, setEditSiren] = useState('');
  const [editSiret, setEditSiret] = useState('');
  const [editVatNumber, setEditVatNumber] = useState('');
  const [editIban, setEditIban] = useState('');
  const [editIbanHolderName, setEditIbanHolderName] = useState('');

  const loadSupplier = useCallback(async () => {
    if (!supplierId) return;
    setLoading(true);
    try {
      const data = await apiClient.get<{ supplier: SupplierData; documents: SupplierDoc[]; reviewItems: ReviewItem[] }>(
        `/api/suppliers/${supplierId}`
      );
      setSupplier(data.supplier);
      setDocuments(data.documents ?? []);
      setReviewItems(data.reviewItems ?? []);
    } catch {
      toast.error('Impossible de charger le fournisseur');
    } finally {
      setLoading(false);
    }
  }, [supplierId]);

  useEffect(() => {
    if (open && supplierId) {
      loadSupplier();
      setEditing(false);
      setHasUnsaved(false);
    }
  }, [open, supplierId, loadSupplier]);

  const enterEdit = () => {
    if (!supplier) return;
    setEditName(supplier.name ?? '');
    setEditEmail(supplier.email ?? '');
    setEditPhone(supplier.phone ?? '');
    setEditWebsite(supplier.website ?? '');
    setEditAddressLine1(supplier.addressLine1 ?? '');
    setEditAddressLine2(supplier.addressLine2 ?? '');
    setEditPostalCode(supplier.postalCode ?? '');
    setEditCity(supplier.city ?? '');
    setEditCountry(supplier.country ?? '');
    setEditSiren(supplier.siren ?? '');
    setEditSiret(supplier.siret ?? '');
    setEditVatNumber(supplier.vatNumber ?? '');
    setEditIban(supplier.iban ?? '');
    setEditIbanHolderName(supplier.ibanHolderName ?? '');
    setEditing(true);
    setHasUnsaved(false);
  };

  const handleSave = async () => {
    if (!supplier) return;
    setSaving(true);
    try {
      await apiClient.patch(`/api/suppliers/${supplier.id}`, {
        name: editName,
        email: editEmail || null,
        phone: editPhone || null,
        website: editWebsite || null,
        addressLine1: editAddressLine1 || null,
        addressLine2: editAddressLine2 || null,
        postalCode: editPostalCode || null,
        city: editCity || null,
        country: editCountry || null,
        siren: editSiren || null,
        siret: editSiret || null,
        vatNumber: editVatNumber || null,
        iban: editIban || null,
        ibanHolderName: editIbanHolderName || null,
      });
      toast.success('Fournisseur enregistré');
      setEditing(false);
      setHasUnsaved(false);
      await loadSupplier();
      onUpdated?.();
    } catch {
      toast.error('Erreur lors de l\'enregistrement');
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async () => {
    if (!supplier) return;
    try {
      await apiClient.post(`/api/suppliers/${supplier.id}/archive`, {});
      toast.success('Fournisseur archivé');
      onOpenChange(false);
      onUpdated?.();
    } catch {
      toast.error('Erreur lors de l\'archivage');
    }
  };

  const handleResolveConflict = async (reviewItemId: number, resolution: 'keep_current' | 'use_detected' | 'ignored') => {
    try {
      await apiClient.post(`/api/to-process/suppliers/${reviewItemId}/resolve`, { resolution });
      toast.success(
        resolution === 'keep_current' ? 'Valeur actuelle conservée' :
        resolution === 'use_detected' ? 'Valeur détectée appliquée' :
        'Élément ignoré'
      );
      await loadSupplier();
      onUpdated?.();
    } catch {
      toast.error('Erreur lors de la résolution');
    }
  };

  const handleClose = () => {
    if (editing && hasUnsaved) {
      setShowUnsavedConfirm(true);
    } else {
      onOpenChange(false);
    }
  };

  const statusCfg = supplier ? (CONTACT_STATUS_CONFIG[supplier.contactStatus] ?? CONTACT_STATUS_CONFIG.unverified) : null;
  const sourceCfg = supplier ? (SOURCE_CONFIG[supplier.source] ?? SOURCE_CONFIG.manual) : null;

  return (
    <>
      <Sheet open={open} onOpenChange={handleClose}>
        <SheetContent className="w-full sm:max-w-lg p-0 flex flex-col" side="right">
          <SheetHeader className="px-5 pt-5 pb-3 flex-shrink-0">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-lg bg-[#3b82f6]/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Building2 className="w-4 h-4 text-[#3b82f6]" />
              </div>
              <div className="flex-1 min-w-0">
                <SheetTitle className="text-sm font-semibold leading-tight truncate text-left">
                  {loading ? 'Chargement…' : (supplier?.name ?? 'Fournisseur')}
                </SheetTitle>
              </div>
            </div>
          </SheetHeader>

          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-[color:var(--text-muted)]" />
            </div>
          ) : !supplier ? null : (
            <ScrollArea className="flex-1">
              <div className="px-6 py-4 space-y-6">

                {/* Badges */}
                <div className="flex items-center gap-2 flex-wrap">
                  {statusCfg && (
                    <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded border ${statusCfg.color}`}>
                      {statusCfg.icon}
                      {statusCfg.label}
                    </span>
                  )}
                  {supplier.status === 'archived' && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded border text-[#ef4444] bg-[#ef4444]/10 border-[#ef4444]/30">
                      Archivé
                    </span>
                  )}
                </div>

                {/* Conflits à résoudre */}
                {reviewItems.filter(r => r.itemType === 'contact_conflict').map(item => {
                  const fieldLabel = CONFLICT_FIELD_LABELS[item.conflictingField ?? ''] ?? item.conflictingField ?? 'Champ';
                  const isIban = item.conflictingField === 'iban';
                  return (
                    <div key={item.id} className="rounded-xl border border-[#f59e0b]/30 bg-[#f59e0b]/5 overflow-hidden">
                      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
                        <AlertTriangle className="w-3.5 h-3.5 text-[#f59e0b] shrink-0" />
                        <p className="text-xs font-semibold text-[#f59e0b]">
                          Nouvelle valeur détectée — {fieldLabel}
                        </p>
                      </div>
                      {isIban ? (
                        <p className="px-3 pb-3 text-xs text-[color:var(--text-muted)]">
                          Un IBAN différent a été détecté. Ouvrez le document source pour vérifier.
                        </p>
                      ) : (
                        <div className="px-3 pb-1 space-y-1">
                          {/* Valeur actuelle */}
                          <button
                            onClick={() => handleResolveConflict(item.id, 'keep_current')}
                            className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] hover:border-slate-400/50 hover:bg-slate-400/5 transition-all group text-left"
                          >
                            <div className="min-w-0">
                              <p className="text-[10px] text-[color:var(--text-muted)] mb-0.5">Valeur actuelle</p>
                              <p className="text-xs font-medium text-[color:var(--text-primary)] truncate">
                                {item.currentValue ?? <span className="italic text-[color:var(--text-muted)]">Non renseignée</span>}
                              </p>
                            </div>
                            <span className="text-[10px] font-semibold text-[color:var(--text-muted)] group-hover:text-[color:var(--text-primary)] shrink-0 transition-colors">Garder</span>
                          </button>
                          {/* Valeur détectée */}
                          <button
                            onClick={() => handleResolveConflict(item.id, 'use_detected')}
                            className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-[#f59e0b]/30 bg-[#f59e0b]/5 hover:border-[#f59e0b]/60 hover:bg-[#f59e0b]/10 transition-all group text-left"
                          >
                            <div className="min-w-0">
                              <p className="text-[10px] text-[#f59e0b] mb-0.5">Valeur détectée par l&apos;IA</p>
                              <p className="text-xs font-semibold text-[color:var(--text-primary)] truncate">
                                {item.detectedValue ?? <span className="italic text-[color:var(--text-muted)]">Inconnue</span>}
                              </p>
                            </div>
                            <span className="text-[10px] font-semibold text-[#f59e0b] group-hover:text-[#fbbf24] shrink-0 transition-colors">Utiliser</span>
                          </button>
                        </div>
                      )}
                      <div className="flex justify-end px-3 pb-2.5">
                        <button
                          onClick={() => handleResolveConflict(item.id, 'ignored')}
                          className="text-[10px] text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors underline underline-offset-2"
                        >
                          Ignorer
                        </button>
                      </div>
                    </div>
                  );
                })}

                {/* Section 1: Coordonnées */}
                <div>
                  <h3 className="text-xs font-semibold text-[color:var(--text-muted)] uppercase tracking-wide mb-3">
                    Coordonnées
                  </h3>

                  {editing ? (
                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Nom *</Label>
                        <Input value={editName} onChange={e => { setEditName(e.target.value); setHasUnsaved(true); }} />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs">Email</Label>
                          <Input type="email" value={editEmail} onChange={e => { setEditEmail(e.target.value); setHasUnsaved(true); }} />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Téléphone</Label>
                          <Input value={editPhone} onChange={e => { setEditPhone(e.target.value); setHasUnsaved(true); }} />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Site web</Label>
                        <Input value={editWebsite} onChange={e => { setEditWebsite(e.target.value); setHasUnsaved(true); }} />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Adresse ligne 1</Label>
                        <Input value={editAddressLine1} onChange={e => { setEditAddressLine1(e.target.value); setHasUnsaved(true); }} />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Adresse ligne 2</Label>
                        <Input value={editAddressLine2} onChange={e => { setEditAddressLine2(e.target.value); setHasUnsaved(true); }} />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs">Code postal</Label>
                          <Input value={editPostalCode} onChange={e => { setEditPostalCode(e.target.value); setHasUnsaved(true); }} />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Ville</Label>
                          <Input value={editCity} onChange={e => { setEditCity(e.target.value); setHasUnsaved(true); }} />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Pays</Label>
                        <Input value={editCountry} onChange={e => { setEditCountry(e.target.value); setHasUnsaved(true); }} />
                      </div>
                      <Separator />
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs">SIREN <span className="text-[color:var(--text-muted)] font-normal">(9 chiffres)</span></Label>
                          <Input value={editSiren} onChange={e => { setEditSiren(e.target.value); setHasUnsaved(true); }} placeholder="123456789" maxLength={9} />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">SIRET <span className="text-[color:var(--text-muted)] font-normal">(14 chiffres)</span></Label>
                          <Input value={editSiret} onChange={e => { setEditSiret(e.target.value); setHasUnsaved(true); }} placeholder="12345678900000" maxLength={14} />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">N° TVA</Label>
                          <Input value={editVatNumber} onChange={e => { setEditVatNumber(e.target.value); setHasUnsaved(true); }} />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">IBAN</Label>
                        <Input value={editIban} onChange={e => { setEditIban(e.target.value); setHasUnsaved(true); }} />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Titulaire IBAN</Label>
                        <Input value={editIbanHolderName} onChange={e => { setEditIbanHolderName(e.target.value); setHasUnsaved(true); }} />
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {supplier.email && (
                        <div className="flex items-center gap-2 text-sm">
                          <Mail className="w-3.5 h-3.5 text-[color:var(--text-muted)] shrink-0" />
                          <a href={`mailto:${supplier.email}`} className="text-[#3b82f6] hover:underline truncate">
                            {supplier.email}
                          </a>
                        </div>
                      )}
                      {supplier.phone && (
                        <div className="flex items-center gap-2 text-sm">
                          <Phone className="w-3.5 h-3.5 text-[color:var(--text-muted)] shrink-0" />
                          <span>{supplier.phone}</span>
                        </div>
                      )}
                      {supplier.website && (
                        <div className="flex items-center gap-2 text-sm">
                          <Globe className="w-3.5 h-3.5 text-[color:var(--text-muted)] shrink-0" />
                          <a href={supplier.website} target="_blank" rel="noopener noreferrer" className="text-[#3b82f6] hover:underline truncate">
                            {supplier.website}
                          </a>
                        </div>
                      )}
                      {(supplier.addressLine1 || supplier.city) && (
                        <div className="flex items-start gap-2 text-sm">
                          <MapPin className="w-3.5 h-3.5 text-[color:var(--text-muted)] mt-0.5 shrink-0" />
                          <div>
                            {supplier.addressLine1 && <div>{supplier.addressLine1}</div>}
                            {supplier.addressLine2 && <div>{supplier.addressLine2}</div>}
                            {(supplier.postalCode || supplier.city) && (
                              <div>{[supplier.postalCode, supplier.city].filter(Boolean).join(' ')}</div>
                            )}
                            {supplier.country && <div className="text-[color:var(--text-muted)]">{supplier.country}</div>}
                          </div>
                        </div>
                      )}
                      {(supplier.siren || supplier.siret || supplier.vatNumber) && (
                        <div className="flex items-center gap-3 text-sm flex-wrap">
                          {supplier.siren && !supplier.siret && (
                            <span className="text-[color:var(--text-muted)]">SIREN <span className="font-mono text-[color:var(--text-primary)]">{supplier.siren}</span></span>
                          )}
                          {supplier.siret && (
                            <span className="text-[color:var(--text-muted)]">SIRET <span className="font-mono text-[color:var(--text-primary)]">{supplier.siret}</span></span>
                          )}
                          {supplier.vatNumber && (
                            <span className="text-[color:var(--text-muted)]">TVA <span className="font-mono text-[color:var(--text-primary)]">{supplier.vatNumber}</span></span>
                          )}
                        </div>
                      )}
                      {supplier.iban && (
                        <div className="text-sm">
                          <span className="text-[color:var(--text-muted)]">IBAN </span>
                          <span className="font-mono text-[color:var(--text-primary)]">{supplier.iban}</span>
                          {supplier.ibanHolderName && (
                            <span className="text-[color:var(--text-muted)] ml-2">({supplier.ibanHolderName})</span>
                          )}
                        </div>
                      )}
                      {!supplier.email && !supplier.phone && !supplier.website && !supplier.addressLine1 && !supplier.city && !supplier.siren && !supplier.siret && !supplier.iban && (
                        <p className="text-sm text-[color:var(--text-muted)] italic">Aucune coordonnée renseignée</p>
                      )}
                    </div>
                  )}
                </div>

                {/* Section 4: Documents associés */}
                {!editing && documents.length > 0 && (
                  <>
                    <Separator />
                    <div>
                      <h3 className="text-xs font-semibold text-[color:var(--text-muted)] uppercase tracking-wide mb-3">
                        Documents associés ({documents.length})
                      </h3>
                      <div className="space-y-2">
                        {documents.slice(0, 10).map(doc => (
                          <button
                            key={doc.documentId}
                            type="button"
                            className="w-full flex items-center gap-2 text-sm p-2 rounded-lg bg-[rgba(255,255,255,0.03)] border border-[color:var(--border-subtle)] hover:bg-[rgba(255,255,255,0.07)] hover:border-[#3b82f6]/40 transition-colors text-left group"
                            onClick={() => {
                              setDocDrawerItem({
                                id: doc.documentId,
                                originalFilename: doc.filename ?? `Document #${doc.documentId}`,
                                mimeType: 'application/pdf',
                                documentType: doc.documentType ?? 'AUTRE',
                                documentDate: doc.documentDate,
                                assetId: doc.assetId ?? 0,
                              });
                              setDocDrawerOpen(true);
                            }}
                          >
                            <FileText className="w-3.5 h-3.5 text-[#3b82f6] shrink-0" />
                            <span className="flex-1 truncate text-[color:var(--text-primary)]">
                              {doc.filename ?? `Document #${doc.documentId}`}
                            </span>
                            {doc.documentDate && (
                              <span className="text-[10px] text-[color:var(--text-muted)] shrink-0">
                                {new Date(doc.documentDate).toLocaleDateString('fr-FR')}
                              </span>
                            )}
                            <ChevronRight className="w-3.5 h-3.5 text-[color:var(--text-muted)] shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                          </button>
                        ))}
                        {documents.length > 10 && (
                          <p className="text-xs text-[color:var(--text-muted)] text-center">
                            +{documents.length - 10} autres
                          </p>
                        )}
                      </div>
                    </div>
                  </>
                )}

              </div>
            </ScrollArea>
          )}

          {/* Action bar — view mode */}
          {!editing && supplier && (
            <div className="px-5 py-4 border-t flex-shrink-0">
              <div className="flex items-stretch rounded-xl border border-border bg-muted/30 overflow-hidden">
                <button
                  type="button"
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-muted/60 transition-colors text-foreground"
                  onClick={enterEdit}
                >
                  <Pencil className="w-4 h-4" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider">Modifier</span>
                </button>
                <div className="w-px bg-border" />
                <button
                  type="button"
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-destructive/10 transition-colors text-destructive"
                  onClick={() => setShowArchiveConfirm(true)}
                >
                  <Archive className="w-4 h-4" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider">Archiver</span>
                </button>
              </div>
            </div>
          )}

          {/* Action bar — edit mode */}
          {editing && (
            <div className="px-5 py-4 border-t flex-shrink-0">
              <div className="flex items-stretch rounded-xl border border-border bg-muted/30 overflow-hidden">
                <button
                  type="button"
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-muted/60 transition-colors text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={() => {
                    if (hasUnsaved) setShowUnsavedConfirm(true);
                    else setEditing(false);
                  }}
                  disabled={saving}
                >
                  <X className="w-4 h-4" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider">Annuler</span>
                </button>
                <div className="w-px bg-border" />
                <button
                  type="button"
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-primary/10 transition-colors text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={handleSave}
                  disabled={saving || !editName.trim()}
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  <span className="text-[10px] font-semibold uppercase tracking-wider">{saving ? 'Sauvegarde…' : 'Enregistrer'}</span>
                </button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Archive confirm */}
      <AlertDialog open={showArchiveConfirm} onOpenChange={setShowArchiveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archiver ce fournisseur ?</AlertDialogTitle>
            <AlertDialogDescription>
              Le fournisseur ne sera plus visible dans la liste mais restera accessible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={handleArchive} className="bg-[#ef4444] hover:bg-[#dc2626]">
              Archiver
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Unsaved changes confirm */}
      <AlertDialog open={showUnsavedConfirm} onOpenChange={setShowUnsavedConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Modifications non sauvegardées</AlertDialogTitle>
            <AlertDialogDescription>
              Voulez-vous abandonner vos modifications ?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Continuer l'édition</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              setShowUnsavedConfirm(false);
              setEditing(false);
              setHasUnsaved(false);
            }}>
              Abandonner
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Document sub-drawer */}
      <DocumentDrawer
        open={docDrawerOpen}
        onOpenChange={(v) => {
          setDocDrawerOpen(v);
          if (!v) setDocDrawerItem(null);
        }}
        document={docDrawerItem}
        onRefresh={loadSupplier}
      />
    </>
  );
}
