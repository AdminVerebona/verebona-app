"use client"

import { useState, memo, useCallback, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { DatePicker } from '@/components/ui/date-picker';

type DocumentItem = {
  id: string;
  name: string;
  typeLabel: string;
};

// ⚡ OPTIMISATION: Mémoïser les composants Dialog individuels
// ========== REVENTE DU BIEN ==========
type ReventeFormData = {
  prixDemande?: string;
  commentaireAcheteur?: string;
  inclureHistoriqueDetaille: boolean;
  genererZipComplet: boolean;
};

// 🎯 Helper: Présélectionner les documents pertinents pour une revente
const getPreselectedForRevente = (documents: DocumentItem[]): string[] => {
  return documents
    .filter(doc => {
      const type = doc.typeLabel.toLowerCase();
      // Inclure: factures, garanties, manuels, certificats
      // Exclure: contrats (assurances, etc.)
      return !type.includes('contrat');
    })
    .map(d => d.id);
};

export const ExportReventeDialog = memo(({
  open,
  onOpenChange,
  assetId,
  assetName,
  documents,
  preselectedDocIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetId: string;
  assetName: string;
  documents: DocumentItem[];
  preselectedDocIds: string[];
}) => {
  const [formData, setFormData] = useState<ReventeFormData>({
    prixDemande: '',
    commentaireAcheteur: '',
    inclureHistoriqueDetaille: true,
    genererZipComplet: false,
  });
  
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  // 🎯 Au moment de l'ouverture du dialog, présélectionner les documents pertinents
  useEffect(() => {
    if (open && documents.length > 0) {
      const preselected = getPreselectedForRevente(documents);
      setSelectedDocIds(preselected);
    }
  }, [open, documents]);

  // ⚡ Mémoïser les handlers
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

  const handleGenerate = useCallback(async () => {
    try {
      setIsGenerating(true);
      const token = localStorage.getItem('bearer_token');

      const response = await fetch('/api/exports/revente', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          assetId: parseInt(assetId),
          prixDemande: formData.prixDemande ? parseFloat(formData.prixDemande) : null,
          commentaireAcheteur: formData.commentaireAcheteur || null,
          inclureHistoriqueDetaille: formData.inclureHistoriqueDetaille,
          includeZip: formData.genererZipComplet,
          documentIds: selectedDocIds.map(id => parseInt(id)),
        }),
      });

      if (!response.ok) throw new Error('Erreur lors de la génération');

      const blob = await response.blob();
      const contentType = response.headers.get('content-type');
      
      // Téléchargement direct du fichier retourné (PDF ou ZIP)
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      
      if (contentType === 'application/zip') {
        link.download = `${assetName}_Dossier_Revente_Complet.zip`;
        toast.success('Dossier ZIP complet généré avec succès');
      } else {
        link.download = `${assetName}_Dossier_Revente.pdf`;
        toast.success('Dossier de revente généré avec succès');
      }
      
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      onOpenChange(false);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Erreur lors de la génération du PDF');
    } finally {
      setIsGenerating(false);
    }
  }, [assetId, assetName, formData, selectedDocIds, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Préparer l'export – Revente du bien</DialogTitle>
          <DialogDescription>
            Créer un dossier pour un acheteur potentiel ou une plateforme de revente
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Paramètres */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Paramètres de l'export</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="prixDemande">Prix demandé (optionnel)</Label>
                <Input
                  id="prixDemande"
                  type="number"
                  step="0.01"
                  placeholder="Ex: 15000"
                  value={formData.prixDemande}
                  onChange={(e) => setFormData({ ...formData, prixDemande: e.target.value })}
                />
                <p className="text-xs text-muted-foreground mt-1">En euros (€)</p>
              </div>

              <div>
                <Label htmlFor="commentaire">Commentaire pour l'acheteur (optionnel)</Label>
                <Textarea
                  id="commentaire"
                  placeholder="Ajoutez des informations complémentaires..."
                  rows={3}
                  value={formData.commentaireAcheteur}
                  onChange={(e) => setFormData({ ...formData, commentaireAcheteur: e.target.value })}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Inclure l'historique détaillé des entretiens</Label>
                  <p className="text-xs text-muted-foreground">
                    Afficher toutes les interventions effectuées
                  </p>
                </div>
                <Switch
                  checked={formData.inclureHistoriqueDetaille}
                  onCheckedChange={(checked) => 
                    setFormData({ ...formData, inclureHistoriqueDetaille: checked })
                  }
                />
              </div>

              <div className="flex items-center justify-between pt-2 border-t">
                <div className="space-y-0.5">
                  <Label className="font-semibold">Générer le dossier ZIP complet avec le PDF et les documents</Label>
                  <p className="text-xs text-muted-foreground">
                    Si coché, un ZIP sera créé contenant le PDF et tous les documents sélectionnés ci-dessous
                  </p>
                </div>
                <Switch
                  checked={formData.genererZipComplet}
                  onCheckedChange={(checked) => 
                    setFormData({ ...formData, genererZipComplet: checked })
                  }
                />
              </div>
            </CardContent>
          </Card>

          {/* Documents */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">
                  Documents inclus ({selectedDocIds.length}/{documents.length})
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
});

ExportReventeDialog.displayName = 'ExportReventeDialog';

// ========== ASSURANCE DEVIS ==========
type AssuranceDevisFormData = {
  valeurEstimee: string;
  usageBien?: string;
  assureurActuel?: string;
  numeroContrat?: string;
  genererZipComplet: boolean;
};

// 🎯 Helper: Présélectionner les documents pertinents pour un devis d'assurance
const getPreselectedForAssuranceDevis = (documents: DocumentItem[]): string[] => {
  return documents
    .filter(doc => {
      const type = doc.typeLabel.toLowerCase();
      // Inclure: factures, certificats, garanties
      return type.includes('facture') || type.includes('certificat') || type.includes('garantie');
    })
    .map(d => d.id);
};

export const ExportAssuranceDevisDialog = memo(({ 
  open, 
  onOpenChange, 
  assetId, 
  assetName, 
  documents, 
  preselectedDocIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetId: string;
  assetName: string;
  documents: DocumentItem[];
  preselectedDocIds: string[];
}) => {
  const [formData, setFormData] = useState<AssuranceDevisFormData>({
    valeurEstimee: '',
    usageBien: '',
    assureurActuel: '',
    numeroContrat: '',
    genererZipComplet: false,
  });
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // 🎯 Présélectionner les documents pertinents
  useEffect(() => {
    if (open && documents.length > 0) {
      const preselected = getPreselectedForAssuranceDevis(documents);
      setSelectedDocIds(preselected);
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

  const validate = useCallback(() => {
    const newErrors: Record<string, string> = {};
    
    if (!formData.valeurEstimee || parseFloat(formData.valeurEstimee) <= 0) {
      newErrors.valeurEstimee = 'La valeur estimée doit être strictement positive';
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [formData]);

  const handleGenerate = useCallback(async () => {
    if (!validate()) {
      toast.error('Veuillez corriger les erreurs du formulaire');
      return;
    }

    try {
      setIsGenerating(true);
      const token = localStorage.getItem('bearer_token');

      const response = await fetch('/api/exports/assurance-devis', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          assetId: parseInt(assetId),
          valeurEstimee: parseFloat(formData.valeurEstimee),
          usageBien: formData.usageBien || null,
          assureurActuel: formData.assureurActuel || null,
          numeroContrat: formData.numeroContrat || null,
          documentIds: selectedDocIds.map(id => parseInt(id)),
        }),
      });

      if (!response.ok) throw new Error('Erreur lors de la génération');

      const blob = await response.blob();
      
      // Si ZIP complet demandé et documents sélectionnés
      if (formData.genererZipComplet && selectedDocIds.length > 0) {
        const zip = new (await import('jszip')).default();
        
        // Ajouter le PDF au ZIP
        zip.file(`${assetName}_Assurance_Devis.pdf`, blob);
        
        // Télécharger et ajouter les documents sélectionnés
        const selectedDocs = documents.filter(d => selectedDocIds.includes(d.id));
        await Promise.all(
          selectedDocs.map(async (doc) => {
            try {
              const { downloadUrl } = await (await fetch(`/api/files/${doc.id}/download`, {
                headers: { 'Authorization': `Bearer ${token}` }
              })).json();
              
              const fileResponse = await fetch(downloadUrl);
              if (fileResponse.ok) {
                const fileBlob = await fileResponse.blob();
                zip.file(doc.name, fileBlob);
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
        link.download = `${assetName}_Assurance_Devis_Complet.zip`;
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
        link.download = `${assetName}_Assurance_Devis.pdf`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        
        toast.success('Dossier assurance généré avec succès');
      }
      
      onOpenChange(false);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Erreur lors de la génération du PDF');
    } finally {
      setIsGenerating(false);
    }
  }, [assetId, assetName, formData, selectedDocIds, documents, onOpenChange, validate]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Préparer l'export – Assurance Devis</DialogTitle>
          <DialogDescription>
            Fournir les éléments pour estimer ou ajuster la valeur assurée du bien
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Paramètres */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Paramètres de l'export</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="valeurEstimee">
                  Valeur estimée actuelle <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="valeurEstimee"
                  type="number"
                  step="0.01"
                  placeholder="Ex: 25000"
                  value={formData.valeurEstimee}
                  onChange={(e) => {
                    setFormData({ ...formData, valeurEstimee: e.target.value });
                    setErrors({ ...errors, valeurEstimee: '' });
                  }}
                  className={errors.valeurEstimee ? 'border-destructive' : ''}
                />
                {errors.valeurEstimee && (
                  <p className="text-xs text-destructive mt-1">{errors.valeurEstimee}</p>
                )}
                <p className="text-xs text-muted-foreground mt-1">En euros (€)</p>
              </div>

              <div>
                <Label htmlFor="usage">Usage du bien (optionnel)</Label>
                <Select value={formData.usageBien} onValueChange={(value) => 
                  setFormData({ ...formData, usageBien: value })
                }>
                  <SelectTrigger id="usage">
                    <SelectValue placeholder="Sélectionner un usage" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Personnel">Personnel</SelectItem>
                    <SelectItem value="Professionnel">Professionnel</SelectItem>
                    <SelectItem value="Mixte">Mixte</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="assureur">Assureur actuel (optionnel)</Label>
                <Input
                  id="assureur"
                  placeholder="Ex: Axa, Allianz..."
                  value={formData.assureurActuel}
                  onChange={(e) => setFormData({ ...formData, assureurActuel: e.target.value })}
                />
              </div>

              <div>
                <Label htmlFor="numeroContrat">Numéro de contrat d'assurance (optionnel)</Label>
                <Input
                  id="numeroContrat"
                  placeholder="Ex: 123456789"
                  value={formData.numeroContrat}
                  onChange={(e) => setFormData({ ...formData, numeroContrat: e.target.value })}
                />
              </div>

              <div className="flex items-center justify-between pt-2 border-t">
                <div className="space-y-0.5">
                  <Label className="font-semibold">Générer le dossier ZIP complet avec le PDF et les documents</Label>
                  <p className="text-xs text-muted-foreground">
                    Si coché, un ZIP sera créé contenant le PDF et tous les documents sélectionnés ci-dessous
                  </p>
                </div>
                <Switch
                  checked={formData.genererZipComplet}
                  onCheckedChange={(checked) => 
                    setFormData({ ...formData, genererZipComplet: checked })
                  }
                />
              </div>
            </CardContent>
          </Card>

          {/* Documents */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">
                  Documents inclus ({selectedDocIds.length}/{documents.length})
                </CardTitle>
                <Button variant="link" size="sm" onClick={toggleAll}>
                  {selectedDocIds.length === documents.length ? 'Tout désélectionner' : 'Tout sélectionner'}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>
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
});

ExportAssuranceDevisDialog.displayName = 'ExportAssuranceDevisDialog';

// ========== ASSURANCE SINISTRE ==========
type AssuranceSinistreFormData = {
  typeSinistre: string;
  dateSinistre: string;
  descriptionSinistre: string;
  referenceDossier?: string;
  genererZipComplet: boolean;
};

// 🎯 Helper: Présélectionner les documents pertinents pour un sinistre
const getPreselectedForSinistre = (documents: DocumentItem[]): string[] => {
  // Pour un sinistre, tous les documents sont généralement pertinents
  return documents.map(d => d.id);
};

export const ExportAssuranceSinistreDialog = memo(({ 
  open, 
  onOpenChange, 
  assetId, 
  assetName, 
  documents, 
  preselectedDocIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetId: string;
  assetName: string;
  documents: DocumentItem[];
  preselectedDocIds: string[];
}) => {
  const [formData, setFormData] = useState<AssuranceSinistreFormData>({
    typeSinistre: '',
    dateSinistre: '',
    descriptionSinistre: '',
    referenceDossier: '',
    genererZipComplet: false,
  });
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // 🎯 Présélectionner les documents pertinents
  useEffect(() => {
    if (open && documents.length > 0) {
      const preselected = getPreselectedForSinistre(documents);
      setSelectedDocIds(preselected);
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

  const validate = useCallback(() => {
    const newErrors: Record<string, string> = {};
    
    if (!formData.typeSinistre) {
      newErrors.typeSinistre = 'Le type de sinistre est obligatoire';
    }
    
    if (!formData.dateSinistre) {
      newErrors.dateSinistre = 'La date du sinistre est obligatoire';
    } else if (new Date(formData.dateSinistre) > new Date()) {
      newErrors.dateSinistre = 'La date du sinistre ne peut pas être dans le futur';
    }
    
    if (!formData.descriptionSinistre || formData.descriptionSinistre.trim().length === 0) {
      newErrors.descriptionSinistre = 'La description du sinistre est obligatoire';
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [formData]);

  const handleGenerate = useCallback(async () => {
    if (!validate()) {
      toast.error('Veuillez corriger les erreurs du formulaire');
      return;
    }

    try {
      setIsGenerating(true);
      const token = localStorage.getItem('bearer_token');

      const response = await fetch('/api/exports/assurance-sinistre', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          assetId: parseInt(assetId),
          typeSinistre: formData.typeSinistre,
          dateSinistre: formData.dateSinistre,
          descriptionSinistre: formData.descriptionSinistre,
          referenceDossier: formData.referenceDossier || null,
          documentIds: selectedDocIds.map(id => parseInt(id)),
        }),
      });

      if (!response.ok) throw new Error('Erreur lors de la génération');

      const blob = await response.blob();
      
      // Si ZIP complet demandé et documents sélectionnés
      if (formData.genererZipComplet && selectedDocIds.length > 0) {
        const zip = new (await import('jszip')).default();
        
        // Ajouter le PDF au ZIP
        zip.file(`${assetName}_Assurance_Sinistre.pdf`, blob);
        
        // Télécharger et ajouter les documents sélectionnés
        const selectedDocs = documents.filter(d => selectedDocIds.includes(d.id));
        await Promise.all(
          selectedDocs.map(async (doc) => {
            try {
              const { downloadUrl } = await (await fetch(`/api/files/${doc.id}/download`, {
                headers: { 'Authorization': `Bearer ${token}` }
              })).json();
              
              const fileResponse = await fetch(downloadUrl);
              if (fileResponse.ok) {
                const fileBlob = await fileResponse.blob();
                zip.file(doc.name, fileBlob);
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
        link.download = `${assetName}_Assurance_Sinistre_Complet.zip`;
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
        link.download = `${assetName}_Assurance_Sinistre.pdf`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        
        toast.success('Dossier sinistre généré avec succès');
      }
      
      onOpenChange(false);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Erreur lors de la génération du PDF');
    } finally {
      setIsGenerating(false);
    }
  }, [assetId, assetName, formData, selectedDocIds, documents, onOpenChange, validate]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Préparer l'export – Assurance Sinistre</DialogTitle>
          <DialogDescription>
            Préparer un dossier de sinistre complet à destination de l'assurance
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Paramètres */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Paramètres de l'export</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="typeSinistre">
                  Type de sinistre <span className="text-destructive">*</span>
                </Label>
                <Select 
                  value={formData.typeSinistre} 
                  onValueChange={(value) => {
                    setFormData({ ...formData, typeSinistre: value });
                    setErrors({ ...errors, typeSinistre: '' });
                  }}
                >
                  <SelectTrigger id="typeSinistre" className={errors.typeSinistre ? 'border-destructive' : ''}>
                    <SelectValue placeholder="Sélectionner un type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Vol">Vol</SelectItem>
                    <SelectItem value="Casse">Casse</SelectItem>
                    <SelectItem value="Dégât des eaux">Dégât des eaux</SelectItem>
                    <SelectItem value="Incendie">Incendie</SelectItem>
                    <SelectItem value="Autre">Autre</SelectItem>
                  </SelectContent>
                </Select>
                {errors.typeSinistre && (
                  <p className="text-xs text-destructive mt-1">{errors.typeSinistre}</p>
                )}
              </div>

              <div>
                <Label htmlFor="dateSinistre">
                  Date du sinistre <span className="text-destructive">*</span>
                </Label>
                <DatePicker
                  id="dateSinistre"
                  value={formData.dateSinistre}
                  onChange={(date) => {
                    setFormData({ ...formData, dateSinistre: date });
                    setErrors({ ...errors, dateSinistre: '' });
                  }}
                  max={new Date().toISOString().split('T')[0]}
                  placeholder="Choisissez une date"
                  className={errors.dateSinistre ? 'border-destructive' : ''}
                />
                {errors.dateSinistre && (
                  <p className="text-xs text-destructive mt-1">{errors.dateSinistre}</p>
                )}
              </div>

              <div>
                <Label htmlFor="description">
                  Description du sinistre <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="description"
                  placeholder="Décrivez les circonstances et les dommages..."
                  rows={4}
                  value={formData.descriptionSinistre}
                  onChange={(e) => {
                    setFormData({ ...formData, descriptionSinistre: e.target.value });
                    setErrors({ ...errors, descriptionSinistre: '' });
                  }}
                  className={errors.descriptionSinistre ? 'border-destructive' : ''}
                />
                {errors.descriptionSinistre && (
                  <p className="text-xs text-destructive mt-1">{errors.descriptionSinistre}</p>
                )}
              </div>

              <div>
                <Label htmlFor="reference">Référence dossier assurance (optionnel)</Label>
                <Input
                  id="reference"
                  placeholder="Ex: SIN-2024-12345"
                  value={formData.referenceDossier}
                  onChange={(e) => setFormData({ ...formData, referenceDossier: e.target.value })}
                />
              </div>

              <div className="flex items-center justify-between pt-2 border-t">
                <div className="space-y-0.5">
                  <Label className="font-semibold">Générer le dossier ZIP complet avec le PDF et les documents</Label>
                  <p className="text-xs text-muted-foreground">
                    Si coché, un ZIP sera créé contenant le PDF et tous les documents sélectionnés ci-dessous
                  </p>
                </div>
                <Switch
                  checked={formData.genererZipComplet}
                  onCheckedChange={(checked) => 
                    setFormData({ ...formData, genererZipComplet: checked })
                  }
                />
              </div>
            </CardContent>
          </Card>

          {/* Documents */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">
                  Documents inclus ({selectedDocIds.length}/{documents.length})
                </CardTitle>
                <Button variant="link" size="sm" onClick={toggleAll}>
                  {selectedDocIds.length === documents.length ? 'Tout désélectionner' : 'Tout sélectionner'}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>
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
});

ExportAssuranceSinistreDialog.displayName = 'ExportAssuranceSinistreDialog';

// ========== SAV / GARANTIE ==========
type SavGarantieFormData = {
  descriptionProbleme: string;
  vendeurInstallateur?: string;
  datePremierePane?: string;
  genererZipComplet: boolean;
};

// 🎯 Helper: Présélectionner les documents pertinents pour SAV/Garantie
const getPreselectedForSavGarantie = (documents: DocumentItem[]): string[] => {
  return documents
    .filter(doc => {
      const type = doc.typeLabel.toLowerCase();
      // Inclure: factures, garanties, manuels
      return type.includes('facture') || type.includes('garantie') || type.includes('manuel');
    })
    .map(d => d.id);
};

export const ExportSavGarantieDialog = memo(({ 
  open, 
  onOpenChange, 
  assetId, 
  assetName, 
  documents, 
  preselectedDocIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetId: string;
  assetName: string;
  documents: DocumentItem[];
  preselectedDocIds: string[];
}) => {
  const [formData, setFormData] = useState<SavGarantieFormData>({
    descriptionProbleme: '',
    vendeurInstallateur: '',
    datePremierePane: '',
    genererZipComplet: false,
  });
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // 🎯 Présélectionner les documents pertinents
  useEffect(() => {
    if (open && documents.length > 0) {
      const preselected = getPreselectedForSavGarantie(documents);
      setSelectedDocIds(preselected);
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

  const validate = useCallback(() => {
    const newErrors: Record<string, string> = {};
    
    if (!formData.descriptionProbleme || formData.descriptionProbleme.trim().length === 0) {
      newErrors.descriptionProbleme = 'La description du problème est obligatoire';
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [formData]);

  const handleGenerate = useCallback(async () => {
    if (!validate()) {
      toast.error('Veuillez corriger les erreurs du formulaire');
      return;
    }

    try {
      setIsGenerating(true);
      const token = localStorage.getItem('bearer_token');

      const response = await fetch('/api/exports/sav-garantie', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          assetId: parseInt(assetId),
          descriptionProbleme: formData.descriptionProbleme,
          vendeurInstallateur: formData.vendeurInstallateur || null,
          datePremierePane: formData.datePremierePane || null,
          documentIds: selectedDocIds.map(id => parseInt(id)),
        }),
      });

      if (!response.ok) throw new Error('Erreur lors de la génération');

      const blob = await response.blob();
      
      // Si ZIP complet demandé et documents sélectionnés
      if (formData.genererZipComplet && selectedDocIds.length > 0) {
        const zip = new (await import('jszip')).default();
        
        // Ajouter le PDF au ZIP
        zip.file(`${assetName}_SAV_Garantie.pdf`, blob);
        
        // Télécharger et ajouter les documents sélectionnés
        const selectedDocs = documents.filter(d => selectedDocIds.includes(d.id));
        await Promise.all(
          selectedDocs.map(async (doc) => {
            try {
              const { downloadUrl } = await (await fetch(`/api/files/${doc.id}/download`, {
                headers: { 'Authorization': `Bearer ${token}` }
              })).json();
              
              const fileResponse = await fetch(downloadUrl);
              if (fileResponse.ok) {
                const fileBlob = await fileResponse.blob();
                zip.file(doc.name, fileBlob);
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
        link.download = `${assetName}_SAV_Garantie_Complet.zip`;
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
        link.download = `${assetName}_SAV_Garantie.pdf`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        
        toast.success('Dossier SAV/Garantie généré avec succès');
      }
      
      onOpenChange(false);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Erreur lors de la génération du PDF');
    } finally {
      setIsGenerating(false);
    }
  }, [assetId, assetName, formData, selectedDocIds, documents, onOpenChange, validate]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Préparer l'export – SAV / Garantie</DialogTitle>
          <DialogDescription>
            Constituer un dossier à transmettre au vendeur, constructeur ou service après-vente
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Paramètres de l'export</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="descriptionProbleme">
                  Description du problème <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="descriptionProbleme"
                  placeholder="Décrivez le problème rencontré..."
                  rows={4}
                  value={formData.descriptionProbleme}
                  onChange={(e) => {
                    setFormData({ ...formData, descriptionProbleme: e.target.value });
                    setErrors({ ...errors, descriptionProbleme: '' });
                  }}
                  className={errors.descriptionProbleme ? 'border-destructive' : ''}
                />
                {errors.descriptionProbleme && (
                  <p className="text-xs text-destructive mt-1">{errors.descriptionProbleme}</p>
                )}
              </div>

              <div>
                <Label htmlFor="vendeur">Vendeur / Installateur (optionnel)</Label>
                <Input
                  id="vendeur"
                  placeholder="Ex: Darty, Leroy Merlin..."
                  value={formData.vendeurInstallateur}
                  onChange={(e) => setFormData({ ...formData, vendeurInstallateur: e.target.value })}
                />
              </div>

              <div>
                <Label htmlFor="datePanne">Date de première panne (optionnel)</Label>
                <DatePicker
                  id="datePanne"
                  value={formData.datePremierePane}
                  onChange={(date) => setFormData({ ...formData, datePremierePane: date })}
                  placeholder="Choisissez une date"
                />
              </div>

              <div className="flex items-center justify-between pt-2 border-t">
                <div className="space-y-0.5">
                  <Label className="font-semibold">Générer le dossier ZIP complet avec le PDF et les documents</Label>
                  <p className="text-xs text-muted-foreground">
                    Si coché, un ZIP sera créé contenant le PDF et tous les documents sélectionnés ci-dessous
                  </p>
                </div>
                <Switch
                  checked={formData.genererZipComplet}
                  onCheckedChange={(checked) => 
                    setFormData({ ...formData, genererZipComplet: checked })
                  }
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">
                  Documents inclus ({selectedDocIds.length}/{documents.length})
                </CardTitle>
                <Button variant="link" size="sm" onClick={toggleAll}>
                  {selectedDocIds.length === documents.length ? 'Tout désélectionner' : 'Tout sélectionner'}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>
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
});

ExportSavGarantieDialog.displayName = 'ExportSavGarantieDialog';

// ========== CARNET D'INFORMATION DU LOGEMENT (CIL) ==========
type CilFormData = {
  nomProprietaire?: string;
  nomOccupant?: string;
  dateMiseAJour: string;
  notesGenerales?: string;
  genererZipComplet: boolean;
};

// 🎯 Helper: Présélectionner les documents pertinents pour CIL
const getPreselectedForCil = (documents: DocumentItem[]): string[] => {
  // Pour le CIL, tous les documents sont généralement pertinents
  return documents.map(d => d.id);
};

export const ExportCilDialog = memo(({ 
  open, 
  onOpenChange, 
  assetId, 
  assetName, 
  assetCategory,
  documents, 
  preselectedDocIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetId: string;
  assetName: string;
  assetCategory: string;
  documents: DocumentItem[];
  preselectedDocIds: string[];
}) => {
  const [formData, setFormData] = useState<CilFormData>({
    nomProprietaire: '',
    nomOccupant: '',
    dateMiseAJour: new Date().toISOString().split('T')[0],
    notesGenerales: '',
    genererZipComplet: false,
  });
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // 🎯 Présélectionner les documents pertinents
  useEffect(() => {
    if (open && documents.length > 0) {
      const preselected = getPreselectedForCil(documents);
      setSelectedDocIds(preselected);
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

  const validate = useCallback(() => {
    const newErrors: Record<string, string> = {};
    
    if (!formData.dateMiseAJour) {
      newErrors.dateMiseAJour = 'La date de mise à jour est obligatoire';
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [formData]);

  const handleGenerate = useCallback(async () => {
    if (!validate()) {
      toast.error('Veuillez corriger les erreurs du formulaire');
      return;
    }

    try {
      setIsGenerating(true);
      const token = localStorage.getItem('bearer_token');

      const response = await fetch('/api/exports/cil', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          assetId: parseInt(assetId),
          nomProprietaire: formData.nomProprietaire || null,
          nomOccupant: formData.nomOccupant || null,
          dateMiseAJour: formData.dateMiseAJour,
          notesGenerales: formData.notesGenerales || null,
          documentIds: selectedDocIds.map(id => parseInt(id)),
        }),
      });

      if (!response.ok) throw new Error('Erreur lors de la génération');

      const blob = await response.blob();
      
      // Si ZIP complet demandé et documents sélectionnés
      if (formData.genererZipComplet && selectedDocIds.length > 0) {
        const zip = new (await import('jszip')).default();
        
        // Ajouter le PDF au ZIP
        zip.file(`${assetName}_Carnet_Information_Logement.pdf`, blob);
        
        // Télécharger et ajouter les documents sélectionnés
        const selectedDocs = documents.filter(d => selectedDocIds.includes(d.id));
        await Promise.all(
          selectedDocs.map(async (doc) => {
            try {
              const { downloadUrl } = await (await fetch(`/api/files/${doc.id}/download`, {
                headers: { 'Authorization': `Bearer ${token}` }
              })).json();
              
              const fileResponse = await fetch(downloadUrl);
              if (fileResponse.ok) {
                const fileBlob = await fileResponse.blob();
                zip.file(doc.name, fileBlob);
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
        link.download = `${assetName}_CIL_Complet.zip`;
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
        link.download = `${assetName}_Carnet_Information_Logement.pdf`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        
        toast.success('Carnet d\'Information du Logement généré avec succès');
      }
      
      onOpenChange(false);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Erreur lors de la génération du PDF');
    } finally {
      setIsGenerating(false);
    }
  }, [assetId, assetName, formData, selectedDocIds, documents, onOpenChange, validate]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Préparer l'export – Carnet d'Information du Logement (CIL)</DialogTitle>
          <DialogDescription>
            Générer un carnet structuré du logement, conforme aux attentes réglementaires
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Paramètres de l'export</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="proprietaire">Nom du propriétaire (optionnel)</Label>
                <Input
                  id="proprietaire"
                  placeholder="Ex: Jean Dupont"
                  value={formData.nomProprietaire}
                  onChange={(e) => setFormData({ ...formData, nomProprietaire: e.target.value })}
                />
              </div>

              <div>
                <Label htmlFor="occupant">Nom de l'occupant (optionnel)</Label>
                <Input
                  id="occupant"
                  placeholder="Ex: Marie Martin"
                  value={formData.nomOccupant}
                  onChange={(e) => setFormData({ ...formData, nomOccupant: e.target.value })}
                />
              </div>

              <div>
                <Label htmlFor="dateMaj">
                  Date de mise à jour du carnet <span className="text-destructive">*</span>
                </Label>
                <DatePicker
                  id="dateMaj"
                  value={formData.dateMiseAJour}
                  onChange={(date) => {
                    setFormData({ ...formData, dateMiseAJour: date });
                    setErrors({ ...errors, dateMiseAJour: '' });
                  }}
                  placeholder="Choisissez une date"
                  className={errors.dateMiseAJour ? 'border-destructive' : ''}
                />
                {errors.dateMiseAJour && (
                  <p className="text-xs text-destructive mt-1">{errors.dateMiseAJour}</p>
                )}
              </div>

              <div>
                <Label htmlFor="notes">Notes générales (optionnel)</Label>
                <Textarea
                  id="notes"
                  placeholder="Ajoutez des informations complémentaires..."
                  rows={3}
                  value={formData.notesGenerales}
                  onChange={(e) => setFormData({ ...formData, notesGenerales: e.target.value })}
                />
              </div>

              <div className="flex items-center justify-between pt-2 border-t">
                <div className="space-y-0.5">
                  <Label className="font-semibold">Générer le dossier ZIP complet avec le PDF et les documents</Label>
                  <p className="text-xs text-muted-foreground">
                    Si coché, un ZIP sera créé contenant le PDF et tous les documents sélectionnés ci-dessous
                  </p>
                </div>
                <Switch
                  checked={formData.genererZipComplet}
                  onCheckedChange={(checked) => 
                    setFormData({ ...formData, genererZipComplet: checked })
                  }
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">
                  Documents inclus ({selectedDocIds.length}/{documents.length})
                </CardTitle>
                <Button variant="link" size="sm" onClick={toggleAll}>
                  {selectedDocIds.length === documents.length ? 'Tout désélectionner' : 'Tout sélectionner'}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>
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
});

ExportCilDialog.displayName = 'ExportCilDialog';

// ========== DOSSIER COMPLET ==========
type DossierCompletFormData = {
  inclurePrives: boolean;
  genererZipComplet: boolean;
};

// 🎯 Helper: Présélectionner les documents pertinents pour Dossier Complet
const getPreselectedForDossierComplet = (documents: DocumentItem[]): string[] => {
  // Pour un dossier complet, tous les documents sont pertinents
  return documents.map(d => d.id);
};

export const ExportDossierCompletDialog = memo(({ 
  open, 
  onOpenChange, 
  assetId, 
  assetName, 
  documents, 
  preselectedDocIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetId: string;
  assetName: string;
  documents: DocumentItem[];
  preselectedDocIds: string[];
}) => {
  const [formData, setFormData] = useState<DossierCompletFormData>({
    inclurePrives: false,
    genererZipComplet: false,
  });
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  // 🎯 Présélectionner les documents pertinents
  useEffect(() => {
    if (open && documents.length > 0) {
      const preselected = getPreselectedForDossierComplet(documents);
      setSelectedDocIds(preselected);
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

  const handleGenerate = useCallback(async () => {
    try {
      setIsGenerating(true);
      const token = localStorage.getItem('bearer_token');

      const response = await fetch('/api/exports/dossier-complet', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          assetId: parseInt(assetId),
          inclurePrives: formData.inclurePrives,
          documentIds: selectedDocIds.map(id => parseInt(id)),
        }),
      });

      if (!response.ok) throw new Error('Erreur lors de la génération');

      const blob = await response.blob();
      
      // Si ZIP complet demandé et documents sélectionnés
      if (formData.genererZipComplet && selectedDocIds.length > 0) {
        const zip = new (await import('jszip')).default();
        
        // Ajouter le PDF au ZIP
        zip.file(`${assetName}_Dossier_Complet.pdf`, blob);
        
        // Télécharger et ajouter les documents sélectionnés
        const selectedDocs = documents.filter(d => selectedDocIds.includes(d.id));
        await Promise.all(
          selectedDocs.map(async (doc) => {
            try {
              const { downloadUrl } = await (await fetch(`/api/files/${doc.id}/download`, {
                headers: { 'Authorization': `Bearer ${token}` }
              })).json();
              
              const fileResponse = await fetch(downloadUrl);
              if (fileResponse.ok) {
                const fileBlob = await fileResponse.blob();
                zip.file(doc.name, fileBlob);
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
        link.download = `${assetName}_Dossier_Complet_Avec_Documents.zip`;
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
        link.download = `${assetName}_Dossier_Complet.pdf`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        
        toast.success('Dossier complet généré avec succès');
      }
      
      onOpenChange(false);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Erreur lors de la génération du PDF');
    } finally {
      setIsGenerating(false);
    }
  }, [assetId, assetName, formData, selectedDocIds, documents, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Préparer l'export – Dossier complet</DialogTitle>
          <DialogDescription>
            Exporter un dossier exhaustif pour archivage ou transfert de propriété
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Paramètres de l'export</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Inclure les documents marqués comme privés</Label>
                  <p className="text-xs text-muted-foreground">
                    Par défaut, les documents privés ne sont pas inclus
                  </p>
                </div>
                <Switch
                  checked={formData.inclurePrives}
                  onCheckedChange={(checked) => 
                    setFormData({ ...formData, inclurePrives: checked })
                  }
                />
              </div>

              <div className="flex items-center justify-between pt-2 border-t">
                <div className="space-y-0.5">
                  <Label className="font-semibold">Générer le dossier ZIP complet avec le PDF et les documents</Label>
                  <p className="text-xs text-muted-foreground">
                    Si coché, un ZIP sera créé contenant le PDF et tous les documents sélectionnés ci-dessous
                  </p>
                </div>
                <Switch
                  checked={formData.genererZipComplet}
                  onCheckedChange={(checked) => 
                    setFormData({ ...formData, genererZipComplet: checked })
                  }
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">
                  Documents inclus ({selectedDocIds.length}/{documents.length})
                </CardTitle>
                <Button variant="link" size="sm" onClick={toggleAll}>
                  {selectedDocIds.length === documents.length ? 'Tout désélectionner' : 'Tout sélectionner'}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>
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
});

ExportDossierCompletDialog.displayName = 'ExportDossierCompletDialog';