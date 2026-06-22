"use client"

import { useState, useEffect } from 'react';
import { Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { toast } from 'sonner';
import { LinkedEventsSection } from '@/components/documents/linked-events-section';
import { DOCUMENT_TYPE_LIST } from '@/lib/document-type-constants';

interface DocumentType {
  id: number;
  code: string;
  label: string;
  isActive: boolean;
}

interface DocumentEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
      document: {
        id: number;
        fileName: string;
        documentType: string;
        documentDate: string | null;
        asset: {
          id: number;
          name: string;
        } | null;
        createdAt: string;
      } | null;

  assets: { id: number; name: string }[];
  documentTypes: DocumentType[];
  onEditComplete: () => void;
}

export function DocumentEditDialog({
  open,
  onOpenChange,
  document,
  assets,
  documentTypes,
  onEditComplete,
}: DocumentEditDialogProps) {
  const [fileName, setFileName] = useState('');
  const [documentType, setDocumentType] = useState('');
  const [documentDate, setDocumentDate] = useState('');
  const [assetId, setAssetId] = useState('');
  const [webLinkUrl, setWebLinkUrl] = useState('');

  const [isUpdating, setIsUpdating] = useState(false);

  // Liste des types disponible (API si dispo, sinon fallback canonique)
  const availableTypes: DocumentType[] = (documentTypes && documentTypes.length > 0)
    ? documentTypes.filter(dt => dt.isActive)
    : DOCUMENT_TYPE_LIST.map((t, i) => ({ id: i + 1, code: t.code, label: t.label, isActive: true }));

  // Initialize form when document changes
  useEffect(() => {
    if (document && open) {
      setFileName(document.fileName);
      // si le type courant n'existe pas dans la liste, fallback sur AUTRE
      const existsInList = availableTypes.some(t => t.code === document.documentType);
      setDocumentType(existsInList ? document.documentType : 'AUTRE');
      setDocumentDate(document.documentDate ? document.documentDate.split('T')[0] : '');
      // Use "0" to represent no asset
      setAssetId(document.asset?.id?.toString() ?? '0');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document, open, availableTypes.length]);

  // Handle dialog close
  const handleClose = () => {
    if (!isUpdating) {
      onOpenChange(false);
    }
  };

  // Handle update
  const handleUpdate = async () => {
    if (!document) return;

    if (!fileName.trim()) {
      toast.error('Le nom du document ne peut pas être vide');
      return;
    }

    if (!documentType) {
      toast.error('Veuillez sélectionner un type de document');
      return;
    }

    setIsUpdating(true);

    try {
      const token = localStorage.getItem('bearer_token');
      if (!token) {
        throw new Error('Non authentifié');
      }

      // Convert assetId - send null if "0" (no asset selected)
      const targetAssetId = assetId === '0' ? null : parseInt(assetId);

      const response = await fetch(`/api/documents/${document.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
          body: JSON.stringify({
            fileName: fileName.trim(),
            documentType,
            documentDate,
            assetId: targetAssetId,
          }),

      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || 'Erreur lors de la mise à jour');
      }

      toast.success('Document mis à jour avec succès !');
      onEditComplete();
      handleClose();
    } catch (error) {
      console.error('Error updating document:', error);
      const errorMessage = error instanceof Error ? error.message : 'Erreur lors de la mise à jour';
      toast.error(errorMessage);
    } finally {
      setIsUpdating(false);
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (!document) return null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Modifier le document</DialogTitle>
          <DialogDescription>
            Modifiez les métadonnées du document et gérez les événements associés
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Document Information */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-[color:var(--text-primary)]">
              Informations du document
            </h3>

            {/* Original Upload Date (read-only) */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Date d'upload (non modifiable)</Label>
                <Input
                  value={formatDate(document.createdAt)}
                  disabled
                  className="bg-muted"
                />
              </div>

              {/* Document Date */}
              <div className="space-y-2">
                <Label htmlFor="documentDate">Date du document</Label>
                  <DatePicker
                    id="documentDate"
                    value={documentDate}
                    onChange={(d) => setDocumentDate(d)}
                    disabled={isUpdating}
                  />
              </div>
            </div>

            {/* File Name */}
            <div className="space-y-2">
              <Label htmlFor="fileName">Nom du document *</Label>
              <Input
                id="fileName"
                type="text"
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                disabled={isUpdating}
                placeholder="Nom du fichier"
              />
            </div>

            {/* Document Type */}
            <div className="space-y-2">
              <Label htmlFor="documentType">Type de document *</Label>
              <Select value={documentType} onValueChange={setDocumentType} disabled={isUpdating}>
                <SelectTrigger id="documentType">
                  <SelectValue placeholder="Sélectionner un type" />
                </SelectTrigger>
                <SelectContent>
                  {availableTypes.map((dt) => (
                    <SelectItem key={dt.code} value={dt.code}>
                      {dt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Asset Selection - Now optional */}
            <div className="space-y-2">
              <Label htmlFor="assetId">Bien associé (facultatif)</Label>
              <Select value={assetId} onValueChange={setAssetId} disabled={isUpdating}>
                <SelectTrigger id="assetId">
                  <SelectValue placeholder="Aucun bien" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Aucun bien</SelectItem>
                  {assets.map((asset) => (
                    <SelectItem key={asset.id} value={asset.id.toString()}>
                      {asset.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Events Section - Only show if asset is selected */}
          {assetId !== '0' && (
            <div>
              <LinkedEventsSection
                documentId={document.id}
                assetId={parseInt(assetId)}
                onRefresh={onEditComplete}
              />
            </div>
          )}
        </div>

        <DialogFooter className="flex justify-end gap-3 pt-4 border-t border-[color:var(--border-subtle)]">
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={isUpdating}
          >
            Annuler
          </Button>
          <Button
            type="button"
            onClick={handleUpdate}
            disabled={isUpdating || !fileName.trim() || !documentType}
            className="bg-gradient-to-br from-[#3b82f6] to-[#1d4ed8]"
          >
            {isUpdating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Mise à jour...
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                Enregistrer
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  }
