'use client';

/**
 * Hôte des intégrations natives — lot 95 (Gate 0, CDC 12).
 *
 * Monté une fois à la racine (ClientShell). Dans un navigateur, il ne rend
 * RIEN et ne charge rien : le module d'exécution (`NativeBridgeRuntime`) n'est
 * importé que dans l'application iOS / Android. Le Web est inchangé.
 */
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { isNativeApp } from '@/lib/native/bridge';

const NativeBridgeRuntime = dynamic(() => import('./NativeBridgeRuntime'), { ssr: false });

export function NativeBridgeHost() {
  // Décidé après hydratation : premier rendu identique serveur / client.
  const [native, setNative] = useState(false);
  useEffect(() => { setNative(isNativeApp()); }, []);
  return native ? <NativeBridgeRuntime /> : null;
}
