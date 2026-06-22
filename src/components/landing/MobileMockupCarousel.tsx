"use client";

import { useState } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight, Home, Calendar, FileText, Bell, Bike, File, LayoutDashboard, Search } from "lucide-react";
import { Logo } from "@/components/Logo";

const slides = [
  {
    id: "dashboard",
    label: "Tableau de bord",
    content: (
      <div className="flex bg-[#020617] h-[260px]">
        {/* Sidebar mini */}
        <div className="w-12 border-r border-slate-800/60 bg-[#0f172a]/30 flex flex-col items-center pt-3 gap-3 shrink-0">
          <div className="w-6 h-6 flex items-center justify-center"><Logo size={18} withText={false} /></div>
          <div className="w-8 h-8 rounded-lg bg-blue-600/10 flex items-center justify-center text-blue-400 mt-2"><LayoutDashboard size={14} /></div>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500"><Home size={14} /></div>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500"><Calendar size={14} /></div>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500"><FileText size={14} /></div>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500"><Bell size={14} /></div>
        </div>
        {/* Main */}
        <div className="flex-1 flex flex-col min-w-0 p-3 gap-3 overflow-hidden">
          <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Accueil</div>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: "Mes biens", val: "3", color: "text-blue-400", bg: "bg-blue-500/10", Icon: Home },
              { label: "Événements", val: "2", color: "text-orange-400", bg: "bg-orange-500/10", Icon: Calendar },
              { label: "Documents", val: "16", color: "text-green-400", bg: "bg-green-500/10", Icon: FileText },
              { label: "À traiter", val: "0", color: "text-red-400", bg: "bg-red-500/10", Icon: Bell },
            ].map(({ label, val, color, bg, Icon }) => (
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
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-medium text-slate-200 truncate">Révision annuelle</div>
                <div className="text-[9px] text-slate-500">Vélo Cargo Électrique</div>
              </div>
              <span className="text-[8px] bg-red-500/20 text-red-400 border border-red-500/30 rounded px-1.5 py-0.5 shrink-0">En retard</span>
            </div>
          </div>
        </div>
      </div>
    ),
  },
  {
    id: "biens",
    label: "Mes biens",
    content: (
      <div className="flex bg-[#020617] h-[260px]">
        <div className="w-12 border-r border-slate-800/60 bg-[#0f172a]/30 flex flex-col items-center pt-3 gap-3 shrink-0">
          <div className="w-6 h-6 flex items-center justify-center"><Logo size={18} withText={false} /></div>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 mt-2"><LayoutDashboard size={14} /></div>
          <div className="w-8 h-8 rounded-lg bg-blue-600/10 flex items-center justify-center text-blue-400"><Home size={14} /></div>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500"><Calendar size={14} /></div>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500"><FileText size={14} /></div>
        </div>
        <div className="flex-1 flex flex-col min-w-0 p-3 gap-2 overflow-hidden">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Mes biens</div>
            <div className="w-5 h-5 rounded-md bg-blue-600 flex items-center justify-center"><span className="text-white text-[10px] font-bold">+</span></div>
          </div>
          <div className="grid grid-cols-1 gap-2 overflow-hidden">
            {[
              { label: "Appartement Lyon", sub: "Immobilier • T3", docs: 7, img: "https://slelguoygbfzlpylpxfs.supabase.co/storage/v1/object/public/project-uploads/5da8aa09-2540-4b03-96bf-bb17130a3250/generated_images/modern-apartment-interior-t3-in-lyon-fra-5c1f421b-20251205150149.jpg" },
              { label: "Vélo Cargo", sub: "Véhicule • Électrique", docs: 6, img: "https://slelguoygbfzlpylpxfs.supabase.co/storage/v1/object/public/project-uploads/5da8aa09-2540-4b03-96bf-bb17130a3250/generated_images/electric-cargo-bike-with-large-front-box-42f241c8-20251205150148.jpg" },
              { label: "Planche de Surf", sub: "Sport / Loisir", docs: 3, img: "/images/surf-personal.png" },
            ].map(({ label, sub, docs, img }) => (
              <div key={label} className="bg-slate-900/50 border border-slate-800/60 rounded-lg flex items-center gap-2 overflow-hidden">
                <div className="relative w-12 h-12 shrink-0 bg-slate-950">
                  <Image src={img} alt={label} fill className="object-cover opacity-80" sizes="48px" />
                </div>
                <div className="flex-1 min-w-0 py-1">
                  <div className="text-[10px] font-semibold text-slate-200 truncate">{label}</div>
                  <div className="text-[9px] text-slate-500 truncate">{sub}</div>
                  <div className="flex items-center gap-1 text-[8px] text-slate-500 mt-0.5"><File size={8} />{docs} documents</div>
                </div>
                <span className="text-[7px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded px-1.5 py-0.5 mr-2 shrink-0">ACTIF</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
  },
  {
    id: "documents",
    label: "Mes documents",
    content: (
      <div className="flex bg-[#020617] h-[260px]">
        <div className="w-12 border-r border-slate-800/60 bg-[#0f172a]/30 flex flex-col items-center pt-3 gap-3 shrink-0">
          <div className="w-6 h-6 flex items-center justify-center"><Logo size={18} withText={false} /></div>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 mt-2"><LayoutDashboard size={14} /></div>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500"><Home size={14} /></div>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500"><Calendar size={14} /></div>
          <div className="w-8 h-8 rounded-lg bg-blue-600/10 flex items-center justify-center text-blue-400"><FileText size={14} /></div>
        </div>
        <div className="flex-1 flex flex-col min-w-0 p-3 gap-2 overflow-hidden">
          <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Mes documents</div>
          <div className="relative">
            <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <div className="w-full h-7 rounded-full bg-slate-900/60 border border-slate-800/50 pl-7 text-[10px] text-slate-500 flex items-center">Rechercher un document…</div>
          </div>
          <div className="flex flex-col gap-1.5 overflow-hidden">
            {[
              { name: "Facture achat vélo", type: "Facture", bien: "Vélo Cargo", date: "12/03/2024", color: "text-blue-400", bg: "bg-blue-500/10" },
              { name: "Attestation assurance", type: "Assurance", bien: "Appartement Lyon", date: "01/01/2025", color: "text-green-400", bg: "bg-green-500/10" },
              { name: "Notice technique", type: "Notice", bien: "Vélo Cargo", date: "12/03/2024", color: "text-purple-400", bg: "bg-purple-500/10" },
              { name: "Contrat de bail", type: "Contrat", bien: "Appartement Lyon", date: "15/09/2023", color: "text-orange-400", bg: "bg-orange-500/10" },
            ].map(({ name, type, bien, date, color, bg }) => (
              <div key={name} className="bg-slate-900/50 border border-slate-800/60 rounded-lg p-2 flex items-center gap-2">
                <div className={`w-7 h-7 rounded-md ${bg} flex items-center justify-center ${color} shrink-0`}><FileText size={12} /></div>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] font-medium text-slate-200 truncate">{name}</div>
                  <div className="text-[8px] text-slate-500 truncate">{type} • {bien} • {date}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
  },
  {
    id: "events",
    label: "Mes événements",
    content: (
      <div className="flex bg-[#020617] h-[260px]">
        <div className="w-12 border-r border-slate-800/60 bg-[#0f172a]/30 flex flex-col items-center pt-3 gap-3 shrink-0">
          <div className="w-6 h-6 flex items-center justify-center"><Logo size={18} withText={false} /></div>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 mt-2"><LayoutDashboard size={14} /></div>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500"><Home size={14} /></div>
          <div className="w-8 h-8 rounded-lg bg-blue-600/10 flex items-center justify-center text-blue-400"><Calendar size={14} /></div>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500"><FileText size={14} /></div>
        </div>
        <div className="flex-1 flex flex-col min-w-0 p-3 gap-2 overflow-hidden">
          <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Mes événements</div>
          <div className="flex gap-1.5">
            {["Tout", "À venir", "En retard"].map((f, i) => (
              <span key={f} className={`text-[9px] px-2 py-0.5 rounded-full border ${i === 0 ? "bg-blue-600/20 border-blue-500/40 text-blue-300" : "border-slate-700 text-slate-500"}`}>{f}</span>
            ))}
          </div>
          <div className="flex flex-col gap-1.5 overflow-hidden">
            {[
              { name: "Révision annuelle", bien: "Vélo Cargo", date: "Il y a 2 jours", status: "En retard", sc: "text-red-400 bg-red-500/10 border-red-500/20" },
              { name: "Contrôle technique", bien: "Voiture familiale", date: "Dans 12 jours", status: "À venir", sc: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20" },
              { name: "Renouvellement bail", bien: "Appartement Lyon", date: "Dans 3 mois", status: "À venir", sc: "text-green-400 bg-green-500/10 border-green-500/20" },
              { name: "Assurance habitation", bien: "Appartement Lyon", date: "Dans 4 mois", status: "À venir", sc: "text-green-400 bg-green-500/10 border-green-500/20" },
            ].map(({ name, bien, date, status, sc }) => (
              <div key={name} className="bg-slate-900/50 border border-slate-800/60 rounded-lg p-2 flex items-center gap-2">
                <div className={`w-7 h-7 rounded-md ${sc.split(" ").slice(1).join(" ")} flex items-center justify-center ${sc.split(" ")[0]} shrink-0`}><Calendar size={12} /></div>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] font-medium text-slate-200 truncate">{name}</div>
                  <div className="text-[8px] text-slate-500 truncate">{bien} • {date}</div>
                </div>
                <span className={`text-[7px] border rounded px-1.5 py-0.5 shrink-0 ${sc}`}>{status}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
  },
];

export function MobileMockupCarousel() {
  const [current, setCurrent] = useState(0);

  const prev = () => setCurrent((c) => (c - 1 + slides.length) % slides.length);
  const next = () => setCurrent((c) => (c + 1) % slides.length);

  return (
    <div className="md:hidden w-full">
      {/* Browser chrome */}
      <div className="rounded-2xl border border-[rgba(55,65,81,0.7)] bg-[rgba(9,14,28,0.95)] overflow-hidden shadow-[0_16px_40px_rgba(0,0,0,0.6)]">
        {/* Top bar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[rgba(31,41,55,0.9)] bg-[rgba(9,14,28,0.98)]">
          <div className="flex gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-[#ef4444]/70" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#f59e0b]/70" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#22c55e]/70" />
          </div>
          <div className="flex-1 mx-2">
            <div className="h-4 rounded-md bg-[rgba(31,41,55,0.8)] flex items-center px-2 max-w-[160px] mx-auto">
              <span className="text-[9px] text-slate-500 tracking-wide">app.verebona.com</span>
            </div>
          </div>
          {/* Slide label */}
          <span className="text-[9px] text-slate-500 shrink-0">{slides[current].label}</span>
        </div>

        {/* Slide content */}
        <div className="overflow-hidden">
          {slides[current].content}
        </div>
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-center gap-3 mt-3">
        <button
          onClick={prev}
          className="w-7 h-7 rounded-full border border-slate-700 bg-slate-900/60 flex items-center justify-center text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-colors"
          aria-label="Précédent"
        >
          <ChevronLeft size={14} />
        </button>

        {/* Dots */}
        <div className="flex gap-1.5">
          {slides.map((_, i) => (
            <button
              key={i}
              onClick={() => setCurrent(i)}
              className={`h-1.5 rounded-full transition-all duration-200 ${i === current ? "bg-blue-500 w-5" : "bg-slate-700 w-1.5 hover:bg-slate-500"}`}
              aria-label={`Aller à la slide ${i + 1}`}
            />
          ))}
        </div>

        <button
          onClick={next}
          className="w-7 h-7 rounded-full border border-slate-700 bg-slate-900/60 flex items-center justify-center text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-colors"
          aria-label="Suivant"
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
