"use client";

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { FileIcon, Plus, Trash2, Loader2, Search, Upload, FolderOpen } from 'lucide-react';
import { toast } from 'sonner';
import { UnifiedDocumentDialog } from '@/components/documents/unified-document-dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface LinkedDocument {
  id: number;
  fileName: string;
  mimeType: string;
  fileSize: number;
  documentType: string;
  documentDate: string | null;
  createdAt: string;
}

interface LinkedDocumentsSectionProps {
  eventId: number;
  assetId: number;
  onRefresh?: () => void;
}

export function LinkedDocumentsSection({
  eventId,
  assetId,
  onRefresh,
}: LinkedDocumentsSectionProps) {
  const [documents, setDocuments] = useState<LinkedDocument[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [availableDocuments, setAvailableDocuments] = useState<any[]>([]);
  const [selectedDocIds, setSelectedDocIds] = useState<number[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [isLinking, setIsLinking] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);

  useEffect(() => {
    fetchLinkedDocuments();
  }, [eventId]);

  const fetchLinkedDocuments = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/events/${eventId}/documents`, {
      credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Échec de la récupération des documents');
      }

      const data = await response.json();
      setDocuments(data.data?.map((item: any) => item.file) || []);
    } catch (error) {
      console.error('Fetch documents error:', error);
      toast.error('Erreur lors de la récupération des documents');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchAvailableDocuments = async () => {
    try {
      const response = await fetch(`/api/documents?assetId=${assetId}`, {
      credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Échec de la récupération des documents disponibles');
      }

      const data = await response.json();
      
      // Filter out already linked documents
      const linkedIds = new Set(documents.map(d => d.id));
      const available = data.data?.filter((doc: any) => !linkedIds.has(doc.id)) || [];
      
      setAvailableDocuments(available);
    } catch (error) {
      console.error('Fetch available documents error:', error);
      toast.error('Erreur lors de la récupération des documents disponibles');
    }
  };

  const handleOpenLinkDialog = () => {
    setShowLinkDialog(true);
    fetchAvailableDocuments();
  };

  const handleLinkDocuments = async () => {
    if (selectedDocIds.length === 0) {
      toast.error('Veuillez sélectionner au moins un document');
      return;
    }

    setIsLinking(true);
    try {
      const response = await fetch(`/api/events/${eventId}/documents`, {
      credentials: 'include',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fileIds: selectedDocIds,
        }),
      });

      if (!response.ok) {
        throw new Error('Échec de l\'association des documents');
      }

      toast.success(`${selectedDocIds.length} document(s) associé(s) avec succès`);
      setSelectedDocIds([]);
      setShowLinkDialog(false);
      fetchLinkedDocuments();
      onRefresh?.();
    } catch (error) {
      console.error('Link documents error:', error);
      toast.error('Erreur lors de l\'association des documents');
    } finally {
      setIsLinking(false);
    }
  };

  const handleUnlinkDocument = async (documentId: number) => {
    if (!confirm('Êtes-vous sûr de vouloir dissocier ce document ?')) {
      return;
    }

    try {
      const response = await fetch(`/api/events/${eventId}/documents?fileId=${documentId}`, {
      credentials: 'include',
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Échec de la dissociation du document');
      }

      toast.success('Document dissocié avec succès');
      fetchLinkedDocuments();
      onRefresh?.();
    } catch (error) {
      console.error('Unlink document error:', error);
      toast.error('Erreur lors de la dissociation du document');
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const filteredDocuments = availableDocuments.filter(doc =>
    doc.fileName.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <>
      <Card className="border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Documents liés</CardTitle>
            <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
              <PopoverTrigger asChild>
                <Button
                  size="sm"
                  className="gap-2 bg-gradient-to-br from-[#3b82f6] to-[#1d4ed8]"
                >
                  <Plus className="w-4 h-4" />
                  Ajouter un document
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-2" align="end">
                <div className="flex flex-col gap-1">
                  <Button
                    variant="ghost"
                    className="w-full justify-start gap-3 h-auto py-3 px-3"
                    onClick={() => {
                      setPopoverOpen(false);
                      setShowAddDialog(true);
                    }}
                  >
                    <Upload className="w-4 h-4 flex-shrink-0" />
                    <div className="flex flex-col items-start flex-1">
                      <span className="font-medium">Charger un nouveau fichier</span>
                      <span className="text-xs text-[color:var(--text-muted)]">Uploader depuis votre appareil</span>
                    </div>
                  </Button>
                  <Button
                    variant="ghost"
                    className="w-full justify-start gap-3 h-auto py-3 px-3"
                    onClick={() => {
                      setPopoverOpen(false);
                      handleOpenLinkDialog();
                    }}
                  >
                    <FolderOpen className="w-4 h-4 flex-shrink-0" />
                    <div className="flex flex-col items-start flex-1">
                      <span className="font-medium">Choisir parmi les existants</span>
                      <span className="text-xs text-[color:var(--text-muted)]">Documents déjà uploadés</span>
                    </div>
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-[color:var(--accent)]" />
            </div>
          ) : documents.length === 0 ? (
            <div className="text-center py-8 text-[color:var(--text-muted)]">
              <FileIcon className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>Aucun document lié à cet événement</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {documents.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-start gap-3 p-3 border border-[color:var(--border-subtle)] rounded-lg hover:bg-[color:var(--accent-soft)] transition-colors"
                >
                  <div className="w-10 h-10 flex items-center justify-center bg-[color:var(--accent-soft)] rounded flex-shrink-0">
                    <FileIcon className="w-5 h-5 text-[color:var(--accent)]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{doc.fileName}</p>
                    <div className="flex flex-wrap gap-2 mt-1">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-[color:var(--accent-soft)] text-[color:var(--text-muted)]">
                        {doc.documentType}
                      </span>
                      <span className="text-xs text-[color:var(--text-muted)]">
                        {formatFileSize(doc.fileSize)}
                      </span>
                      {doc.documentDate && (
                        <span className="text-xs text-[color:var(--text-muted)]">
                          {new Date(doc.documentDate).toLocaleDateString('fr-FR')}
                        </span>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleUnlinkDocument(doc.id)}
                    className="flex-shrink-0"
                  >
                    <Trash2 className="w-4 h-4 text-red-500" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Document Dialog */}
      <UnifiedDocumentDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        preselectedAssetId={assetId}
        preselectedEventIds={[eventId]}
        onSuccess={() => {
          fetchLinkedDocuments();
          onRefresh?.();
        }}
      />

      {/* Link Existing Documents Dialog */}
      <Dialog open={showLinkDialog} onOpenChange={setShowLinkDialog}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Associer des documents existants</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
            <div>
              <Label htmlFor="search">Rechercher</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[color:var(--text-muted)]" />
                <Input
                  id="search"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Rechercher un document..."
                  className="pl-10"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2">
              {filteredDocuments.length === 0 ? (
                <div className="text-center py-8 text-[color:var(--text-muted)]">
                  {searchTerm ? 'Aucun document trouvé' : 'Aucun document disponible'}
                </div>
              ) : (
                filteredDocuments.map((doc) => (
                  <label
                    key={doc.id}
                    className="flex items-start gap-3 p-3 border border-[color:var(--border-subtle)] rounded-lg cursor-pointer hover:bg-[color:var(--accent-soft)] transition-colors"
                  >
                    <Checkbox
                      checked={selectedDocIds.includes(doc.id)}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setSelectedDocIds(prev => [...prev, doc.id]);
                        } else {
                          setSelectedDocIds(prev => prev.filter(id => id !== doc.id));
                        }
                      }}
                      className="mt-1"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{doc.fileName}</p>
                      <div className="flex flex-wrap gap-2 mt-1">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-[color:var(--accent-soft)] text-[color:var(--text-muted)]">
                          {doc.documentType}
                        </span>
                        {doc.asset && (
                          <span className="text-xs text-[color:var(--text-muted)]">
                            {doc.asset.name}
                          </span>
                        )}
                      </div>
                    </div>
                  </label>
                ))
              )}
            </div>

            <div className="flex justify-between items-center pt-4 border-t border-[color:var(--border-subtle)]">
              <p className="text-sm text-[color:var(--text-muted)]">
                {selectedDocIds.length} document(s) sélectionné(s)
              </p>
              <div className="flex gap-3">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setShowLinkDialog(false)}
                  disabled={isLinking}
                >
                  Annuler
                </Button>
                <Button
                  onClick={handleLinkDocuments}
                  disabled={selectedDocIds.length === 0 || isLinking}
                  className="bg-gradient-to-br from-[#3b82f6] to-[#1d4ed8]"
                >
                  {isLinking ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Association...
                    </>
                  ) : (
                    'Associer'
                  )}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}