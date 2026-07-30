'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Webhook, CheckCircle, XCircle, Clock, RefreshCw, Search } from 'lucide-react';

interface WebhookLog {
  id: number;
  eventId: string;
  eventType: string;
  payload: string;
  processed: boolean;
  errorMessage: string | null;
  processingTimeMs: number | null;
  createdAt: number;
}

export default function AdminStripeWebhooksPage() {
  const [webhooks, setWebhooks] = useState<WebhookLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Filters
  const [eventTypeFilter, setEventTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    loadWebhooks();
  }, []);

  const loadWebhooks = async () => {
    try {
      setIsLoading(true);
      setError(null);


      const response = await fetch('/api/admin/stripe-webhooks', {
      credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Erreur lors du chargement des webhooks');
      }

      const data = await response.json();
      setWebhooks(data.webhooks || []);
    } catch (err) {
      console.error('Error loading webhooks:', err);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsLoading(false);
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const getEventTypeBadge = (eventType: string) => {
    if (eventType.includes('checkout')) {
      return <Badge variant="default" className="bg-blue-600">Checkout</Badge>;
    }
    if (eventType.includes('subscription')) {
      return <Badge variant="default" className="bg-purple-600">Subscription</Badge>;
    }
    if (eventType.includes('invoice')) {
      return <Badge variant="default" className="bg-green-600">Invoice</Badge>;
    }
    return <Badge variant="outline">{eventType.split('.')[0]}</Badge>;
  };

  const filteredWebhooks = webhooks.filter((webhook) => {
    // Event type filter
    if (eventTypeFilter !== 'all' && !webhook.eventType.includes(eventTypeFilter)) {
      return false;
    }

    // Status filter
    if (statusFilter === 'success' && !webhook.processed) return false;
    if (statusFilter === 'failed' && webhook.processed) return false;

    // Search query
    if (searchQuery && !webhook.eventId.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }

    return true;
  });

  const uniqueEventTypes = Array.from(new Set(webhooks.map(w => w.eventType.split('.')[0])));

  const stats = {
    total: webhooks.length,
    success: webhooks.filter(w => w.processed).length,
    failed: webhooks.filter(w => !w.processed).length,
    avgProcessingTime: webhooks.length > 0
      ? Math.round(
          webhooks
            .filter(w => w.processingTimeMs !== null)
            .reduce((acc, w) => acc + (w.processingTimeMs || 0), 0) / webhooks.length
        )
      : 0,
  };

  if (error) {
    return (
      <div className="space-y-4">
        <Card>
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
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Webhooks Stripe</h1>
          <p className="text-muted-foreground mt-1">
            Journal des événements webhooks Stripe
          </p>
        </div>
        <Button onClick={loadWebhooks} disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
          Actualiser
        </Button>
      </div>

      {/* Stats */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total</p>
                <p className="text-2xl font-bold">{stats.total}</p>
              </div>
              <Webhook className="h-8 w-8 text-muted-foreground" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Succès</p>
                <p className="text-2xl font-bold text-green-600">{stats.success}</p>
              </div>
              <CheckCircle className="h-8 w-8 text-green-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Échecs</p>
                <p className="text-2xl font-bold text-destructive">{stats.failed}</p>
              </div>
              <XCircle className="h-8 w-8 text-destructive" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Temps moyen</p>
                <p className="text-2xl font-bold">{stats.avgProcessingTime}ms</p>
              </div>
              <Clock className="h-8 w-8 text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Filtres</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
            <div className="space-y-2">
              <label className="text-sm font-medium">Type d'événement</label>
              <Select value={eventTypeFilter} onValueChange={setEventTypeFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tous</SelectItem>
                  {uniqueEventTypes.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Statut</label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tous</SelectItem>
                  <SelectItem value="success">Succès</SelectItem>
                  <SelectItem value="failed">Échecs</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Recherche Event ID</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="evt_..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Webhooks List */}
      <Card>
        <CardHeader>
          <CardTitle>
            Événements ({filteredWebhooks.length})
          </CardTitle>
          <CardDescription>
            Derniers événements webhooks reçus de Stripe
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
          ) : filteredWebhooks.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Webhook className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>Aucun webhook trouvé</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredWebhooks.map((webhook) => (
                <div
                  key={webhook.id}
                  className="border rounded-lg p-4 space-y-2"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                    <div className="space-y-1 flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {getEventTypeBadge(webhook.eventType)}
                        {webhook.processed ? (
                          <Badge variant="default" className="bg-green-600">
                            <CheckCircle className="w-3 h-3 mr-1" />
                            Succès
                          </Badge>
                        ) : (
                          <Badge variant="destructive">
                            <XCircle className="w-3 h-3 mr-1" />
                            Échec
                          </Badge>
                        )}
                      </div>
                      <div className="font-medium text-sm truncate">{webhook.eventType}</div>
                      <div className="font-mono text-xs text-muted-foreground break-all">
                        {webhook.eventId}
                      </div>
                    </div>
                    <div className="sm:text-right text-xs flex-shrink-0">
                      <div className="text-muted-foreground">
                        {formatDate(webhook.createdAt)}
                      </div>
                      {webhook.processingTimeMs !== null && (
                        <div className="text-muted-foreground">
                          {webhook.processingTimeMs}ms
                        </div>
                      )}
                    </div>
                  </div>

                  {webhook.errorMessage && (
                    <div className="bg-destructive/10 p-2 rounded text-sm text-destructive">
                      <strong>Erreur:</strong> {webhook.errorMessage}
                    </div>
                  )}

                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      Voir le payload
                    </summary>
                    <pre className="mt-2 p-2 bg-muted rounded overflow-x-auto">
                      {JSON.stringify(JSON.parse(webhook.payload), null, 2)}
                    </pre>
                  </details>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
