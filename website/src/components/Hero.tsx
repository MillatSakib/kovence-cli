"use strict";
"use client";

import { useState } from "react";
import { Terminal, Copy, Check, ArrowRight, ShieldCheck, Zap, Sparkles, Box } from "lucide-react";

export default function Hero() {
  const [copied, setCopied] = useState(false);
  const [npxCopied, setNpxCopied] = useState(false);

  const copyToClipboard = (text: string, isNpx = false) => {
    navigator.clipboard.writeText(text);
    if (isNpx) {
      setNpxCopied(true);
      setTimeout(() => setNpxCopied(false), 2000);
    } else {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <section className="relative pt-20 pb-16 md:pt-28 md:pb-24 overflow-hidden">
      {/* Background radial gradients */}
      <div className="glow-orb top-[-100px] left-1/2 -translate-x-1/2 w-[700px] h-[350px] bg-amber-500/10" />
      <div className="glow-orb top-[200px] left-[-150px] w-[500px] h-[400px] bg-orange-600/5" />
      <div className="glow-orb top-[100px] right-[-150px] w-[500px] h-[400px] bg-yellow-500/5" />

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
        {/* Top Badges */}
        <div className="inline-flex flex-wrap items-center justify-center gap-2 mb-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3.5 py-1 text-xs font-medium text-amber-400">
            <Sparkles className="h-3.5 w-3.5" />
            <span>Autonomous AI Agent</span>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3.5 py-1 text-xs font-mono text-zinc-300">
            <Box className="h-3.5 w-3.5 text-zinc-400" />
            <span>0 Runtime Dependencies</span>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3.5 py-1 text-xs font-mono text-zinc-300">
            <Zap className="h-3.5 w-3.5 text-emerald-400" />
            <span>Node ≥ 20.12</span>
          </div>
        </div>

        {/* Hero Title */}
        <h1 className="mx-auto max-w-4xl text-4xl sm:text-6xl lg:text-7xl font-extrabold tracking-tight text-white leading-[1.1]">
          The Autonomous AI Coding Agent{" "}
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-amber-400 via-orange-400 to-amber-200">
            Built for Your Terminal
          </span>
        </h1>

        {/* Subtitle */}
        <p className="mx-auto mt-6 max-w-2xl text-lg sm:text-xl text-zinc-400 leading-relaxed">
          Zero npm runtime bloat. Full-screen interactive TUI. True unattended autonomy with file checkpoints, instant <code className="text-amber-400 bg-white/5 px-1.5 py-0.5 rounded font-mono text-base">/undo</code>, background shell tasks, and universal OpenAI & Anthropic compatibility.
        </p>

        {/* Command Install Box */}
        <div className="mx-auto mt-10 max-w-xl">
          <div className="relative rounded-2xl border border-white/15 bg-zinc-950/80 p-2 shadow-2xl shadow-black/80 backdrop-blur-xl">
            <div className="flex items-center justify-between rounded-xl bg-zinc-900/90 px-4 py-3 border border-white/5 font-mono text-sm sm:text-base">
              <div className="flex items-center gap-3 overflow-x-auto text-left">
                <span className="text-amber-400 select-none font-bold">$</span>
                <span className="text-zinc-100 font-medium whitespace-nowrap">
                  npm install -g kovence-cli
                </span>
              </div>
              <button
                onClick={() => copyToClipboard("npm install -g kovence-cli")}
                className="ml-3 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-zinc-300 hover:bg-amber-500 hover:text-black transition-colors"
                title="Copy install command"
              >
                {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
            
            <div className="mt-2 flex items-center justify-between px-2 pt-1 pb-1 text-xs font-mono text-zinc-400">
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                MIT License & Safe Sandboxing
              </span>
              <button
                onClick={() => copyToClipboard("npx kovence-cli@latest", true)}
                className="hover:text-amber-400 transition-colors flex items-center gap-1"
                title="Try without installing"
              >
                Or try: <span className="underline decoration-dashed">npx kovence-cli</span>
                {npxCopied ? <Check className="h-3 w-3 text-emerald-400" /> : null}
              </button>
            </div>
          </div>
        </div>

        {/* Call to Actions */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <a
            href="#quickstart"
            className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-6 py-3.5 text-sm font-semibold text-black shadow-lg shadow-amber-500/20 hover:bg-amber-400 active:scale-95 transition-all"
          >
            Get Started in 3 Steps
            <ArrowRight className="h-4 w-4" />
          </a>
          <a
            href="https://github.com/MillatSakib/kovence-cli"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-zinc-900/80 px-6 py-3.5 text-sm font-medium text-white hover:bg-zinc-800 hover:border-white/20 active:scale-95 transition-all"
          >
            <Terminal className="h-4 w-4 text-amber-400" />
            View Source on GitHub
          </a>
        </div>

        {/* Highlights Row */}
        <div className="mx-auto mt-16 max-w-4xl grid grid-cols-2 md:grid-cols-4 gap-4 sm:gap-6 border-t border-white/[0.08] pt-10">
          <div className="p-3 text-center">
            <div className="font-mono text-2xl sm:text-3xl font-bold text-amber-400">0</div>
            <div className="mt-1 text-xs text-zinc-400 uppercase tracking-wider font-mono">Runtime Dependencies</div>
          </div>
          <div className="p-3 text-center">
            <div className="font-mono text-2xl sm:text-3xl font-bold text-white">&lt; 1s</div>
            <div className="mt-1 text-xs text-zinc-400 uppercase tracking-wider font-mono">Cold Boot Time</div>
          </div>
          <div className="p-3 text-center">
            <div className="font-mono text-2xl sm:text-3xl font-bold text-amber-400">4 Modes</div>
            <div className="mt-1 text-xs text-zinc-400 uppercase tracking-wider font-mono">Plan / Edit / Auto / Def</div>
          </div>
          <div className="p-3 text-center">
            <div className="font-mono text-2xl sm:text-3xl font-bold text-white">53/53</div>
            <div className="mt-1 text-xs text-zinc-400 uppercase tracking-wider font-mono">Passed Test Suite</div>
          </div>
        </div>
      </div>
    </section>
  );
}
