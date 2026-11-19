import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Kovence CLI — Zero-Dependency Autonomous AI Coding Agent",
  description:
    "Fast, zero-dependency AI coding agent CLI for Node.js (>=20.12). Native full-screen TUI, session management, file checkpoints, undo, and multi-provider LLM support.",
  keywords: [
    "AI coding agent",
    "CLI",
    "TUI",
    "developer tools",
    "terminal agent",
    "OpenAI",
    "Anthropic",
    "Node.js",
    "autonomous agent",
    "kovence",
  ],
  authors: [{ name: "Kovence Team", url: "https://kovence-cli.kovence.com" }],
  openGraph: {
    title: "Kovence CLI — Zero-Dependency Autonomous AI Coding Agent",
    description:
      "Terminal-native AI coding assistant with zero runtime dependencies. Checkpoints, undo, background tasks, and deep provider flexibility.",
    url: "https://kovence-cli.kovence.com",
    siteName: "Kovence CLI",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Kovence CLI",
    description: "Zero-dependency autonomous AI coding agent for your terminal.",
  },
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col bg-[#09090b] text-[#f4f4f5]">
        {children}
      </body>
    </html>
  );
}
