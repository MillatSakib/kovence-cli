"use strict";

import {
  Cpu,
  ShieldAlert,
  RotateCcw,
  Terminal,
  Layers,
  Activity,
  FileCode,
  SlidersHorizontal,
} from "lucide-react";

const features = [
  {
    icon: Cpu,
    title: "Zero Runtime Dependencies",
    description:
      "Engineered purely using modern Node.js standard modules. No bloated node_modules in production, zero supply-chain vulnerabilities, and instant startup in under 1 second.",
    badge: "Pure Node.js",
  },
  {
    icon: ShieldAlert,
    title: "True Autonomous Auto Mode",
    description:
      "When switched to Auto Mode, Kovence executes multi-step plans without badgering you with approval prompts. Protected by strict workspace sandboxing and audit logs.",
    badge: "Unattended Autonomy",
  },
  {
    icon: RotateCcw,
    title: "File Checkpoints & Instant /undo",
    description:
      "Every file write, edit, delete, and patch creates an automated checkpoint snapshot. Type /undo at any turn to immediately restore files to their exact prior state.",
    badge: "Safe Iteration",
  },
  {
    icon: Terminal,
    title: "Full-Screen TUI & Plain REPL",
    description:
      "Rich terminal UI with collapsible tool outputs, mouse-click folding, custom themes (Amber, Dark, Light, Terminal), and word navigation. Fallback to --plain for headless pipes.",
    badge: "Dual Interface",
  },
  {
    icon: Layers,
    title: "Universal LLM Compatibility",
    description:
      "Plug into OpenAI, Anthropic, Groq, DeepSeek, Ollama, or LiteLLM. Never leak keys: apiKeyEnv pulls credentials directly from your environment at runtime.",
    badge: "OpenAI & Anthropic",
  },
  {
    icon: Activity,
    title: "Background Tasks & Shell Escape",
    description:
      "Run tests, builds, and dev servers asynchronously. Stream task outputs with /tasks log <id> or terminate rogue jobs with /tasks kill. Execute shell commands with !cmd.",
    badge: "Process Management",
  },
  {
    icon: FileCode,
    title: "Precise File Mentions (@file)",
    description:
      "Inject targeted context directly using @filename or line-range targeting like @src/app.ts:L15-45. Keeps context tight and token costs low.",
    badge: "Smart Context",
  },
  {
    icon: SlidersHorizontal,
    title: "Built-in Environment Doctor",
    description:
      "Run 'kovence doctor' anytime to verify Node.js version, test system binaries (git, curl), validate JSON configs, and ping live LLM provider endpoints.",
    badge: "Diagnostics",
  },
];

export default function Features() {
  return (
    <section id="features" className="relative py-16 md:py-24 border-t border-white/[0.08]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center mb-16">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-xs font-mono font-medium text-amber-400 mb-4">
            Built for Engineers
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
            Everything You Need to Ship Faster
          </h2>
          <p className="mt-4 text-base sm:text-lg text-zinc-400">
            No heavy Python harnesses or fragile electron wrappers. A lightning-fast, resilient CLI tool that lives inside your terminal.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((feature, idx) => {
            const Icon = feature.icon;
            return (
              <div
                key={idx}
                className="group relative rounded-2xl border border-white/10 bg-zinc-950/60 p-6 hover:border-amber-500/40 hover:bg-zinc-900/60 transition-all duration-300"
              >
                <div className="flex items-center justify-between mb-4">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 group-hover:scale-110 group-hover:bg-amber-500 group-hover:text-black transition-all">
                    <Icon className="h-5 w-5" />
                  </div>
                  <span className="rounded-full bg-white/5 border border-white/10 px-2.5 py-0.5 text-[10px] font-mono text-zinc-400">
                    {feature.badge}
                  </span>
                </div>
                <h3 className="text-base font-bold text-white group-hover:text-amber-300 transition-colors">
                  {feature.title}
                </h3>
                <p className="mt-2 text-xs sm:text-sm text-zinc-400 leading-relaxed">
                  {feature.description}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
