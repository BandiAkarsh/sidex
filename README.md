# SideX

A Tauri-based port of Visual Studio Code. Same architecture, native performance, fraction of the size.

> **Early Release** — This project is in active development. Many features are not fully working yet. We're releasing early because a lot of people wanted to help build this out. If you're into open source and want to help make a lightweight, native code editor a reality, you're in the right place.

## What is SideX?

SideX is a 1:1 architectural port (HEAVILY STRIPPED) of VSCode that replaces Electron with [Tauri](https://tauri.app/) (Rust backend + native webview). The entire VSCode workbench - editor, terminal, extensions, themes, keybindings — ported to run on a native shell.

- **5,600+ TypeScript files** from VSCode's source, ported and adapted
- **Rust backend** replacing Electron's main process
- **Zero Electron imports** remaining in the codebase
- **Lightweight** — fraction of VSCode's install size

Goal: 200mb RAM usage. 

## Current State

This is an early release. Here's an honest look at where things stand:

**Working:**
- Core editor (Monaco) with syntax highlighting, IntelliSense basics
- File explorer — open folders, create/edit/delete files
- Integrated terminal (PTY via Rust)
- Basic Git integration
- Theme support
- Native menus
- Extension loading from [Open VSX](https://open-vsx.org/)

**In Progress / Unstable:**
- Many workbench features are stubbed or partially implemented
- Extension host is early-stage — not all extensions will work
- Debugging support is scaffolded but incomplete
- Settings/keybindings UI may have rough edges
- Some platform services are placeholder implementations
- Multi-window support is limited

We need help across the board. See [Contributing](#contributing) below.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) 1.77.2+
- Platform dependencies for Tauri — see the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/)

### Development

```bash
# Clone the repo
git clone https://github.com/Sidenai/sidex.git
cd sidex

# Install dependencies
npm install

# Start dev server with hot reload
npm run tauri dev
```

### Production Build

Building from source (not distributing pre-built binaries yet):

```bash
# Install dependencies (if not already done)
npm install

# Build the frontend (increase memory for large codebase)
# macOS / Linux:
NODE_OPTIONS="--max-old-space-size=12288" npm run build

# Windows (PowerShell):
$env:NODE_OPTIONS="--max-old-space-size=12288"
npm run build

# Build the Tauri app (takes 5-10 minutes)
npx tauri build
```

### Troubleshooting

**Linux blank screen:** If you get a blank/white screen on Linux, run with:
```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 npm run tauri dev
```

## Architecture

SideX preserves VSCode's layered architecture and replaces the Electron runtime with Tauri:

```
VSCode (Electron)                    SideX (Tauri)
─────────────────                    ─────────────
Electron Main Process            →   Tauri Rust Backend
  BrowserWindow                  →   WebviewWindow
  ipcMain / ipcRenderer          →   invoke() + events
  Node.js APIs (fs, pty, etc.)   →   Rust commands (std::fs, portable-pty)
  Menu / Dialog / Clipboard      →   Tauri plugins

Renderer (DOM + TypeScript)      →   Same (runs in native webview)
Extension Host                   →   Sidecar process (in progress)
```

### Project Structure

```
sidex/
├── src/                    # TypeScript frontend (VSCode workbench)
│   ├── vs/
│   │   ├── base/           # Foundation utilities
│   │   ├── platform/       # Platform services (DI)
│   │   ├── editor/         # Monaco editor
│   │   ├── workbench/      # IDE shell, features, services
│   │   └── code/           # Application entry
│   └── main.ts             # Frontend entry point
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── commands/       # fs, terminal, search, git, window, etc.
│   │   ├── lib.rs          # App setup, menu, command registration
│   │   └── main.rs         # Entry point
│   └── Cargo.toml
├── index.html              # HTML shell
├── vite.config.ts          # Vite config (port 1420)
└── package.json
```

For a deep dive into the architecture, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Contributing

We want your help. Seriously.

This project was released early specifically so the community can help build it out. There's a ton of work to do — from fixing bugs to implementing entire subsystems.

### How to Contribute

1. **Fork the repo** and create a branch for your work
2. **Pick something** — check the [Issues](https://github.com/Sidenai/sidex/issues) tab, or just find something broken and fix it
3. **Submit a PR** — we'll review it, and if it gets merged, you'll be added as a contributor

### Areas That Need Help

- **Terminal** — Shell integration, profile detection, stability
- **Extensions** — Extension host compatibility, API coverage
- **File System** — Watcher reliability, large file handling
- **Editor** — IntelliSense integration, language services
- **Debugging** — Debug adapter protocol implementation
- **Settings** — Settings UI, keybinding editor
- **Search** — Workspace search reliability and performance
- **Platform** — Windows and Linux testing and fixes
- **UI Polish** — Layout issues, theming gaps, accessibility

### Dev Tips

- The codebase follows VSCode's patterns — if you've worked on VSCode, you'll feel right at home
- TypeScript imports use `.js` extensions (ES modules)
- Services use VSCode's dependency injection with `@inject` decorators
- Rust commands are in `src-tauri/src/commands/` — add new ones and register in `lib.rs`
- See [AGENTS.md](./AGENTS.md) for a detailed guide to the codebase (useful for AI-assisted development too)

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | TypeScript, Vite 6, Monaco Editor, xterm.js |
| Backend | Rust, Tauri 2, portable-pty, rusqlite, tokio |
| Editor | Monaco (from VSCode source) |
| Terminal | xterm.js + Rust PTY via portable-pty |
| Extensions | Open VSX registry |
| Storage | SQLite (via rusqlite) |

## Community

- **Discord:** [Join the SideX server](https://discord.gg/8CUCnEAC4J)
- **X / Twitter:** [@ImRazshy](https://x.com/ImRazshy)
- **Email:** kendall@siden.ai

## Credits

- Architecture from [Microsoft VSCode](https://github.com/microsoft/vscode) (MIT License)
- Porting methodology inspired by [Open Claw](https://github.com/instructkr/claw-code)
- Built with [Tauri](https://tauri.app/)

## License

MIT - This project is a port of [Visual Studio Code (Code - OSS)](https://github.com/microsoft/vscode), which is licensed under the MIT License. See [LICENSE](./LICENSE) for details.
