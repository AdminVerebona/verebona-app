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
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { apiClient } from '@/lib/api-client';

interface User {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  username: string | null;
  company: string | null;
  planType: string;
  accountId: number | null;
  accountName: string | null;
  role: string;
  status: string;
  createdAt: string;
  assetCount: number;
}

interface PaginatedResponse {
  data: User[];
  hasMore: boolean;
  nextCursor: string | null;
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const limit = 20;

  useEffect(() => {
    loadUsers();
  }, [search, statusFilter, roleFilter, cursor]);

    const loadUsers = async () => {
      try {
        setIsLoading(true);
        setError(null);
  
        // Build query params
        const params = new URLSearchParams({
          limit: limit.toString(),
        });
  
        if (cursor) params.append('cursor', cursor);
        if (search) params.append('search', search);
        if (statusFilter && statusFilter !== 'all') params.append('status', statusFilter);
        if (roleFilter && roleFilter !== 'all') params.append('role', roleFilter);
  
        const result = await apiClient.get<PaginatedResponse>(`/api/admin/users?${params.toString()}`);
        setUsers(result.data);
        setHasMore(result.hasMore);
        setNextCursor(result.nextCursor);
      } catch (err) {
        console.error('Error loading users:', err);
        setError(err instanceof Error ? err.message : 'Erreur inconnue');
      } finally {
        setIsLoading(false);
      }
    };


  const handleSearchChange = (value: string) => {
    setSearch(value);
    setCursor(null); // Reset cursor on search
  };

  const handleNextPage = () => {
    if (hasMore && nextCursor) {
      setCursor(nextCursor);
    }
  };

  const handlePreviousPage = () => {
    setCursor(null); // Reset to first page
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '—';
    try {
      // Handle epoch-as-string (legacy data) and ISO strings
      const n = Number(dateStr);
      const d = !isNaN(n) && String(n) === String(dateStr).trim()
        ? new Date(n > 1e12 ? n : n * 1000)
        : new Date(dateStr);
      if (isNaN(d.getTime())) return '—';
      return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch { return '—'; }
  };

  const getStatusBadge = (status: string) => {
    return status === 'ACTIVE' ? (
      <Badge variant="active">Actif</Badge>
    ) : status === 'SUSPENDED' ? (
      <Badge variant="inactive">Suspendu</Badge>
    ) : (
      <Badge variant="destructive">Supprimé</Badge>
    );
  };

  const getRoleBadge = (role: string) => {
    return role === 'ADMIN' ? (
      <Badge variant="default">Admin</Badge>
    ) : (
      <Badge variant="outline">Utilisateur</Badge>
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
        <h1 className="text-2xl md:text-3xl font-bold">Gestion des utilisateurs</h1>
        <p className="text-muted-foreground mt-1">
          Liste complète de tous les utilisateurs de la plateforme
        </p>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Filtres</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
            <div className="relative">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Rechercher (email, nom)..."
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-9"
              />
            </div>

            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger>
                <SelectValue placeholder="Tous les statuts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les statuts</SelectItem>
                <SelectItem value="ACTIVE">Actif</SelectItem>
                <SelectItem value="SUSPENDED">Suspendu</SelectItem>
              </SelectContent>
            </Select>

            <Select value={roleFilter} onValueChange={setRoleFilter}>
              <SelectTrigger>
                <SelectValue placeholder="Tous les rôles" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les rôles</SelectItem>
                <SelectItem value="USER">Utilisateur</SelectItem>
                <SelectItem value="ADMIN">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Users Table */}
      <Card>
        <CardHeader>
          <CardTitle>
            Utilisateurs ({users.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-20" />
              ))}
            </div>
          ) : users.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              Aucun utilisateur trouvé
            </div>
          ) : (
            <div className="space-y-3">
              {users.map((user) => (
                <Link
                  key={user.id}
                  href={`/admin/users/${user.id}`}
                  className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-lg border hover:bg-accent transition-colors gap-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium truncate">
                        {user.firstName} {user.lastName}
                      </span>
                      {getRoleBadge(user.role)}
                      {getStatusBadge(user.status)}
                    </div>
                    <div className="text-sm text-muted-foreground mt-1 truncate">
                      {user.email}
                    </div>
                    {user.company && (
                      <div className="text-xs text-muted-foreground truncate">
                        {user.company}
                      </div>
                    )}
                  </div>
                  <div className="sm:text-right flex sm:flex-col flex-wrap gap-x-3 gap-y-0.5 flex-shrink-0">
                    <div className="text-sm font-medium">
                      {user.assetCount} bien{user.assetCount > 1 ? 's' : ''}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {user.planType}
                      {user.accountName && (
                        <span className="ml-1 opacity-60">· {user.accountName}</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatDate(user.createdAt)}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}

          {/* Pagination */}
          {!isLoading && users.length > 0 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t">
              <Button
                variant="outline"
                size="sm"
                onClick={handlePreviousPage}
                disabled={!cursor}
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                Précédent
              </Button>
              <span className="text-sm text-muted-foreground">
                {users.length} utilisateur{users.length > 1 ? 's' : ''}
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