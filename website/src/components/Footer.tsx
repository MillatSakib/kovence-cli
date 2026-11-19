"use strict";

import { Terminal, Heart, Shield, ArrowUpRight } from "lucide-react";
import GithubIcon from "./GithubIcon";

export default function Footer() {
  return (
    <footer className="border-t border-white/[0.08] bg-[#070709] py-12 text-xs font-mono text-zinc-400">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-12">
          {/* Col 1: Brand */}
          <div className="space-y-3 md:col-span-1">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-500">
                <Terminal className="h-4 w-4" />
              </div>
              <span className="font-bold text-white tracking-wider">
                KOVENCE<span className="text-amber-500">.CLI</span>
              </span>
            </div>
            <p className="text-zinc-500 font-sans text-xs leading-relaxed">
              Zero-dependency multi-step AI coding-agent CLI for Node.js (≥ 20.12). Built for terminal power users.
            </p>
            <div className="flex items-center gap-3 pt-2 text-zinc-400">
              <a
                href="https://github.com/MillatSakib/kovence-cli"
                target="_blank"
                rel="noreferrer"
                className="hover:text-white transition-colors"
                aria-label="GitHub"
              >
                <GithubIcon className="h-4 w-4" />
              </a>
              <a
                href="https://www.npmjs.com/package/kovence-cli"
                target="_blank"
                rel="noreferrer"
                className="hover:text-white transition-colors"
              >
                npm
              </a>
            </div>
          </div>

          {/* Col 2: Navigation */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-200 mb-3">Product</h4>
            <ul className="space-y-2">
              <li>
                <a href="#features" className="hover:text-amber-400 transition-colors">Features</a>
              </li>
              <li>
                <a href="#modes" className="hover:text-amber-400 transition-colors">Agent Modes</a>
              </li>
              <li>
                <a href="#commands" className="hover:text-amber-400 transition-colors">Slash Commands</a>
              </li>
              <li>
                <a href="#shortcuts" className="hover:text-amber-400 transition-colors">Shortcuts</a>
              </li>
              <li>
                <a href="#quickstart" className="hover:text-amber-400 transition-colors">Quickstart</a>
              </li>
            </ul>
          </div>

          {/* Col 3: Ecosystem */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-200 mb-3">Ecosystem</h4>
            <ul className="space-y-2">
              <li>
                <a
                  href="https://www.npmjs.com/package/kovence-cli"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 hover:text-amber-400 transition-colors"
                >
                  npm Package <ArrowUpRight className="h-3 w-3 text-zinc-600" />
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/MillatSakib/kovence-cli/releases"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 hover:text-amber-400 transition-colors"
                >
                  Release Notes <ArrowUpRight className="h-3 w-3 text-zinc-600" />
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/MillatSakib/kovence-cli/issues"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 hover:text-amber-400 transition-colors"
                >
                  Report Bug <ArrowUpRight className="h-3 w-3 text-zinc-600" />
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/MillatSakib/kovence-cli/blob/main/LICENSE"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 hover:text-amber-400 transition-colors"
                >
                  MIT License <ArrowUpRight className="h-3 w-3 text-zinc-600" />
                </a>
              </li>
            </ul>
          </div>

          {/* Col 4: Autonomy & Security */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-200 mb-3">Autonomy &amp; Safety</h4>
            <p className="text-zinc-500 font-sans text-xs leading-relaxed mb-3">
              Kovence CLI prioritizes true unattended autonomy without compromising repository integrity. Every edit is snapshotted to a checkpoint with instant rollback.
            </p>
            <div className="flex items-center gap-2 text-emerald-400 text-[11px]">
              <Shield className="h-3.5 w-3.5" />
              <span>Zero telemetry, local execution</span>
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="pt-8 border-t border-white/5 flex flex-col sm:flex-row items-center justify-between gap-4 text-[11px] text-zinc-500">
          <div>
            © 2026 Kovence CLI. Open source under the MIT License.
          </div>
          <div className="flex items-center gap-4">
            <span>Node.js ≥ 20.12</span>
            <span>·</span>
            <span>Zero Runtime Dependencies</span>
            <span>·</span>
            <span>v1.0.2</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
