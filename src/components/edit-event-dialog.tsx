"use client"

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';
import { Loader2, FileText, X, Upload, FolderOpen, Plus } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { DOCUMENT_TYPE_LABELS } from '@/lib/document-type-constants';
import { computeFileSha256 } from '@/lib/file-validation';

interface EditEventDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  event: {
    id: number;
    eventType: string;
    title: string;
    date: string;
    provider?: string | null;
    costCents?: number | null;
    notes?: string | null;
  };
  assetId: number;
  onEventUpdated: () => void;
}

interface AssetFile {
  id: number;
  originalFilename: string;
  documentType: string;
  uploadedAt: string;
}

interface LinkedDocument {
  id: number;
  fileId: number;
  file: AssetFile;
}

const EVENT_TYPES = [
  { value: 'ACHAT', label: 'Achat' },
  { value: 'ENTRETIEN', label: 'Entretien' },
  { value: 'REPARATION', label: 'Réparation' },
  { value: 'MODIFICATION', label: 'Modification' },
  { value: 'INCIDENT', label: 'Incident' },
  { value: 'AUTRE', label: 'Autre' },
];


export function EditEventDialog({
  open,
  onOpenChange,
  event,
  assetId,
  onEventUpdated,
}: EditEventDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [availableFiles, setAvailableFiles] = useState<AssetFile[]>([]);
  const [linkedDocuments, setLinkedDocuments] = useState<LinkedDocument[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<number[]>([]);
  const [showFileSelector, setShowFileSelector] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  
  const [formData, setFormData] = useState({
    eventType: event.eventType,
    title: event.title,
    date: event.date,
    provider: event.provider || '',
    cost: event.costCents ? (event.costCents / 100).toFixed(2) : '',
    notes: event.notes || '',
  });

  // Load available files and linked documents
  useEffect(() => {
    if (open) {
      loadAvailableFiles();
      loadLinkedDocuments();
    }
  }, [open, assetId, event.id]);

  const loadAvailableFiles = async () => {
    try {
      setIsLoadingFiles(true);
      const token = localStorage.getItem('bearer_token');
      
      const response = await fetch(`/api/files?assetId=${assetId}&uploadStatus=COMPLETED`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Erreur lors du chargement des fichiers');
      }

      const data = await response.json();
      setAvailableFiles(data.data || []);
    } catch (error) {
      console.error('Error loading files:', error);
      toast.error('Erreur lors du chargement des documents disponibles');
    } finally {
      setIsLoadingFiles(false);
    }
  };

  const loadLinkedDocuments = async () => {
    try {
      const token = localStorage.getItem('bearer_token');
      
      const response = await fetch(`/api/events/${event.id}/documents`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Erreur lors du chargement des documents liés');
      }

      const data = await response.json();
      const linked = data.data || [];
      setLinkedDocuments(linked);
      setSelectedFileIds(linked.map((doc: LinkedDocument) => doc.fileId));
    } catch (error) {
      console.error('Error loading linked documents:', error);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    try {
      setIsUploading(true);
      const token = localStorage.getItem('bearer_token');

      for (const file of Array.from(files)) {
        const sha256Hash = await computeFileSha256(file);

        // Step 1: Get presigned URL
        const presignResponse = await fetch('/api/files/presign', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            filename: file.name,
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
            sha256Hash,
            assetId: assetId,
          }),
        });

        if (!presignResponse.ok) {
          throw new Error('Erreur lors de la génération de l\'URL');
        }

        const { uploadUrl, fileKey } = await presignResponse.json();

        // Step 2: Upload to S3
        const uploadResponse = await fetch(uploadUrl, {
          method: 'PUT',
          body: file,
          headers: {
            'Content-Type': file.type,
          },
        });

        if (!uploadResponse.ok) {
          throw new Error('Erreur lors de l\'upload du fichier');
        }

        // Step 3: Confirm upload
        const confirmResponse = await fetch('/api/files/confirm', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            fileKey,
            originalFilename: file.name,
            assetId: assetId,
            documentType: 'AUTRE',
          }),
        });

        if (!confirmResponse.ok) {
          throw new Error('Erreur lors de la confirmation');
        }

        const confirmedFile = await confirmResponse.json();
        
        // Auto-select the newly uploaded file
        setSelectedFileIds(prev => [...prev, confirmedFile.data.id]);
      }

      toast.success('Document(s) ajouté(s) avec succès');
      await loadAvailableFiles();
      setShowFileSelector(false);
    } catch (error) {
      console.error('Error uploading file:', error);
      toast.error('Erreur lors de l\'ajout du document');
    } finally {
      setIsUploading(false);
      // Reset input
      e.target.value = '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.eventType || !formData.title) {
      toast.error('Veuillez remplir les champs obligatoires');
      return;
    }

    try {
      setIsSubmitting(true);
      const token = localStorage.getItem('bearer_token');

      // Convert cost to cents if provided
      const costCents = formData.cost ? Math.round(parseFloat(formData.cost) * 100) : null;

      // Update event details
      const response = await fetch(`/api/events?id=${event.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          eventType: formData.eventType,
          title: formData.title,
          date: formData.date,
          provider: formData.provider || null,
          costCents,
          notes: formData.notes || null,
        }),
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la modification de l\'événement');
      }

      // Update linked documents
      const currentLinkedIds = linkedDocuments.map(doc => doc.fileId);
      const toAdd = selectedFileIds.filter(id => !currentLinkedIds.includes(id));
      const toRemove = currentLinkedIds.filter(id => !selectedFileIds.includes(id));

      // Add new links
      if (toAdd.length > 0) {
        await fetch(`/api/events/${event.id}/documents`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ fileIds: toAdd }),
        });
      }

      // Remove old links
      for (const fileId of toRemove) {
        await fetch(`/api/events/${event.id}/documents?fileId=${fileId}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });
      }

      toast.success('Événement modifié avec succès');
      onOpenChange(false);
      onEventUpdated();
    } catch (error) {
      console.error('Error updating event:', error);
      toast.error('Erreur lors de la modification de l\'événement');
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleFileSelection = (fileId: number) => {
    setSelectedFileIds(prev => 
      prev.includes(fileId) 
        ? prev.filter(id => id !== fileId)
        : [...prev, fileId]
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Modifier l'événement</DialogTitle>
          <DialogDescription>
            Modifiez les informations de l'événement et attachez des documents
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh] pr-4">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="eventType">
                Type d'événement <span className="text-destructive">*</span>
              </Label>
              <Select
                value={formData.eventType}
                onValueChange={(value) => setFormData({ ...formData, eventType: value })}
              >
                <SelectTrigger id="eventType">
                  <SelectValue placeholder="Sélectionnez un type" />
                </SelectTrigger>
                <SelectContent>
                  {EVENT_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="title">
                Titre <span className="text-destructive">*</span>
              </Label>
              <Input
                id="title"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="Ex: Révision annuelle"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="date">Date</Label>
              <DatePicker
                  id="date"
                  value={formData.date}
                  onChange={(d) => setFormData({ ...formData, date: d })}
                />
            </div>

            <div className="space-y-2">
              <Label htmlFor="provider">Fournisseur</Label>
              <Input
                id="provider"
                value={formData.provider}
                onChange={(e) => setFormData({ ...formData, provider: e.target.value })}
                placeholder="Ex: Garage Martin"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="cost">Montant (€)</Label>
              <Input
                id="cost"
                type="number"
                step="0.01"
                min="0"
                value={formData.cost}
                onChange={(e) => setFormData({ ...formData, cost: e.target.value })}
                placeholder="Ex: 150.00"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                placeholder="Informations complémentaires..."
                rows={3}
              />
            </div>

            <div className="space-y-2 pt-4 border-t">
              <div className="flex items-center justify-between">
                <Label>Documents liés</Label>
                
                <Popover open={showFileSelector} onOpenChange={setShowFileSelector}>
                  <PopoverTrigger asChild>
                    <Button 
                      type="button" 
                      variant="outline" 
                      size="sm"
                      className="gap-2"
                    >
                      <Plus className="w-4 h-4" />
                      Ajouter un document
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64 p-2" align="end">
                    <div className="flex flex-col gap-2">
                      <Label 
                        htmlFor="file-upload"
                        className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-muted cursor-pointer transition-colors"
                      >
                        <Upload className="w-4 h-4" />
                        <span className="text-sm">Charger un nouveau fichier</span>
                        <Input
                          id="file-upload"
                          type="file"
                          multiple
                          className="hidden"
                          onChange={handleFileUpload}
                          disabled={isUploading}
                        />
                      </Label>
                      
                      <Button
                        type="button"
                        variant="ghost"
                        className="justify-start gap-2"
                        onClick={() => {
                          setShowFileSelector(false);
                          // Scroll to the file list below
                          setTimeout(() => {
                            document.getElementById('existing-files-list')?.scrollIntoView({ 
                              behavior: 'smooth',
                              block: 'nearest'
                            });
                          }, 100);
                        }}
                      >
                        <FolderOpen className="w-4 h-4" />
                        <span className="text-sm">Choisir parmi les existants</span>
                      </Button>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>

              {isUploading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Upload en cours...</span>
                </div>
              )}

              {/* Selected documents display */}
              {selectedFileIds.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {selectedFileIds.length} document{selectedFileIds.length > 1 ? 's' : ''} sélectionné{selectedFileIds.length > 1 ? 's' : ''}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {selectedFileIds.map((fileId) => {
                      const file = availableFiles.find(f => f.id === fileId);
                      if (!file) return null;
                      return (
                        <Badge 
                          key={fileId} 
                          variant="secondary" 
                          className="gap-1 pr-1"
                        >
                          <FileText className="w-3 h-3" />
                          <span className="max-w-[150px] truncate">{file.originalFilename}</span>
                          <button
                            type="button"
                            onClick={() => toggleFileSelection(fileId)}
                            className="ml-1 rounded-full hover:bg-background/80 p-0.5"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </Badge>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Existing files list */}
              <div id="existing-files-list" className="pt-2">
                <Label className="text-xs text-muted-foreground">Documents disponibles</Label>
                {isLoadingFiles ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                  </div>
                ) : availableFiles.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    Aucun document disponible pour ce bien
                  </p>
                ) : (
                  <div className="space-y-2 max-h-48 overflow-y-auto border rounded-lg p-3 mt-2">
                    {availableFiles.map((file) => (
                      <div
                        key={file.id}
                        className="flex items-start gap-3 p-2 rounded hover:bg-muted/50 cursor-pointer"
                        onClick={() => toggleFileSelection(file.id)}
                      >
                        <Checkbox
                          checked={selectedFileIds.includes(file.id)}
                          onCheckedChange={() => toggleFileSelection(file.id)}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                            <p className="text-sm font-medium truncate">{file.originalFilename}</p>
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <Badge variant="secondary" className="text-xs">
                              {DOCUMENT_TYPE_LABELS[file.documentType] || 'Autre'}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {new Date(file.uploadedAt).toLocaleDateString('fr-FR')}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </form>
        </ScrollArea>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Annuler
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}