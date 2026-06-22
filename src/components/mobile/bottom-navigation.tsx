"use client";

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Package, FileText, CalendarDays, Plus, AlertCircle } from 'lucide-react';
import { MobileActionsSheet } from './mobile-actions-sheet';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';

const LEFT_ITEMS = [
  { id: 'biens', name: 'Mes biens', href: '/assets', icon: Package },
  { id: 'agenda', name: 'Mon agenda', href: '/agenda', icon: CalendarDays },
];

const RIGHT_ITEMS = [
  { id: 'documents', name: 'Mes docs', href: '/documents', icon: FileText },
  { id: 'a-traiter', name: 'À traiter', href: '/accueil/a-traiter', icon: AlertCircle },
];

export function BottomNavigation() {
  const pathname = usePathname();
  const [showActionsSheet, setShowActionsSheet] = useState(false);
  const [aTraiterCount, setATraiterCount] = useState<number>(0);

  // Initial fetch
  useEffect(() => {
    apiClient.get<{ total: number } | { items: any[] }>('/api/to-process', { useCache: true })
      .then(res => {
        const count = 'total' in res ? res.total : ('items' in res ? (res.items?.length ?? 0) : 0);
        setATraiterCount(count);
      })
      .catch(() => {
        // Fallback
        apiClient.get<{ documents: any[]; agendaItems: any[]; equipements: any[] }>('/api/dashboard/a-traiter')
          .then(res => {
            const count = (res.documents?.length ?? 0) + (res.agendaItems?.length ?? 0) + (res.equipements?.length ?? 0);
            setATraiterCount(count);
          })
          .catch(() => {});
      });
  }, []);

  // Listen for updates dispatched by DashboardLayout / a-traiter page
  useEffect(() => {
    const handler = (e: Event) => setATraiterCount((e as CustomEvent<number>).detail ?? 0);
    window.addEventListener('update-a-traiter-count', handler);
    return () => window.removeEventListener('update-a-traiter-count', handler);
  }, []);

  return (
    <>
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 px-4 pb-2 pt-2 bg-gradient-to-t from-[color:var(--bg-page)] via-[color:var(--bg-page)] to-transparent">
        <nav className="flex items-center justify-between bg-[color:var(--bg-card)]/80 backdrop-blur-xl border border-[color:var(--border-subtle)] rounded-2xl px-2 py-2 shadow-relief-lg">
          {/* Left items */}
          <div className="flex flex-1 justify-around items-center">
            {LEFT_ITEMS.map((item) => {
              const isActive = pathname === item.href || (item.id === 'biens' && pathname.startsWith('/assets')) || (item.id === 'agenda' && pathname.startsWith('/agenda'));
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  className={`flex flex-col items-center gap-1 p-2 rounded-xl transition-all ${
                    isActive ? 'text-[color:var(--accent)]' : 'text-[color:var(--text-muted)]'
                  }`}
                >
                  <item.icon className="w-5 h-5" />
                  <span className="text-[10px] font-medium">{item.name}</span>
                </Link>
              );
            })}
          </div>

          {/* Center Plus Button */}
          <div className="flex-shrink-0 flex flex-col items-center gap-1 -mt-10 relative">
            <Button
              size="icon"
              onClick={() => setShowActionsSheet(true)}
              className="h-16 w-16 rounded-full shadow-relief-2xl hover:shadow-relief-glow bg-gradient-to-br from-[#3b82f6] to-[#1d4ed8] hover:scale-110 transition-all border-4 border-[color:var(--bg-page)]"
            >
              <Plus className="w-8 h-8 text-white" />
            </Button>
            <span className="text-[10px] font-medium text-[color:var(--accent)]">Ajouter</span>
          </div>

          {/* Right items */}
          <div className="flex flex-1 justify-around items-center">
            {RIGHT_ITEMS.map((item) => {
              const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
              const badge = item.id === 'a-traiter' && aTraiterCount > 0 ? aTraiterCount : null;
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  className={`flex flex-col items-center gap-1 p-2 rounded-xl transition-all ${
                    isActive ? 'text-[color:var(--accent)]' : 'text-[color:var(--text-muted)]'
                  }`}
                >
                  <div className="relative">
                    <item.icon className="w-5 h-5" />
                    {badge !== null && (
                      <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 flex items-center justify-center bg-red-500 text-white text-[9px] font-bold rounded-full px-1">
                        {badge > 99 ? '99+' : badge}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] font-medium">{item.name}</span>
                </Link>
              );
            })}
          </div>
        </nav>
      </div>

      <MobileActionsSheet
        open={showActionsSheet}
        onOpenChange={setShowActionsSheet}
      />

      {/* Spacer to prevent content from being hidden behind the nav */}
      <div className="md:hidden h-24" />
    </>
  );
}
