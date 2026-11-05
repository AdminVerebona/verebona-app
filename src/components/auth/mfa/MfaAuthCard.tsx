'use client';

/** Carte commune des écrans de double authentification (charte Sérénité, ordinateur et mobile). */
import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LogoWithBaseline } from '@/components/Logo';
import { AuthFooter } from '@/components/LandingFooter';
import { FollowTheme } from '@/components/FollowTheme';

export function MfaAuthCard({ title, description, children, wide = false }: { title: string; description?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="public-page min-h-screen flex flex-col bg-[color:var(--bg-page)]">
      <FollowTheme />
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'} bg-[color:var(--bg-card)] border-[color:var(--border-subtle)] shadow-xl`}>
          <CardHeader className="space-y-4">
            <div className="flex justify-center"><LogoWithBaseline size={50} /></div>
            <CardTitle role="heading" aria-level={1} className="text-center text-[24px] font-extrabold tracking-[-.02em] text-[color:var(--text-primary)]">{title}</CardTitle>
            {description && <CardDescription className="text-center text-[color:var(--text-muted)]">{description}</CardDescription>}
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
      </div>
      <AuthFooter />
    </div>
  );
}

export function MfaAlert({ children, tone = 'danger' }: { children: ReactNode; tone?: 'danger' | 'info' }) {
  return tone === 'danger'
    ? <div role="alert" className="text-sm bg-[color:var(--danger-soft)] border border-[color:var(--danger-edge)] text-[color:var(--danger)] p-3 rounded-md">{children}</div>
    : <div role="status" className="text-sm bg-[color:var(--bg-info)] border border-[color:var(--border-subtle)] text-[color:var(--text-primary)] p-3 rounded-md">{children}</div>;
}
