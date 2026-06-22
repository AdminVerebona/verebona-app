"use client";

import { useState, useCallback, useEffect } from "react";
import Image from "next/image";
import {
  ChevronLeft, ChevronRight,
  Home, Calendar, FileText, Bell, Bike, File,
  LayoutDashboard, Search,
} from "lucide-react";
import { Logo } from "@/components/Logo";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

/* ─── Shared data ─────────────────────────────────────────────── */

const NAV = [
  { Icon: LayoutDashboard, label: "Accueil",        id: "dashboard" },
  { Icon: Home,            label: "Mes biens",       id: "biens" },
  { Icon: Calendar,        label: "Mes événements",  id: "events" },
  { Icon: FileText,        label: "Mes documents",   id: "documents" },
  { Icon: Bell,            label: "Mes rappels",     id: "rappels" },
];

const BIENS = [
  {
    label: "Appartement Lyon", sub: "Immobilier • T3", docs: 7, events: 0,
    img: "https://slelguoygbfzlpylpxfs.supabase.co/storage/v1/object/public/project-uploads/5da8aa09-2540-4b03-96bf-bb17130a3250/generated_images/modern-apartment-interior-t3-in-lyon-fra-5c1f421b-20251205150149.jpg",
  },
  {
    label: "Vélo Cargo", sub: "Véhicule • Électrique", docs: 6, events: 2,
    img: "https://slelguoygbfzlpylpxfs.supabase.co/storage/v1/object/public/project-uploads/5da8aa09-2540-4b03-96bf-bb17130a3250/generated_images/electric-cargo-bike-with-large-front-box-42f241c8-20251205150148.jpg",
  },
  {
    label: "Planche de Surf", sub: "Sport / Loisir", docs: 3, events: 0,
    img: "/images/surf-personal.png",
  },
];

/* ─── Slide content (desktop version — richer layout) ─────────── */

