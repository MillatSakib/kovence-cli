"use strict";

import Navbar from "@/components/Navbar";
import Hero from "@/components/Hero";
import TerminalPreview from "@/components/TerminalPreview";
import Features from "@/components/Features";
import AgentModes from "@/components/AgentModes";
import CommandExplorer from "@/components/CommandExplorer";
import Shortcuts from "@/components/Shortcuts";
import QuickStart from "@/components/QuickStart";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <div className="relative min-h-screen bg-[#09090b] text-[#f4f4f5] selection:bg-amber-500 selection:text-black">
      {/* Background Subtle Grid Pattern */}
      <div className="absolute inset-0 bg-grid-pattern opacity-40 pointer-events-none" />

      {/* Main Layout */}
      <Navbar />
      <main className="relative z-10 flex flex-col">
        <Hero />
        <TerminalPreview />
        <Features />
        <AgentModes />
        <CommandExplorer />
        <Shortcuts />
        <QuickStart />
      </main>
      <Footer />
    </div>
  );
}
