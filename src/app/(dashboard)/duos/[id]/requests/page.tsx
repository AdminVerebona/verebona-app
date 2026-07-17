"use client";

import { useEffect, useState } from 'react';
import { useSession } from '@/hooks/useSession';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { 
  CheckCircle2, 
  XCircle, 
  ArrowRight, 
  Package, 
  Loader2, 
  Clock,
  Trash2,
  ChevronRight,
  ShieldCheck
} from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';

interface DuoRequest {
  request_id: number;
  type: 'MOVE' | 'DELETE';
  asset_id: number;
  asset_label_snapshot: string;
  initiator_display: string;
  target_display?: string;
  created_at: string;
  actions_allowed: ('ACCEPT' | 'REFUSE')[];
}

export default function DuoInboxPage({ params }: { params: { id: string } }) {
  const { user } = useSession({ required: true });
  const [requests, setRequests] = useState<DuoRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState<number | null>(null);

  const fetchRequests = async () => {
    try {
      const data = await apiClient.get<DuoRequest[]>(`/api/duos/${params.id}/requests/inbox`);
      setRequests(data);
    } catch (error) {
      console.error('Failed to fetch duo requests:', error);
      toast.error('Erreur lors du chargement des demandes');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (user) {
      fetchRequests();
    }
  }, [user, params.id]);

  const handleRespond = async (requestId: number, action: 'ACCEPT' | 'REFUSE', type: 'MOVE' | 'DELETE') => {
    setIsProcessing(requestId);
    try {
      const endpoint = type === 'MOVE' ? `/api/move-requests/${requestId}/respond` : `/api/delete-requests/${requestId}/respond`;
      
      const body: any = { action };
      if (type === 'MOVE' && action === 'ACCEPT') {
        // Par défaut on propose MOVE_ONLY pour la simplicité dans l'inbox
        // Une modal plus complexe pourrait proposer MOVE_AND_COPY
        body.resolution_mode = 'MOVE_ONLY';
      }

      await apiClient.post(endpoint, body);
      toast.success(action === 'ACCEPT' ? 'Demande acceptée' : 'Demande refusée');
      fetchRequests();
    } catch (error: any) {
      console.error('Response error:', error);
      toast.error(error.message || 'Erreur lors de la réponse');
    } finally {
      setIsProcessing(null);
    }
  };

  if (isLoading) {
    return (
      <>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-[color:var(--accent)]" />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Inbox Duo</h1>
            <p className="text-[color:var(--text-muted)] mt-1">
              Validez les actions importantes effectuées par l'autre membre.
            </p>
          </div>
          <Badge variant="outline" className="px-3 py-1 bg-[color:var(--bg-card)] shadow-relief-sm">
            {requests.length} demande{requests.length > 1 ? 's' : ''} en attente
          </Badge>
        </div>

        {requests.length === 0 ? (
          <Card className="border-dashed border-2 border-[color:var(--border-subtle)] bg-[color:var(--bg-page)]/50">
            <CardContent className="py-16 text-center">
              <div className="w-16 h-16 rounded-full bg-[color:var(--bg-card)] flex items-center justify-center mx-auto mb-4 shadow-relief-sm">
                <CheckCircle2 className="w-8 h-8 text-[color:var(--text-muted)]" />
              </div>
              <h3 className="text-lg font-medium text-[color:var(--text-primary)]">Tout est à jour !</h3>
              <p className="text-[color:var(--text-muted)] mt-1">
                Aucune demande en attente de validation pour le moment.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {requests.map((req) => (
              <Card key={req.request_id} className="border-[color:var(--border-subtle)] shadow-relief-md hover:shadow-relief-lg transition-all overflow-hidden group">
                <CardContent className="p-0">
                  <div className="flex flex-col md:flex-row">
                    {/* Header coloré selon type */}
                    <div className={`w-full md:w-2 ${req.type === 'MOVE' ? 'bg-blue-500' : 'bg-red-500'}`} />
                    
                    <div className="flex-1 p-5 space-y-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-center gap-3">
                          <div className={`w-10 h-10 rounded-xl flex items-center justify-center shadow-relief-sm ${
                            req.type === 'MOVE' ? 'bg-blue-500/10' : 'bg-red-500/10'
                          }`}>
                            {req.type === 'MOVE' ? (
                              <ArrowRight className={`w-5 h-5 ${req.type === 'MOVE' ? 'text-blue-500' : 'text-red-500'}`} />
                            ) : (
                              <Trash2 className="w-5 h-5 text-red-500" />
                            )}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <h3 className="font-semibold text-[color:var(--text-primary)]">
                                {req.type === 'MOVE' ? 'Demande de déplacement' : 'Demande de suppression'}
                              </h3>
                              <Badge variant="secondary" className="text-[10px] h-4">PENDING</Badge>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-[color:var(--text-muted)] mt-1">
                              <Clock className="w-3 h-3" />
                              <span>Il y a {formatDistanceToNow(new Date(req.created_at), { locale: fr })}</span>
                              <span>•</span>
                              <span>Par {req.initiator_display}</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="bg-[color:var(--bg-page)] rounded-xl p-4 border border-[color:var(--border-subtle)] shadow-inner">
                        <div className="flex items-center gap-3">
                          <Package className="w-4 h-4 text-[color:var(--text-muted)]" />
                          <span className="text-sm font-medium">{req.asset_label_snapshot}</span>
                          {req.type === 'MOVE' && (
                            <>
                              <ChevronRight className="w-4 h-4 text-[color:var(--text-muted)]" />
                              <div className="flex items-center gap-1 text-sm text-[color:var(--text-muted)]">
                                <ArrowRight className="w-3 h-3" />
                                <span>{req.target_display}</span>
                              </div>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center justify-end gap-3 pt-2">
                        {req.actions_allowed.includes('REFUSE') && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={isProcessing === req.request_id}
                            onClick={() => handleRespond(req.request_id, 'REFUSE', req.type)}
                            className="rounded-full px-4 gap-2 border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-900/30 dark:hover:bg-red-900/20"
                          >
                            <XCircle className="w-4 h-4" />
                            Refuser
                          </Button>
                        )}
                        {req.actions_allowed.includes('ACCEPT') && (
                          <Button
                            size="sm"
                            disabled={isProcessing === req.request_id}
                            onClick={() => handleRespond(req.request_id, 'ACCEPT', req.type)}
                            className={`rounded-full px-6 gap-2 shadow-lg transition-all hover:scale-105 ${
                              req.type === 'MOVE' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-red-600 hover:bg-red-700'
                            }`}
                          >
                            {isProcessing === req.request_id ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <>
                                <CheckCircle2 className="w-4 h-4" />
                                Valider
                              </>
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Aide / Infos Rôles */}
        <div className="bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] rounded-2xl p-4 flex gap-3 shadow-relief-sm">
          <ShieldCheck className="w-5 h-5 text-[color:var(--accent)] flex-shrink-0" />
          <p className="text-xs text-[color:var(--text-muted)] leading-relaxed">
            Pour garantir l'intégrité de l'espace partagé, toute action sortant un bien de l'espace Duo (déplacement vers un compte personnel ou suppression) doit être validée par le second membre.
          </p>
        </div>
      </div>
    </>
  );
}
