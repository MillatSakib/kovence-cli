"use strict";
"use client";

import { useState } from "react";
import { Terminal, Menu, X, ArrowUpRight, Copy, Check } from "lucide-react";
import GithubIcon from "./GithubIcon";

export default function Navbar() {
  const [copied, setCopied] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const copyInstall = () => {
    navigator.clipboard.writeText("npm install -g kovence-cli");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b border-white/[0.08] bg-[#09090b]/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <a href="#" className="flex items-center gap-2.5 group">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-500 group-hover:bg-amber-500/20 group-hover:border-amber-500/50 transition-all">
              <Terminal className="h-5 w-5" />
            </div>
            <div className="flex flex-col">
              <span className="font-mono text-base font-bold tracking-tight text-white group-hover:text-amber-400 transition-colors">
                KOVENCE<span className="text-amber-500">.CLI</span>
              </span>
            </div>
          </a>
          <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/5 px-2.5 py-0.5 text-[11px] font-mono font-medium text-amber-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
            v1.0.2
          </span>
        </div>

        {/* Desktop Nav */}
        <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-zinc-400">
          <a href="#features" className="hover:text-white transition-colors">Features</a>
          <a href="#modes" className="hover:text-white transition-colors">Agent Modes</a>
          <a href="#commands" className="hover:text-white transition-colors">Commands</a>
          <a href="#shortcuts" className="hover:text-white transition-colors">Shortcuts</a>
          <a href="#quickstart" className="hover:text-white transition-colors">Quickstart</a>
          <a
            href="https://github.com/MillatSakib/kovence-cli"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 hover:text-white transition-colors"
          >
            Docs <ArrowUpRight className="h-3 w-3 text-zinc-500" />
          </a>
        </nav>

        {/* Right CTA */}
        <div className="hidden sm:flex items-center gap-3">
          <button
            onClick={copyInstall}
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-zinc-900/80 px-3 py-1.5 text-xs font-mono text-zinc-300 hover:border-amber-500/40 hover:bg-zinc-800 transition-all active:scale-95"
            title="Click to copy install command"
          >
            <span className="text-amber-400">$</span> npm i -g kovence-cli
            {copied ? (
              <Check className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <Copy className="h-3.5 w-3.5 text-zinc-400" />
            )}
          </button>

          <a
            href="https://github.com/MillatSakib/kovence-cli"
            target="_blank"
            rel="noreferrer"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-zinc-900/80 text-zinc-300 hover:bg-zinc-800 hover:text-white hover:border-white/20 transition-all"
            aria-label="GitHub Repository"
          >
            <GithubIcon className="h-4 w-4" />
          </a>
        </div>

        {/* Mobile menu button */}
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="md:hidden flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-zinc-400 hover:text-white"
          aria-label="Toggle menu"
        >
          {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* Mobile drawer */}
      {mobileMenuOpen && (
        <div className="md:hidden border-b border-white/[0.08] bg-[#0c0c10] px-4 py-4 space-y-3">
          <a
            href="#features"
            onClick={() => setMobileMenuOpen(false)}
            className="block py-1.5 text-sm font-medium text-zinc-300 hover:text-white"
          >
            Features
          </a>
          <a
            href="#modes"
            onClick={() => setMobileMenuOpen(false)}
            className="block py-1.5 text-sm font-medium text-zinc-300 hover:text-white"
          >
            Agent Modes
          </a>
          <a
            href="#commands"
            onClick={() => setMobileMenuOpen(false)}
            className="block py-1.5 text-sm font-medium text-zinc-300 hover:text-white"
          >
            Commands
          </a>
          <a
            href="#shortcuts"
            onClick={() => setMobileMenuOpen(false)}
            className="block py-1.5 text-sm font-medium text-zinc-300 hover:text-white"
          >
            Shortcuts
          </a>
          <a
            href="#quickstart"
            onClick={() => setMobileMenuOpen(false)}
            className="block py-1.5 text-sm font-medium text-zinc-300 hover:text-white"
          >
            Quickstart
          </a>
          <div className="pt-2 border-t border-white/10 flex flex-col gap-2">
            <button
              onClick={copyInstall}
              className="flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-300"
            >
              <span className="text-amber-400">$</span> npm i -g kovence-cli
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            <a
              href="https://github.com/MillatSakib/kovence-cli"
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-center gap-2 rounded-lg bg-amber-500 py-2 text-xs font-semibold text-black"
            >
              <GithubIcon className="h-4 w-4" /> GitHub Repository
            </a>
          </div>
        </div>
      )}
    </header>
  );
}