function SlideDashboard() {
  return (
    <div className="flex-1 p-5 md:p-6 overflow-hidden">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        {[
          { label: "Mes biens",   val: "3",  Icon: Home,      color: "text-blue-400",   bg: "bg-blue-500/10" },
          { label: "Événements",  val: "2",  Icon: Calendar,  color: "text-orange-400", bg: "bg-orange-500/10" },
          { label: "Documents",   val: "16", Icon: FileText,   color: "text-green-400",  bg: "bg-green-500/10" },
          { label: "À traiter",   val: "0",  Icon: Bell,      color: "text-red-400",    bg: "bg-red-500/10" },
        ].map(({ label, val, Icon, color, bg }) => (
          <Card key={label} className="p-3 bg-slate-900/40 border-slate-800/60 shadow-none">
            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-lg ${bg} flex items-center justify-center ${color} shrink-0`}><Icon size={16} /></div>
              <div>
                <div className="text-[10px] text-slate-500 uppercase font-semibold">{label}</div>
                <div className="text-lg font-bold text-slate-200">{val}</div>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <div className="mb-5">
        <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Mes rappels</div>
        <Card className="bg-slate-900/40 border-slate-800/60 overflow-hidden shadow-none">
          <div className="flex items-center gap-4 p-3 relative">
            <div className="absolute left-0 top-0 bottom-0 w-1 bg-red-500" />
            <div className="w-10 h-10 rounded-lg bg-slate-800 flex items-center justify-center shrink-0 ml-1"><Bike size={20} className="text-slate-400" /></div>
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-medium text-slate-200 truncate">Révision annuelle</div>
              <div className="text-[10px] text-slate-500">Il y a 2 jours • Vélo Cargo Électrique</div>
            </div>
            <Badge variant="inactive" className="text-[9px] py-0 h-5 mr-1">En retard (2 j)</Badge>
          </div>
        </Card>
      </div>

      <div>
        <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Mes biens</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {BIENS.map(({ label, sub, docs, events: ev, img }) => (
            <Card key={label} className="bg-slate-900/40 border-slate-800/60 overflow-hidden shadow-none cursor-default">
              <div className="relative h-24 bg-slate-950"><Image src={img} alt={label} fill className="object-cover opacity-80" sizes="300px" /></div>
              <div className="p-2.5">
                <div className="flex items-center justify-between mb-1"><span className="text-[9px] font-bold text-slate-500 uppercase tracking-tighter">{sub.split("•")[0].trim()}</span><Badge variant="active" className="text-[8px] py-0 h-4 px-1.5">ACTIF</Badge></div>
                <div className="text-[11px] font-bold text-slate-200 truncate mb-0.5">{label}</div>
                <div className="flex items-center gap-3 text-[9px] text-slate-500">
                  <span className="flex items-center gap-1"><File size={9} />{docs} docs</span>
                  {ev > 0 && <span className="flex items-center gap-1 text-blue-400"><Calendar size={9} />{ev} évén.</span>}
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

function SlideBiens() {
  return (
    <div className="flex-1 p-5 md:p-6 overflow-hidden">
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm font-semibold text-slate-200">Mes biens</div>
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <span className="px-2 py-0.5 rounded-full bg-blue-600/20 border border-blue-500/30 text-blue-300">Tout</span>
          <span className="px-2 py-0.5 rounded-full border border-slate-700 hover:border-slate-500 cursor-pointer">Actif</span>
          <span className="px-2 py-0.5 rounded-full border border-slate-700 hover:border-slate-500 cursor-pointer">Archivé</span>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {BIENS.map(({ label, sub, docs, events: ev, img }) => (
          <Card key={label} className="bg-slate-900/40 border-slate-800/60 overflow-hidden shadow-none hover:border-blue-500/30 transition-colors cursor-default">
            <div className="relative h-36 bg-slate-950"><Image src={img} alt={label} fill className="object-cover opacity-80" sizes="300px" /></div>
            <div className="p-3">
              <div className="flex items-center justify-between mb-1.5"><span className="text-[9px] font-bold text-slate-500 uppercase tracking-tighter">{sub.split("•")[0].trim()}</span><Badge variant="active" className="text-[8px] py-0 h-4 px-1.5 font-bold">ACTIF</Badge></div>
              <div className="text-[12px] font-bold text-slate-200 truncate mb-0.5">{label}</div>
              <div className="text-[10px] text-slate-400 mb-2 truncate">{sub}</div>
              <div className="flex items-center gap-3 text-[9px] text-slate-500">
                <span className="flex items-center gap-1"><File size={10} />{docs} documents</span>
                {ev > 0 && <span className="flex items-center gap-1 text-blue-400"><Calendar size={10} />{ev} événements</span>}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function SlideDocuments() {
  const docs = [
    { name: "Facture achat vélo",     type: "Facture",   bien: "Vélo Cargo",        date: "12/03/2024", color: "text-blue-400",   bg: "bg-blue-500/10" },
    { name: "Attestation assurance",  type: "Assurance", bien: "Appartement Lyon",  date: "01/01/2025", color: "text-green-400",  bg: "bg-green-500/10" },
    { name: "Notice technique",       type: "Notice",    bien: "Vélo Cargo",        date: "12/03/2024", color: "text-purple-400", bg: "bg-purple-500/10" },
    { name: "Contrat de bail",        type: "Contrat",   bien: "Appartement Lyon",  date: "15/09/2023", color: "text-orange-400", bg: "bg-orange-500/10" },
    { name: "Facture planche surf",   type: "Facture",   bien: "Planche de Surf",   date: "05/06/2023", color: "text-blue-400",   bg: "bg-blue-500/10" },
    { name: "Procès-verbal remise clés", type: "Admin",  bien: "Appartement Lyon",  date: "15/09/2023", color: "text-slate-400",  bg: "bg-slate-500/10" },
  ];
  return (
    <div className="flex-1 p-5 md:p-6 overflow-hidden flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <div className="w-full h-8 rounded-full bg-slate-900/60 border border-slate-800/50 pl-9 text-[11px] text-slate-500 flex items-center">Rechercher un document…</div>
        </div>
        <div className="flex gap-1.5 text-[10px]">
          {["Tout", "Facture", "Assurance", "Notice"].map((f, i) => (
            <span key={f} className={`px-2 py-0.5 rounded-full border cursor-pointer ${i === 0 ? "bg-blue-600/20 border-blue-500/30 text-blue-300" : "border-slate-700 text-slate-500 hover:border-slate-500"}`}>{f}</span>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {docs.map(({ name, type, bien, date, color, bg }) => (
          <Card key={name} className="bg-slate-900/40 border-slate-800/60 shadow-none">
            <div className="flex items-center gap-3 p-3">
              <div className={`w-9 h-9 rounded-lg ${bg} flex items-center justify-center ${color} shrink-0`}><FileText size={14} /></div>
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-medium text-slate-200 truncate">{name}</div>
                <div className="text-[9px] text-slate-500 truncate">{type} · {bien} · {date}</div>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function SlideEvents() {
  const events = [
    { name: "Révision annuelle",     bien: "Vélo Cargo",        date: "Il y a 2 jours",  status: "En retard",  sc: "text-red-400 bg-red-500/10 border-red-500/20" },
    { name: "Contrôle technique",    bien: "Voiture familiale", date: "Dans 12 jours",   status: "À venir",    sc: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20" },
    { name: "Renouvellement bail",   bien: "Appartement Lyon",  date: "Dans 3 mois",     status: "À venir",    sc: "text-green-400 bg-green-500/10 border-green-500/20" },
    { name: "Assurance habitation",  bien: "Appartement Lyon",  date: "Dans 4 mois",     status: "À venir",    sc: "text-green-400 bg-green-500/10 border-green-500/20" },
    { name: "Garantie électroménager", bien: "Lave-linge Beko", date: "Dans 8 mois",     status: "À venir",    sc: "text-green-400 bg-green-500/10 border-green-500/20" },
    { name: "Entretien chaudière",   bien: "Appartement Lyon",  date: "Dans 11 mois",    status: "À venir",    sc: "text-green-400 bg-green-500/10 border-green-500/20" },
  ];
  return (
    <div className="flex-1 p-5 md:p-6 overflow-hidden flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[10px]">
        {["Tout", "À venir", "En retard", "Passé"].map((f, i) => (
          <span key={f} className={`px-2.5 py-0.5 rounded-full border cursor-pointer ${i === 0 ? "bg-blue-600/20 border-blue-500/30 text-blue-300" : "border-slate-700 text-slate-500 hover:border-slate-500"}`}>{f}</span>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {events.map(({ name, bien, date, status, sc }) => {
          const [color, ...rest] = sc.split(" ");
          const bgBorder = rest.join(" ");
          return (
            <Card key={name} className="bg-slate-900/40 border-slate-800/60 shadow-none">
              <div className="flex items-center gap-3 p-3">
                <div className={`w-9 h-9 rounded-lg ${bgBorder} flex items-center justify-center ${color} shrink-0`}><Calendar size={14} /></div>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-medium text-slate-200 truncate">{name}</div>
                  <div className="text-[9px] text-slate-500 truncate">{bien} · {date}</div>
                </div>
                <span className={`text-[8px] border rounded px-1.5 py-0.5 shrink-0 ${sc}`}>{status}</span>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Slides config ────────────────────────────────────────────── */

const SLIDES: { id: string; label: string; navId: string; Content: () => React.ReactElement }[] = [
  { id: "dashboard",  label: "Tableau de bord",   navId: "dashboard",  Content: SlideDashboard },
  { id: "biens",      label: "Mes biens",          navId: "biens",      Content: SlideBiens },
  { id: "events",     label: "Mes événements",     navId: "events",     Content: SlideEvents },
  { id: "documents",  label: "Mes documents",      navId: "documents",  Content: SlideDocuments },
];

/* ─── Shared inner shell (browser chrome + sidebar + content) ─── */

function MockupShell({
  current,
  setCurrent,
  isMobile,
}: {
  current: number;
  setCurrent: (i: number) => void;
  isMobile: boolean;
}) {
  const { Content, navId } = SLIDES[current];
  const logoSize = isMobile ? 18 : 22;

  return (
    <div
      className="rounded-2xl border border-[rgba(55,65,81,0.7)] bg-[rgba(15,23,42,0.95)] overflow-hidden"
      style={{ boxShadow: "0 32px 80px rgba(0,0,0,0.6)" }}
    >
      {/* Browser bar */}
      <div className="flex items-center gap-2 px-3 md:px-4 py-2.5 border-b border-[rgba(31,41,55,0.9)] bg-[rgba(9,14,28,0.98)]">
        <div className="flex gap-1.5">
          <span className="w-2.5 h-2.5 md:w-3 md:h-3 rounded-full bg-[#ef4444]/70" />
          <span className="w-2.5 h-2.5 md:w-3 md:h-3 rounded-full bg-[#f59e0b]/70" />
          <span className="w-2.5 h-2.5 md:w-3 md:h-3 rounded-full bg-[#22c55e]/70" />
        </div>
        <div className="flex-1 mx-3">
          <div className="h-4 md:h-5 rounded-md bg-[rgba(31,41,55,0.8)] flex items-center px-3 max-w-[180px] md:max-w-xs mx-auto">
            <span className="text-[9px] md:text-[10px] text-slate-500 tracking-wide">app.verebona.com</span>
          </div>
        </div>
        <span className="text-[9px] text-slate-500 shrink-0 hidden sm:block">{SLIDES[current].label}</span>
      </div>

      {/* App shell */}
      <div className="flex bg-[#020617]" style={{ height: isMobile ? 260 : 420 }}>
        {/* Sidebar — icon-only on mobile, full on desktop */}
        <div
          className={`border-r border-slate-800/60 bg-[#0f172a]/20 flex flex-col pt-3 gap-1 shrink-0 ${
            isMobile ? "w-12 items-center" : "w-52 px-3"
          }`}
        >
          {/* Logo */}
          <div className={`flex items-center gap-2 mb-5 ${isMobile ? "justify-center px-0" : "px-2"}`}>
            <Logo size={logoSize} withText={false} />
            {!isMobile && <span className="text-xs font-semibold text-slate-200">Verebona</span>}
          </div>

          {/* Nav items */}
          {NAV.map(({ Icon, label, id }) => {
            const idx = SLIDES.findIndex((s) => s.navId === id);
            const active = navId === id;
            return (
              <button
                key={id}
                onClick={() => idx !== -1 && setCurrent(idx)}
                className={`flex items-center rounded-lg transition-colors cursor-pointer ${
                  isMobile
                    ? `w-8 h-8 justify-center ${active ? "bg-blue-600/10 text-blue-400" : "text-slate-500 hover:text-slate-300"}`
                    : `gap-3 px-3 py-2 w-full text-[11px] font-medium ${active ? "bg-blue-600/10 text-blue-400" : "text-slate-400 hover:bg-slate-800/30 hover:text-slate-300"}`
                }`}
              >
                <Icon size={isMobile ? 14 : 14} />
                {!isMobile && <span>{label}</span>}
              </button>
            );
          })}
        </div>

        {/* Main area */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Top bar */}
          <div className="h-10 md:h-12 border-b border-slate-800/60 flex items-center justify-between px-4 bg-[#020617] shrink-0">
            {!isMobile && (
              <div className="relative w-56">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <div className="w-full h-7 rounded-full bg-slate-900/50 border border-slate-800/50 px-9 text-[11px] text-slate-500 flex items-center">Rechercher…</div>
              </div>
            )}
            <div className="flex items-center gap-3 ml-auto">
              <div className="w-7 h-7 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-[9px] font-bold text-slate-300">LM</div>
            </div>
          </div>

          {/* Slide content */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {isMobile ? <MobileSlideContent current={current} /> : <Content />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Mobile slide content (compact) ──────────────────────────── */

function MobileSlideContent({ current }: { current: number }) {
  if (current === 0) return (
    <div className="flex-1 p-3 flex flex-col gap-2.5 overflow-hidden">
      <div className="grid grid-cols-2 gap-2">
        {[
          { label: "Mes biens", val: "3", Icon: Home, color: "text-blue-400", bg: "bg-blue-500/10" },
          { label: "Événements", val: "2", Icon: Calendar, color: "text-orange-400", bg: "bg-orange-500/10" },
          { label: "Documents", val: "16", Icon: FileText, color: "text-green-400", bg: "bg-green-500/10" },
          { label: "À traiter", val: "0", Icon: Bell, color: "text-red-400", bg: "bg-red-500/10" },
        ].map(({ label, val, Icon, color, bg }) => (
          <div key={label} className="bg-slate-900/50 border border-slate-800/60 rounded-lg p-2 flex items-center gap-2">
            <div className={`w-7 h-7 rounded-md ${bg} flex items-center justify-center ${color} shrink-0`}><Icon size={13} /></div>
            <div><div className="text-[9px] text-slate-500 uppercase font-semibold leading-none mb-0.5">{label}</div><div className="text-sm font-bold text-slate-200">{val}</div></div>
          </div>
        ))}
      </div>
      <div>
        <div className="text-[9px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Rappel en retard</div>
        <div className="bg-slate-900/50 border border-slate-800/60 rounded-lg p-2 flex items-center gap-2 relative overflow-hidden">
          <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-red-500" />
          <div className="w-7 h-7 rounded-md bg-slate-800 flex items-center justify-center shrink-0 ml-1"><Bike size={14} className="text-slate-400" /></div>
          <div className="flex-1 min-w-0"><div className="text-[10px] font-medium text-slate-200 truncate">Révision annuelle</div><div className="text-[9px] text-slate-500">Vélo Cargo Électrique</div></div>
          <span className="text-[8px] bg-red-500/20 text-red-400 border border-red-500/30 rounded px-1.5 py-0.5 shrink-0">En retard</span>
        </div>
      </div>
      <div>
        <div className="text-[9px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Mes biens</div>
        <div className="flex flex-col gap-1.5">
          {BIENS.slice(0, 2).map(({ label, sub, img }) => (
            <div key={label} className="bg-slate-900/50 border border-slate-800/60 rounded-lg flex items-center gap-2 overflow-hidden">
              <div className="relative w-10 h-10 shrink-0 bg-slate-950"><Image src={img} alt={label} fill className="object-cover opacity-80" sizes="40px" /></div>
              <div className="flex-1 min-w-0 py-1"><div className="text-[10px] font-semibold text-slate-200 truncate">{label}</div><div className="text-[8px] text-slate-500 truncate">{sub}</div></div>
              <span className="text-[7px] text-emerald-400 border border-emerald-500/20 rounded px-1.5 mr-2">ACTIF</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  if (current === 1) return (
    <div className="flex-1 p-3 flex flex-col gap-2 overflow-hidden">
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Mes biens</div>
        <div className="w-5 h-5 rounded-md bg-blue-600 flex items-center justify-center"><span className="text-white text-[10px] font-bold">+</span></div>
      </div>
      <div className="flex flex-col gap-2">
        {BIENS.map(({ label, sub, docs, img }) => (
          <div key={label} className="bg-slate-900/50 border border-slate-800/60 rounded-lg flex items-center gap-2 overflow-hidden">
            <div className="relative w-12 h-12 shrink-0 bg-slate-950"><Image src={img} alt={label} fill className="object-cover opacity-80" sizes="48px" /></div>
            <div className="flex-1 min-w-0 py-1"><div className="text-[10px] font-semibold text-slate-200 truncate">{label}</div><div className="text-[9px] text-slate-500 truncate">{sub}</div><div className="flex items-center gap-1 text-[8px] text-slate-500 mt-0.5"><File size={8} />{docs} documents</div></div>
            <span className="text-[7px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded px-1.5 py-0.5 mr-2 shrink-0">ACTIF</span>
          </div>
        ))}
      </div>
    </div>
  );

  if (current === 2) return (
    <div className="flex-1 p-3 flex flex-col gap-2 overflow-hidden">
      <div className="flex gap-1.5">
        {["Tout", "À venir", "En retard"].map((f, i) => (
          <span key={f} className={`text-[9px] px-2 py-0.5 rounded-full border ${i === 0 ? "bg-blue-600/20 border-blue-500/40 text-blue-300" : "border-slate-700 text-slate-500"}`}>{f}</span>
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        {[
          { name: "Révision annuelle",   bien: "Vélo Cargo",        date: "Il y a 2 jours",  status: "En retard", sc: "text-red-400 bg-red-500/10 border-red-500/20" },
          { name: "Contrôle technique",  bien: "Voiture familiale", date: "Dans 12 jours",   status: "À venir",   sc: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20" },
          { name: "Renouvellement bail", bien: "Appartement Lyon",  date: "Dans 3 mois",     status: "À venir",   sc: "text-green-400 bg-green-500/10 border-green-500/20" },
          { name: "Assurance habitation",bien: "Appartement Lyon",  date: "Dans 4 mois",     status: "À venir",   sc: "text-green-400 bg-green-500/10 border-green-500/20" },
        ].map(({ name, bien, date, status, sc }) => {
          const [color, ...rest] = sc.split(" ");
          return (
            <div key={name} className="bg-slate-900/50 border border-slate-800/60 rounded-lg p-2 flex items-center gap-2">
              <div className={`w-7 h-7 rounded-md ${rest.join(" ")} flex items-center justify-center ${color} shrink-0`}><Calendar size={12} /></div>
              <div className="flex-1 min-w-0"><div className="text-[10px] font-medium text-slate-200 truncate">{name}</div><div className="text-[8px] text-slate-500 truncate">{bien} · {date}</div></div>
              <span className={`text-[7px] border rounded px-1.5 py-0.5 shrink-0 ${sc}`}>{status}</span>
            </div>
          );
        })}
      </div>
    </div>
  );

  // documents
  return (
    <div className="flex-1 p-3 flex flex-col gap-2 overflow-hidden">
      <div className="relative">
        <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
        <div className="w-full h-7 rounded-full bg-slate-900/60 border border-slate-800/50 pl-7 text-[10px] text-slate-500 flex items-center">Rechercher un document…</div>
      </div>
      <div className="flex flex-col gap-1.5">
        {[
          { name: "Facture achat vélo",     type: "Facture",   color: "text-blue-400",   bg: "bg-blue-500/10" },
          { name: "Attestation assurance",  type: "Assurance", color: "text-green-400",  bg: "bg-green-500/10" },
          { name: "Notice technique",       type: "Notice",    color: "text-purple-400", bg: "bg-purple-500/10" },
          { name: "Contrat de bail",        type: "Contrat",   color: "text-orange-400", bg: "bg-orange-500/10" },
        ].map(({ name, type, color, bg }) => (
          <div key={name} className="bg-slate-900/50 border border-slate-800/60 rounded-lg p-2 flex items-center gap-2">
            <div className={`w-7 h-7 rounded-md ${bg} flex items-center justify-center ${color} shrink-0`}><FileText size={12} /></div>
            <div className="flex-1 min-w-0"><div className="text-[10px] font-medium text-slate-200 truncate">{name}</div><div className="text-[8px] text-slate-500">{type}</div></div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Navigation bar (shared) ─────────────────────────────────── */

function NavBar({
  current,
  setCurrent,
  prev,
  next,
}: {
  current: number;
  setCurrent: (i: number) => void;
  prev: () => void;
  next: () => void;
}) {
  return (
    <div className="flex items-center justify-center gap-3 mt-3">
      <button onClick={prev} className="w-7 h-7 rounded-full border border-slate-700 bg-slate-900/60 flex items-center justify-center text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-colors" aria-label="Précédent">
        <ChevronLeft size={14} />
      </button>
      <div className="flex gap-1.5">
        {SLIDES.map((_, i) => (
          <button key={i} onClick={() => setCurrent(i)} className={`h-1.5 rounded-full transition-all duration-200 ${i === current ? "bg-blue-500 w-6" : "bg-slate-700 w-1.5 hover:bg-slate-500"}`} aria-label={`Slide ${i + 1}`} />
        ))}
      </div>
      <button onClick={next} className="w-7 h-7 rounded-full border border-slate-700 bg-slate-900/60 flex items-center justify-center text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-colors" aria-label="Suivant">
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

/* ─── Public exports ───────────────────────────────────────────── */

export function MobileMockupCarousel() {
  const [current, setCurrent] = useState(0);
  const prev = useCallback(() => setCurrent((c) => (c - 1 + SLIDES.length) % SLIDES.length), []);
  const next = useCallback(() => setCurrent((c) => (c + 1) % SLIDES.length), []);

  useEffect(() => {
    const id = setInterval(() => setCurrent((c) => (c + 1) % SLIDES.length), 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="md:hidden w-full">
      <MockupShell current={current} setCurrent={setCurrent} isMobile={true} />
      <NavBar current={current} setCurrent={setCurrent} prev={prev} next={next} />
    </div>
  );
}

export function DesktopMockupCarousel() {
  const [current, setCurrent] = useState(0);
  const prev = useCallback(() => setCurrent((c) => (c - 1 + SLIDES.length) % SLIDES.length), []);
  const next = useCallback(() => setCurrent((c) => (c + 1) % SLIDES.length), []);

  useEffect(() => {
    const id = setInterval(() => setCurrent((c) => (c + 1) % SLIDES.length), 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="hidden md:block w-full">
      <MockupShell current={current} setCurrent={setCurrent} isMobile={false} />
      <NavBar current={current} setCurrent={setCurrent} prev={prev} next={next} />
    </div>
  );
}
