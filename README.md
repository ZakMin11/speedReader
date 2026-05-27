# SRBZ (Speed Reader By Zak)

SRBZ is a desktop application that offers an alternative way to read dense PDFs through temporal word presentation.

Instead of scanning large blocks of text traditionally, SRBZ displays one word at a time at a configurable words-per-minute (WPM) rate, helping users maintain focus and move through long documents in a novel way.

Built with React, TypeScript, Vite, and Tauri.

---

## Features

- PDF viewing and navigation
- Temporal word-by-word reading mode
- Adjustable reading speed (WPM)
- Adjustable font size
- Multiple target-character highlighting modes
- Play / pause controls
- Jump forward or backward 5 words
- Double-click any word in the PDF to:
  - select a new starting point
  - begin speed reading from that word instantly
- Native desktop application powered by Tauri

---

## Why SRBZ?

Traditional PDF reading can become mentally exhausting, especially for long technical papers, textbooks, documentation, or research articles.

SRBZ experiments with an alternative reading interface by presenting words sequentially in a focused reading window. This reduces the need for constant eye-scanning across dense paragraphs and allows the user to maintain a more consistent reading rhythm.

The app was designed with accessibility and neurodivergent-friendly reading workflows in mind.

---

## Tech Stack

### Frontend
- React 19
- TypeScript
- Vite

### Desktop Runtime
- Tauri 2

### PDF Rendering
- pdfjs-dist
- react-pdf

---

