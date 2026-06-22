"use client";

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FileIcon, Loader2, Clock } from 'lucide-react';
import { toast } from 'sonner';

interface DocumentSuggestion {
  id: number;
  fileName: string;
  mimeType: string;
  fileSize: number;
  documentType: string;
  documentDate: string | null;
  uploadedAt: string;
}

interface DocumentSuggestionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventId: number;
  onAssociate?: () => void;
}

export function DocumentSuggestionsDialog({
  open,
  onOpenChange,
  eventId,
  onAssociate,
}: DocumentSuggestionsDialogProps) {
  const [suggestions, setSuggestions] = useState<DocumentSuggestion[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAssociating, setIsAssociating] = useState(false);
  const [windowMinutes, setWindowMinutes] = useState(10);

  useEffect(() => {
    if (open && eventId) {
      fetchSuggestions();
    }
  }, [open, eventId]);

  const fetchSuggestions = async () => {
    setIsLoading(true);
    try {
      const token = localStorage.getItem('bearer_token');
      const response = await fetch(`/api/events/${eventId}/suggestions`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Échec de la récupération des suggestions');
      }

      const data = await response.json();
      setSuggestions(data.suggestions || []);
      setWindowMinutes(data.windowMinutes || 10);
      
      // Pre-select all suggestions
      setSelectedIds(data.suggestions?.map((s: DocumentSuggestion) => s.id) || []);
    } catch (error) {
      console.error('Fetch suggestions error:', error);
      toast.error('Erreur lors de la récupération des suggestions');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAssociate = async () => {
    if (selectedIds.length === 0) {
      onOpenChange(false);
      return;
    }

    setIsAssociating(true);
    try {
      const token = localStorage.getItem('bearer_token');
      const response = await fetch(`/api/events/${eventId}/documents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          fileIds: selectedIds,
        }),
      });

      if (!response.ok) {
        throw new Error('Échec de l\'association des documents');
      }

      toast.success(`${selectedIds.length} document(s) associé(s) avec succès`);
      onAssociate?.();
      onOpenChange(false);
    } catch (error) {
      console.error('Associate documents error:', error);
      toast.error('Erreur lors de l\'association des documents');
    } finally {
      setIsAssociating(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getFilePreview = (mimeType: string) => {
    if (mimeType.startsWith('image/')) {
      return '🖼️';
    }
    if (mimeType === 'application/pdf') {
      return '📄';
    }
    if (mimeType.includes('word') || mimeType.includes('document')) {
      return '📝';
    }
    if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) {
      return '📊';
    }
    return '📎';
  };

  // Don't show dialog if no suggestions
  if (!isLoading && suggestions.length === 0) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Document récent détecté</DialogTitle>
          <DialogDescription>
            <div className="flex items-center gap-2 text-[color:var(--text-muted)]">
              <Clock className="w-4 h-4" />
              <span>
                Nous avons trouvé {suggestions.length} document(s) téléchargé(s) dans les {windowMinutes} dernières minutes
              </span>
            </div>
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-8 h-8 animate-spin text-[color:var(--accent)]" />
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-[color:var(--text-muted)]">
              Souhaitez-vous associer ces documents à l'événement que vous venez de créer ?
            </p>

            <div className="space-y-2 max-h-96 overflow-y-auto">
              {suggestions.map((doc) => (
                <label
                  key={doc.id}
                  className="flex items-start gap-3 p-3 border border-[color:var(--border-subtle)] rounded-lg cursor-pointer hover:bg-[color:var(--accent-soft)] transition-colors"
                >
                  <Checkbox
                    checked={selectedIds.includes(doc.id)}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        setSelectedIds(prev => [...prev, doc.id]);
                      } else {
                        setSelectedIds(prev => prev.filter(id => id !== doc.id));
                      }
                    }}
                    className="mt-1"
                  />
                  
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start gap-2">
                      <span className="text-2xl">{getFilePreview(doc.mimeType)}</span>
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
                        <p className="text-xs text-[color:var(--text-muted)] mt-1">
                          Téléchargé {new Date(doc.uploadedAt).toLocaleString('fr-FR')}
                        </p>
                      </div>
                    </div>
                  </div>
                </label>
              ))}
            </div>

            <div className="flex justify-between items-center pt-4 border-t border-[color:var(--border-subtle)]">
              <p className="text-sm text-[color:var(--text-muted)]">
                {selectedIds.length} document(s) sélectionné(s)
              </p>
              <div className="flex gap-3">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                  disabled={isAssociating}
                >
                  Ignorer
                </Button>
                <Button
                  onClick={handleAssociate}
                  disabled={selectedIds.length === 0 || isAssociating}
                  className="bg-gradient-to-br from-[#3b82f6] to-[#1d4ed8]"
                >
                  {isAssociating ? (
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
        )}
      </DialogContent>
    </Dialog>
  );
}
