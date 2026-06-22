"use client"

import { useState, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

type DocumentItem = {
  id: string;
  name: string;
  typeLabel: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  previewUrl?: string;
  iconType: 'image' | 'pdf' | 'doc' | 'other';
};

interface ExportTemplate {
  id: number;
  code: string;
  label: string;
  exportType?: string;
  isActive: boolean;
}

interface ExportTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: ExportTemplate | null;
  assetId: string;
  assetName: string;
  documents: DocumentItem[];
}

export function ExportTemplateDialog({
  open,
  onOpenChange,
  template,
  assetId,
  assetName,
  documents,
}: ExportTemplateDialogProps) {
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [includeDocuments, setIncludeDocuments] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  
  // ✅ NEW: Additional optional fields
  const [prixVente, setPrixVente] = useState<string>('');
  const [kmCompteur, setKmCompteur] = useState<string>('');

  // Présélectionner tous les documents par défaut
  // NOTE: must be before any early return to respect Rules of Hooks
  useEffect(() => {
    if (open && documents.length > 0) {
      setSelectedDocIds(documents.map(d => d.id));
    }
    // Reset optional fields when dialog opens
    if (open) {
      setPrixVente('');
      setKmCompteur('');
    }
  }, [open, documents]);

  const toggleDoc = useCallback((id: string) => {
    setSelectedDocIds(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  }, []);

  const toggleAll = useCallback(() => {
    if (selectedDocIds.length === documents.length) {
      setSelectedDocIds([]);
    } else {
      setSelectedDocIds(documents.map(d => d.id));
    }
  }, [selectedDocIds.length, documents]);

  // NOTE: handleGenerate uses template.id and template.label below.
  // template may be null but the guard after this hook ensures we never call
  // handleGenerate when template is null.
  const handleGenerate = useCallback(async () => {
    if (!template) return;
    try {
      setIsGenerating(true);
      toast.info('Génération du PDF en cours...');

      const token = localStorage.getItem('bearer_token');
      if (!token) {
        toast.error('Session expirée. Veuillez vous reconnecter.');
        return;
      }

      // Call generic PDFMonkey API route with template ID
      const response = await fetch(`/api/assets/${assetId}/export-pdf/${template.id}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prixVente: prixVente ? parseFloat(prixVente) : null,
          kmCompteur: kmCompteur ? parseInt(kmCompteur) : null,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Erreur lors de la génération du PDF');
      }

      const blob = await response.blob();

      // Si includeDocuments est activé et des documents sont sélectionnés
      if (includeDocuments && selectedDocIds.length > 0) {
        const JSZip = (await import('jszip')).default;
        const zip = new JSZip();

        // Ajouter le PDF au ZIP
        const sanitizedLabel = template.label.replace(/[^a-zA-Z0-9-_]/g, '_');
        zip.file(`${assetName}_${sanitizedLabel}.pdf`, blob);

        // Télécharger et ajouter les documents sélectionnés
        const selectedDocs = documents.filter(d => selectedDocIds.includes(d.id));
        await Promise.all(
          selectedDocs.map(async (doc) => {
            try {
              const downloadResponse = await fetch(`/api/files/${doc.id}/download`, {
                headers: { 'Authorization': `Bearer ${token}` }
              });

              if (downloadResponse.ok) {
                const { downloadUrl } = await downloadResponse.json();
                const fileResponse = await fetch(downloadUrl);

                if (fileResponse.ok) {
                  const fileBlob = await fileResponse.blob();
                  zip.file(doc.name, fileBlob);
                }
              }
            } catch (error) {
              console.error(`Erreur téléchargement ${doc.name}:`, error);
            }
          })
        );

        // Générer et télécharger le ZIP
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(zipBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${assetName}_${sanitizedLabel}_Complet.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        toast.success('Dossier ZIP complet généré avec succès');
      } else {
        // Téléchargement PDF uniquement
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;

        const sanitizedLabel = template.label.replace(/[^a-zA-Z0-9-_]/g, '_');
        link.download = `${assetName}_${sanitizedLabel}.pdf`;

        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        toast.success('PDF généré avec succès');
      }

      onOpenChange(false);
    } catch (error) {
      console.error('Export error:', error);
      toast.error(error instanceof Error ? error.message : 'Erreur lors de la génération du PDF');
    } finally {
      setIsGenerating(false);
    }
  }, [assetId, assetName, template, includeDocuments, selectedDocIds, documents, onOpenChange, prixVente, kmCompteur]);

  // ✅ SÉCURITÉ : Vérifier que template existe (after ALL hooks)
  if (!template) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Préparer l'export – {template.label}</DialogTitle>
          <DialogDescription>
            Choisissez les options d'export pour ce modèle
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Options d'export */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Options d'export</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* ✅ NEW: Prix de vente field */}
              <div>
                <Label htmlFor="prixVente">Prix de vente (optionnel)</Label>
                <Input
                  id="prixVente"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="Ex: 1500"
                  value={prixVente}
                  onChange={(e) => setPrixVente(e.target.value)}
                />
                <p className="text-xs text-muted-foreground mt-1">En euros (€)</p>
              </div>

              {/* ✅ NEW: Km compteur field */}
              <div>
                <Label htmlFor="kmCompteur">Km compteur (optionnel)</Label>
                <Input
                  id="kmCompteur"
                  type="number"
                  step="1"
                  min="0"
                  placeholder="Ex: 5000"
                  value={kmCompteur}
                  onChange={(e) => setKmCompteur(e.target.value)}
                />
                <p className="text-xs text-muted-foreground mt-1">Kilométrage actuel</p>
              </div>

              <div className="flex items-center justify-between pt-2 border-t">
                <div className="space-y-0.5">
                  <Label className="font-semibold">Inclure les documents dans un dossier ZIP complet</Label>
                  <p className="text-xs text-muted-foreground">
                    Si coché, un ZIP sera créé contenant le PDF et tous les documents sélectionnés ci-dessous
                  </p>
                </div>
                <Switch
                  checked={includeDocuments}
                  onCheckedChange={setIncludeDocuments}
                />
              </div>
            </CardContent>
          </Card>

          {/* Documents (visible uniquement si includeDocuments est activé) */}
          {includeDocuments && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">
                    Documents à inclure ({selectedDocIds.length}/{documents.length})
                  </CardTitle>
                  <Button variant="link" size="sm" onClick={toggleAll}>
                    {selectedDocIds.length === documents.length ? 'Tout désélectionner' : 'Tout sélectionner'}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {documents.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    Aucun document disponible
                  </p>
                ) : (
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {documents.map((doc) => (
                      <div key={doc.id} className="flex items-center gap-2 p-2 hover:bg-muted/50 rounded">
                        <Checkbox
                          checked={selectedDocIds.includes(doc.id)}
                          onCheckedChange={() => toggleDoc(doc.id)}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{doc.name}</p>
                          <p className="text-xs text-muted-foreground">{doc.typeLabel}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isGenerating}>
            Annuler
          </Button>
          <Button onClick={handleGenerate} disabled={isGenerating}>
            {isGenerating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Génération...
              </>
            ) : (
              'Générer l\'export'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}