"use strict";
"use client";

import { useState } from "react";
import { Copy, Check, ArrowRight, Terminal } from "lucide-react";

export default function QuickStart() {
  const [copiedStep, setCopiedStep] = useState<number | null>(null);

  const copyCode = (text: string, step: number) => {
    navigator.clipboard.writeText(text);
    setCopiedStep(step);
    setTimeout(() => setCopiedStep(null), 1800);
  };

  return (
    <section id="quickstart" className="relative py-16 md:py-24 border-t border-white/[0.08]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center mb-16">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-xs font-mono font-medium text-amber-400 mb-4">
            Zero Setup Friction
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
            Get Started in Under 60 Seconds
          </h2>
          <p className="mt-3 text-base text-zinc-400">
            No complex configuration files or background daemons required.
          </p>
        </div>

        <div className="mx-auto max-w-4xl grid grid-cols-1 md:grid-cols-3 gap-6 font-mono">
          {/* Step 1 */}
          <div className="relative rounded-2xl border border-white/10 bg-zinc-950 p-6 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-4">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/20 text-amber-400 font-bold text-sm">
                  1
                </span>
                <span className="text-[11px] text-zinc-500 uppercase tracking-wider">Installation</span>
              </div>
              <h3 className="text-sm font-bold text-white mb-2 font-sans">Install globally via npm</h3>
              <p className="text-xs text-zinc-400 font-sans leading-relaxed mb-4">
                Available on npm registry. Runs on any Node.js environment &gt;= 20.12.
              </p>
            </div>

            <div className="rounded-lg bg-zinc-900 border border-white/10 p-2.5 flex items-center justify-between text-xs">
              <span className="text-amber-300">npm i -g kovence-cli</span>
              <button
                onClick={() => copyCode("npm install -g kovence-cli", 1)}
                className="text-zinc-500 hover:text-white"
              >
                {copiedStep === 1 ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          {/* Step 2 */}
          <div className="relative rounded-2xl border border-white/10 bg-zinc-950 p-6 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-4">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/20 text-amber-400 font-bold text-sm">
                  2
                </span>
                <span className="text-[11px] text-zinc-500 uppercase tracking-wider">Configuration</span>
              </div>
              <h3 className="text-sm font-bold text-white mb-2 font-sans">Launch &amp; Add Provider</h3>
              <p className="text-xs text-zinc-400 font-sans leading-relaxed mb-4">
                Launch TUI and run /api add wizard. Point to your API key or environment variable.
              </p>
            </div>

            <div className="rounded-lg bg-zinc-900 border border-white/10 p-2.5 flex items-center justify-between text-xs">
              <span className="text-amber-300">kovence → /api add</span>
              <button
                onClick={() => copyCode("kovence", 2)}
                className="text-zinc-500 hover:text-white"
              >
                {copiedStep === 2 ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          {/* Step 3 */}
          <div className="relative rounded-2xl border border-white/10 bg-zinc-950 p-6 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-4">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/20 text-amber-400 font-bold text-sm">
                  3
                </span>
                <span className="text-[11px] text-zinc-500 uppercase tracking-wider">Diagnostics</span>
              </div>
              <h3 className="text-sm font-bold text-white mb-2 font-sans">Run Health Check</h3>
              <p className="text-xs text-zinc-400 font-sans leading-relaxed mb-4">
                Check environment compatibility, tools, and live API connectivity with doctor.
              </p>
            </div>

            <div className="rounded-lg bg-zinc-900 border border-white/10 p-2.5 flex items-center justify-between text-xs">
              <span className="text-amber-300">kovence doctor</span>
              <button
                onClick={() => copyCode("kovence doctor", 3)}
                className="text-zinc-500 hover:text-white"
              >
                {copiedStep === 3 ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        </div>

        {/* Doctor Callout Banner */}
        <div className="mx-auto max-w-4xl mt-12 rounded-2xl border border-white/10 bg-gradient-to-r from-zinc-950 via-zinc-900 to-zinc-950 p-6 flex flex-col sm:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
              <Terminal className="h-6 w-6" />
            </div>
            <div>
              <h4 className="text-base font-bold text-white">Need to verify your environment?</h4>
              <p className="text-xs sm:text-sm text-zinc-400 font-sans">
                The built-in <code className="text-amber-400 font-mono">kovence doctor</code> subcommand tests Node.js, git, config integrity, and pings your AI endpoints.
              </p>
            </div>
          </div>
          <button
            onClick={() => copyCode("kovence doctor", 99)}
            className="flex-shrink-0 inline-flex items-center gap-2 rounded-xl bg-zinc-800 border border-white/10 px-4 py-2.5 text-xs font-mono text-zinc-200 hover:bg-zinc-700 hover:text-white transition-all"
          >
            kovence doctor
            {copiedStep === 99 ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </section>
  );
}
