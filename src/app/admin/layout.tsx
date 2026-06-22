"use client"

import { useRouter } from 'next/navigation';
import { AdminSidebar, AdminMobileHeader } from '@/components/AdminSidebar';
import { useSession } from '@/hooks/useSession';

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { user, isLoading } = useSession({ required: true });

  if (isLoading) {
    return (
      <div className="flex h-screen overflow-hidden bg-background">
        <aside className="hidden md:block w-64 flex-shrink-0 border-r bg-muted/20 animate-pulse">
          <div className="p-6 space-y-4">
            <div className="h-8 w-32 bg-muted rounded" />
            <div className="space-y-2 pt-4">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="h-10 w-full bg-muted rounded" />
              ))}
            </div>
          </div>
        </aside>
        <main className="flex-1 overflow-y-auto bg-background">
          <div className="container mx-auto p-4 md:p-6 max-w-7xl space-y-6">
            <div className="space-y-2">
              <div className="h-10 w-64 bg-muted animate-pulse rounded" />
              <div className="h-4 w-96 bg-muted animate-pulse rounded" />
            </div>
            <div className="h-32 w-full bg-muted animate-pulse rounded" />
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-20 w-full bg-muted animate-pulse rounded" />
              ))}
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (user && user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
    router.push('/accueil');
    return null;
  }

  if (!user) return null;

  return (
    <div className="flex h-screen overflow-hidden bg-background flex-col md:flex-row">
      {/* Desktop sidebar */}
      <aside className="hidden md:block w-64 flex-shrink-0 h-full">
        <AdminSidebar />
      </aside>

      {/* Mobile header + drawer */}
      <AdminMobileHeader />

      {/* Main content */}
      <main className="flex-1 overflow-y-auto min-h-0">
        <div className="container mx-auto p-4 md:p-6 max-w-7xl">
          {children}
        </div>
      </main>
    </div>
  );
}
