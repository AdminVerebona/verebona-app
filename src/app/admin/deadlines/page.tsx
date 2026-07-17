/**
 * @deprecated LEGACY — Page admin deadlines gelée.
 *
 * Cette page est conservée uniquement pour les opérations d'audit et de migration
 * des données legacy vers agenda_items. Elle ne doit plus être liée depuis la nav.
 *
 * Critères de suppression : toutes les données deadlines migrées vers agenda_items
 * (originType = 'legacy_deadline_migration') et validées en prod.
 */
"use client"

import { useEffect, useState } from 'react';
import Link from 'next/link';
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
import { Search, ChevronLeft, ChevronRight, Calendar, CheckCircle2, Clock } from 'lucide-react';
import { apiClient } from '@/lib/api-client';

interface Deadline {
  id: number;
  userId: number;
  assetId: number;
  label: string;
  deadlineDate: string;
  deadlineType: string;
  isDone: boolean;
  doneDate: string | null;
  notes: string | null;
  createdAt: string;
  userEmail: string | null;
  userFirstName: string | null;
  userLastName: string | null;
  assetName: string | null;
  assetCategory: string | null;
}

interface PaginatedResponse {
  data: Deadline[];
  hasMore: boolean;
  nextCursor: string | null;
}

const DEADLINE_TYPES = [
  { value: 'ENTRETIEN', label: 'Entretien' },
  { value: 'CONTROLE_TECHNIQUE', label: 'Contrôle technique' },
  { value: 'ASSURANCE', label: 'Assurance' },
  { value: 'GARANTIE', label: 'Garantie' },
  { value: 'ADMINISTRATIF', label: 'Administratif' },
  { value: 'AUTRE', label: 'Autre' },
];

export default function AdminDeadlinesPage() {
  const [deadlines, setDeadlines] = useState<Deadline[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Filters
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const limit = 20;

  useEffect(() => {
    loadDeadlines();
  }, [search, typeFilter, statusFilter, cursor]);

  const loadDeadlines = async () => {
    try {
      setIsLoading(true);
      setError(null);

      // Build query params
      const params = new URLSearchParams({
        limit: limit.toString(),
      });

      if (cursor) params.append('cursor', cursor);
      if (search) params.append('search', search);
      if (typeFilter && typeFilter !== 'all') params.append('deadlineType', typeFilter);
      if (statusFilter && statusFilter !== 'all') {
        params.append('isDone', statusFilter === 'done' ? 'true' : 'false');
      }

      const result = await apiClient.get<PaginatedResponse>(`/api/admin/deadlines?${params.toString()}`);
      setDeadlines(result.data);
      setHasMore(result.hasMore);
      setNextCursor(result.nextCursor);
    } catch (err) {
      console.error('Error loading deadlines:', err);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setCursor(null);
  };

  const handleNextPage = () => {
    if (hasMore && nextCursor) {
      setCursor(nextCursor);
    }
  };

  const handlePreviousPage = () => {
    setCursor(null);
  };

  const formatDate = (dateStr: string) => {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  };

  const getTypeBadge = (type: string) => {
    const label = DEADLINE_TYPES.find(t => t.value === type)?.label || type;
    return <Badge variant="outline">{label}</Badge>;
  };

  const getStatusBadge = (isDone: boolean, deadlineDate: string) => {
    if (isDone) {
      return <Badge variant="active" className="bg-green-100 text-green-800 border-green-200">Terminé</Badge>;
    }
    
    const isOverdue = new Date(deadlineDate) < new Date();
    if (isOverdue) {
      return <Badge variant="destructive">En retard</Badge>;
    }
    
    return <Badge variant="secondary" className="bg-blue-100 text-blue-800 border-blue-200">À venir</Badge>;
  };

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <p className="text-center text-destructive">{error}</p>
            <Button className="w-full mt-4" onClick={loadDeadlines}>Réessayer</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl md:text-3xl font-bold">Gestion des échéances</h1>
        <p className="text-muted-foreground mt-1">
          Suivi de tous les rappels et maintenances des utilisateurs
        </p>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Filtres</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
            <div className="relative">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Rechercher (label, notes)..."
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-9"
              />
            </div>

            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger>
                <SelectValue placeholder="Tous les types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les types</SelectItem>
                {DEADLINE_TYPES.map(type => (
                  <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger>
                <SelectValue placeholder="Tous les statuts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les statuts</SelectItem>
                <SelectItem value="pending">À venir / En retard</SelectItem>
                <SelectItem value="done">Terminé</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Deadlines Table */}
      <Card>
        <CardHeader>
          <CardTitle>
            Échéances ({deadlines.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
          ) : deadlines.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              Aucune échéance trouvée
            </div>
          ) : (
            <div className="space-y-3">
              {deadlines.map((deadline) => (
                <div
                  key={deadline.id}
                  className="p-4 rounded-lg border hover:bg-accent/50 transition-colors"
                >
                  <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-lg">
                          {deadline.label}
                        </span>
                        {getTypeBadge(deadline.deadlineType)}
                        {getStatusBadge(deadline.isDone, deadline.deadlineDate)}
                      </div>
                      
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm text-muted-foreground">
                        <div className="flex items-center gap-2">
                          <Calendar className="h-4 w-4" />
                          <span>Échéance : <strong>{formatDate(deadline.deadlineDate)}</strong></span>
                        </div>
                        {deadline.isDone && (
                          <div className="flex items-center gap-2 text-green-600">
                            <CheckCircle2 className="h-4 w-4" />
                            <span>Réalisé le : {formatDate(deadline.doneDate || '')}</span>
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <Clock className="h-4 w-4" />
                          <span>Créé le : {formatDate(deadline.createdAt)}</span>
                        </div>
                      </div>

                      <div className="pt-2 border-t mt-2 flex flex-col sm:flex-row gap-4">
                        <div className="text-sm">
                          <span className="text-muted-foreground">Utilisateur : </span>
                          <Link href={`/admin/users/${deadline.userId}`} className="text-primary hover:underline font-medium">
                            {deadline.userFirstName} {deadline.userLastName} ({deadline.userEmail})
                          </Link>
                        </div>
                        <div className="text-sm">
                          <span className="text-muted-foreground">Bien : </span>
                          <Link href={`/admin/assets/${deadline.assetId}`} className="text-primary hover:underline font-medium">
                            {deadline.assetName}
                          </Link>
                        </div>
                      </div>

                      {deadline.notes && (
                        <div className="text-sm bg-muted/50 p-2 rounded mt-2">
                          <span className="text-muted-foreground block text-xs uppercase font-bold mb-1">Notes :</span>
                          {deadline.notes}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Pagination */}
          {!isLoading && deadlines.length > 0 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t">
              <Button
                variant="outline"
                size="sm"
                onClick={handlePreviousPage}
                disabled={!cursor}
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                Première page
              </Button>
              <span className="text-sm text-muted-foreground">
                Affichage de {deadlines.length} échéance{deadlines.length > 1 ? 's' : ''}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={handleNextPage}
                disabled={!hasMore}
              >
                Suivant
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
