"use client";

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Calendar, Trash2, Loader2, Search, Plus, Link2 } from 'lucide-react';
import { toast } from 'sonner';
import Link from 'next/link';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { CreateAgendaItemDrawer } from '@/components/agenda/CreateAgendaItemDrawer';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

interface LinkedEvent {
  id: number;
  title: string;
  date: string;
  eventType: string;
  provider: string | null;
  costCents: number | null;
  assetId: number;
}

interface LinkedEventsSectionProps {
  documentId: number;
  assetId: number | null;
  onRefresh?: () => void;
}

// ⚠️ Uniformiser sur les catégories réelles (lowercase) utilisées par la BDD/API
const EVENT_TYPE_LABELS: Record<string, string> = {
  achat: 'Achat',
  vente: 'Vente',
  entretien: 'Entretien',
  reparation: 'Réparation',
  sinistre: 'Sinistre',
  controle: 'Contrôle',
  garantie: 'Garantie',
  autre: 'Autre',
};

const getCategoryLabel = (value?: string) => {
  if (!value) return 'Autre';
  const key = value.toLowerCase();
  return EVENT_TYPE_LABELS[key] || value;
};

export function LinkedEventsSection({
  documentId,
  assetId,
  onRefresh,
}: LinkedEventsSectionProps) {
  const [events, setEvents] = useState<LinkedEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [availableEvents, setAvailableEvents] = useState<any[]>([]);
  const [selectedEventIds, setSelectedEventIds] = useState<number[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [isLinking, setIsLinking] = useState(false);
  // Confirm unlink dialog state
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  // ➕ Création d'événement depuis la modale de document
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  useEffect(() => {
    fetchLinkedEvents();
  }, [documentId]);

  const fetchLinkedEvents = async () => {
    setIsLoading(true);
    try {
      

      if (!documentId || isNaN(documentId)) {
        console.error('Invalid documentId:', documentId);
        toast.error('ID de document invalide');
        return;
      }

      const response = await fetch(`/api/documents/${documentId}/events`, {
      credentials: 'include',
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Erreur inconnue' }));
        console.error('API error:', response.status, errorData);
        throw new Error(errorData.message || `Erreur ${response.status}`);
      }

      const data = await response.json();
      setEvents(data.events || []);
    } catch (error) {
      console.error('Fetch events error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
      toast.error(`Erreur lors de la récupération des événements: ${errorMessage}`);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchAvailableEvents = async () => {
    if (!assetId) {
      toast.error('Ce document n\'est pas associé à un bien');
      return;
    }

    try {
      

      const response = await fetch(`/api/events?assetId=${assetId}`, {
      credentials: 'include',
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Erreur inconnue' }));
        throw new Error(errorData.message || `Erreur ${response.status}`);
      }

      const data = await response.json();
      
      const linkedIds = new Set(events.map(e => e.id));
      const available = data.data?.filter((event: any) => !linkedIds.has(event.id)) || [];
      
      setAvailableEvents(available);
    } catch (error) {
      console.error('Fetch available events error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
      toast.error(`Erreur: ${errorMessage}`);
    }
  };

  const handleOpenLinkDialog = () => {
    setShowLinkDialog(true);
    fetchAvailableEvents();
  };

  const handleLinkEvents = async () => {
    if (selectedEventIds.length === 0) {
      toast.error('Veuillez sélectionner au moins un événement');
      return;
    }

    setIsLinking(true);
    try {
      const response = await fetch(`/api/documents/${documentId}/events`, {
      credentials: 'include',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          eventIds: selectedEventIds,
        }),
      });

      if (!response.ok) {
        throw new Error('Échec de l\'association des événements');
      }

      toast.success(`${selectedEventIds.length} événement(s) associé(s) avec succès`);
      setSelectedEventIds([]);
      setShowLinkDialog(false);
      fetchLinkedEvents();
      onRefresh?.();
    } catch (error) {
      console.error('Link events error:', error);
      toast.error('Erreur lors de l\'association des événements');
    } finally {
      setIsLinking(false);
    }
  };

  const requestUnlinkEvent = (eventId: number) => {
    setPendingDeleteId(eventId);
    setConfirmOpen(true);
  };

  const confirmUnlink = async () => {
    if (!pendingDeleteId) return;
    try {
      setIsDeleting(true);
      const response = await fetch(`/api/documents/${documentId}/events?eventId=${pendingDeleteId}`, {
      credentials: 'include',
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Échec de la dissociation de l\'événement');
      }

      toast.success('Événement dissocié avec succès');
      fetchLinkedEvents();
      onRefresh?.();
    } catch (error) {
      console.error('Unlink event error:', error);
      toast.error('Erreur lors de la dissociation de l\'événement');
    } finally {
      setIsDeleting(false);
      setConfirmOpen(false);
      setPendingDeleteId(null);
    }
  };

  // ➕ Après création, lier automatiquement le nouvel événement au document
  const handleEventCreatedAndLink = async (createdEventId: number) => {
    try {
      const response = await fetch(`/api/documents/${documentId}/events`, {
      credentials: 'include',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ eventIds: [createdEventId] }),
      });

      if (!response.ok) {
        throw new Error('Impossible de lier le nouvel événement au document');
      }

      toast.success('Événement créé et lié au document');
      setShowCreateDialog(false);
      fetchLinkedEvents();
      onRefresh?.();
    } catch (error) {
      console.error('Auto-link after create error:', error);
      toast.error('Événement créé, mais la liaison au document a échoué');
    }
  };

  const formatCost = (costCents: number | null) => {
    if (costCents === null) return null;
    return `${(costCents / 100).toFixed(2)} €`;
  };

  // Recherche: tenir compte du libellé de catégorie réel (categorie)
  const filteredEvents = availableEvents.filter((event) => {
    const titleMatch = (event.title || '').toLowerCase().includes(searchTerm.toLowerCase());
    const label = getCategoryLabel(event.categorie || event.eventType);
    const labelMatch = label.toLowerCase().includes(searchTerm.toLowerCase());
    return titleMatch || labelMatch;
  });

  return (
    <>
      <Card className="border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Événements liés</CardTitle>
            {assetId && (
              <div className="flex items-center gap-2">
                {/* Un seul bouton avec menu d'actions */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      className="gap-2 bg-gradient-to-br from-[#3b82f6] to-[#1d4ed8]"
                    >
                      <Plus className="w-4 h-4" />
                      Ajouter un événement
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setShowCreateDialog(true)}>
                      <Plus className="w-4 h-4" />
                      Créer un événement
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleOpenLinkDialog}>
                      <Link2 className="w-4 h-4" />
                      Associer à un événement existant
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-[color:var(--accent)]" />
            </div>
          ) : events.length === 0 ? (
            <div className="text-center py-8 text-[color:var(--text-muted)]">
              <Calendar className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>Aucun événement lié à ce document</p>
            </div>
          ) : (
            <div className="space-y-3">
              {events.map((event) => (
                <div
                  key={event.id}
                  className="flex items-start gap-3 p-3 border border-[color:var(--border-subtle)] rounded-lg hover:bg-[color:var(--accent-soft)] transition-colors"
                >
                  <div className="w-10 h-10 flex items-center justify-center bg-[color:var(--accent-soft)] rounded flex-shrink-0">
                    <Calendar className="w-5 h-5 text-[color:var(--accent)]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <Link
                      href={`/assets/${event.assetId}#events`}
                      className="text-sm font-medium hover:underline truncate block"
                    >
                      {event.title}
                    </Link>
                    <div className="flex flex-wrap gap-2 mt-1">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-[color:var(--accent-soft)] text-[color:var(--text-muted)]">
                        {getCategoryLabel((event as any).categorie || event.eventType)}
                      </span>
                      <span className="text-xs text-[color:var(--text-muted)]">
                        {new Date(event.date).toLocaleDateString('fr-FR')}
                      </span>
                      {event.provider && (
                        <span className="text-xs text-[color:var(--text-muted)]">
                          {event.provider}
                        </span>
                      )}
                      {event.costCents !== null && (
                        <span className="text-xs text-[color:var(--text-muted)] font-medium">
                          {formatCost(event.costCents)}
                        </span>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => requestUnlinkEvent(event.id)}
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

      <Dialog open={showLinkDialog} onOpenChange={setShowLinkDialog}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Associer à des événements</DialogTitle>
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
                  placeholder="Rechercher un événement..."
                  className="pl-10"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2">
              {filteredEvents.length === 0 ? (
                <div className="text-center py-8 text-[color:var(--text-muted)]">
                  {searchTerm ? 'Aucun événement trouvé' : 'Aucun événement disponible'}
                </div>
              ) : (
                filteredEvents.map((event) => (
                  <label
                    key={event.id}
                    className="flex items-start gap-3 p-3 border border-[color:var(--border-subtle)] rounded-lg cursor-pointer hover:bg-[color:var(--accent-soft)] transition-colors"
                  >
                    <Checkbox
                      checked={selectedEventIds.includes(event.id)}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setSelectedEventIds(prev => [...prev, event.id]);
                        } else {
                          setSelectedEventIds(prev => prev.filter(id => id !== event.id));
                        }
                      }}
                      className="mt-1"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{event.title}</p>
                      <div className="flex flex-wrap gap-2 mt-1">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-[color:var(--accent-soft)] text-[color:var(--text-muted)]">
                          {getCategoryLabel(event.categorie || event.eventType)}
                        </span>
                        <span className="text-xs text-[color:var(--text-muted)]">
                          {new Date(event.date).toLocaleDateString('fr-FR')}
                        </span>
                        {event.provider && (
                          <span className="text-xs text-[color:var(--text-muted)]">
                            {event.provider}
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
                {selectedEventIds.length} événement(s) sélectionné(s)
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
                  onClick={handleLinkEvents}
                  disabled={selectedEventIds.length === 0 || isLinking}
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

      {/* Confirmation de dissociation */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmer la dissociation</AlertDialogTitle>
            <AlertDialogDescription>
              Voulez-vous vraiment dissocier cet événement du document ? Cette action est réversible en le ré-associant plus tard.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={confirmUnlink} disabled={isDeleting}>
              {isDeleting ? 'Suppression...' : 'Dissocier'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ➕ Modale de création d'élément d'agenda */}
      {assetId && (
        <CreateAgendaItemDrawer
          open={showCreateDialog}
          onClose={() => setShowCreateDialog(false)}
          onMutated={onRefresh ?? (() => {})}
        />
      )}
    </>
  );
}