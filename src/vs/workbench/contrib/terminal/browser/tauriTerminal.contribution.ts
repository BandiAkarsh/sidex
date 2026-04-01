/*---------------------------------------------------------------------------------------------
 *  Tauri Terminal PTY Bridge for SideX
 *  Wires xterm.js to the native PTY via Tauri's invoke/listen API,
 *  bypassing the VS Code extension-host terminal backend entirely.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { PANEL_BACKGROUND } from '../../../common/theme.js';
import {
	TERMINAL_BACKGROUND_COLOR,
	TERMINAL_FOREGROUND_COLOR,
	TERMINAL_CURSOR_FOREGROUND_COLOR,
	TERMINAL_CURSOR_BACKGROUND_COLOR,
	TERMINAL_SELECTION_BACKGROUND_COLOR,
	ansiColorIdentifiers,
} from '../common/terminalColorRegistry.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';

// ─── Tauri bridge (lazy-loaded) ──────────────────────────────────────────────

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined;
let _listen: ((event: string, handler: (event: { payload: unknown }) => void) => Promise<{ (): void }>) | undefined;

async function ensureTauri(): Promise<boolean> {
	if (_invoke && _listen) {
		return true;
	}
	try {
		const core = await import('@tauri-apps/api/core');
		const events = await import('@tauri-apps/api/event');
		_invoke = core.invoke;
		_listen = events.listen as typeof _listen;
		return true;
	} catch {
		console.warn('[TauriTerminal] @tauri-apps/api not available');
		return false;
	}
}

// ─── Theme helpers ───────────────────────────────────────────────────────────

function resolveColor(themeService: IThemeService, id: string): string | undefined {
	const color = themeService.getColorTheme().getColor(id);
	return color ? color.toString() : undefined;
}

function buildXtermTheme(themeService: IThemeService): Record<string, string | undefined> {
	const theme: Record<string, string | undefined> = {
		foreground: resolveColor(themeService, TERMINAL_FOREGROUND_COLOR),
		background: resolveColor(themeService, TERMINAL_BACKGROUND_COLOR)
			?? resolveColor(themeService, PANEL_BACKGROUND),
		cursor: resolveColor(themeService, TERMINAL_CURSOR_FOREGROUND_COLOR),
		cursorAccent: resolveColor(themeService, TERMINAL_CURSOR_BACKGROUND_COLOR),
		selectionBackground: resolveColor(themeService, TERMINAL_SELECTION_BACKGROUND_COLOR),
	};
	const ansiNames = [
		'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
		'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
		'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
	];
	for (let i = 0; i < ansiColorIdentifiers.length && i < ansiNames.length; i++) {
		theme[ansiNames[i]] = resolveColor(themeService, ansiColorIdentifiers[i]);
	}
	return theme;
}

// ─── Contribution ────────────────────────────────────────────────────────────

class TauriTerminalContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.tauriTerminal';

	private _panelEl: HTMLElement | undefined;
	private _terminalId: number | undefined;
	private _xtermInstance: import('@xterm/xterm').Terminal | undefined;
	private _fitAddon: import('@xterm/addon-fit').FitAddon | undefined;
	private _visible = false;

	constructor(
		@IWorkspaceContextService private readonly _workspaceCtx: IWorkspaceContextService,
		@IThemeService private readonly _themeService: IThemeService,
		@ILayoutService private readonly _layoutService: ILayoutService,
	) {
		super();
		this._registerToggleCommand();
	}

	// ── Command registration ──────────────────────────────────────────────

	private _registerToggleCommand(): void {
		this._register(toDisposable(
			CommandsRegistry.registerCommand('workbench.action.terminal.toggleTerminal', () => {
				this._toggle();
			}).dispose
		));
	}

	// ── Toggle logic ──────────────────────────────────────────────────────

	private async _toggle(): Promise<void> {
		if (this._visible && this._panelEl) {
			this._hidePanel();
			return;
		}
		await this._showPanel();
	}

	private _hidePanel(): void {
		if (this._panelEl) {
			this._panelEl.style.display = 'none';
		}
		this._visible = false;
	}

	private async _showPanel(): Promise<void> {
		if (this._panelEl) {
			this._panelEl.style.display = '';
			this._visible = true;
			this._fitAddon?.fit();
			this._xtermInstance?.focus();
			return;
		}

		const ok = await ensureTauri();
		if (!ok) {
			console.error('[TauriTerminal] Cannot start – Tauri APIs not available');
			return;
		}

		this._createPanel();
		await this._spawnAndAttach();
		this._visible = true;
	}

	// ── Panel DOM ─────────────────────────────────────────────────────────

	private _createPanel(): void {
		const container = this._layoutService.mainContainer ?? document.body;

		const panel = document.createElement('div');
		panel.className = 'tauri-terminal-panel';
		Object.assign(panel.style, {
			position: 'absolute',
			bottom: '0',
			left: '0',
			right: '0',
			height: '300px',
			zIndex: '100',
			display: 'flex',
			flexDirection: 'column',
			borderTop: '1px solid var(--vscode-panel-border, #444)',
			backgroundColor: 'var(--vscode-panel-background, #1e1e1e)',
		} satisfies Partial<CSSStyleDeclaration>);

		// Header bar with title + close button
		const header = document.createElement('div');
		Object.assign(header.style, {
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'space-between',
			padding: '0 8px',
			height: '28px',
			minHeight: '28px',
			fontSize: '11px',
			color: 'var(--vscode-panelTitle-activeForeground, #ccc)',
			backgroundColor: 'var(--vscode-panel-background, #1e1e1e)',
			textTransform: 'uppercase',
			letterSpacing: '0.5px',
			userSelect: 'none',
		} satisfies Partial<CSSStyleDeclaration>);
		header.textContent = 'Terminal';

		const closeBtn = document.createElement('button');
		Object.assign(closeBtn.style, {
			background: 'none',
			border: 'none',
			color: 'inherit',
			cursor: 'pointer',
			fontSize: '14px',
			padding: '0 4px',
			lineHeight: '1',
		} satisfies Partial<CSSStyleDeclaration>);
		closeBtn.textContent = '\u00d7'; // ×
		closeBtn.title = 'Hide Terminal';
		closeBtn.addEventListener('click', () => this._hidePanel());
		header.appendChild(closeBtn);

		// Terminal container
		const termContainer = document.createElement('div');
		termContainer.className = 'tauri-terminal-xterm';
		Object.assign(termContainer.style, {
			flex: '1',
			overflow: 'hidden',
		} satisfies Partial<CSSStyleDeclaration>);

		panel.appendChild(header);
		panel.appendChild(termContainer);
		container.appendChild(panel);
		this._panelEl = panel;

		this._register(toDisposable(() => {
			panel.remove();
		}));
	}

	// ── xterm.js + PTY wiring ─────────────────────────────────────────────

	private async _spawnAndAttach(): Promise<void> {
		if (!this._panelEl || !_invoke || !_listen) {
			return;
		}
		const termContainer = this._panelEl.querySelector('.tauri-terminal-xterm') as HTMLElement;
		if (!termContainer) {
			return;
		}

		// Dynamically import xterm to keep the initial bundle lean
		const [{ Terminal }, { FitAddon }] = await Promise.all([
			import('@xterm/xterm'),
			import('@xterm/addon-fit'),
		]);

		const theme = buildXtermTheme(this._themeService);

		const xterm = new Terminal({
			cursorBlink: true,
			fontSize: 13,
			fontFamily: 'Menlo, Monaco, "Courier New", monospace',
			theme,
			allowProposedApi: true,
		});
		this._xtermInstance = xterm;

		const fitAddon = new FitAddon();
		this._fitAddon = fitAddon;
		xterm.loadAddon(fitAddon);

		xterm.open(termContainer);
		fitAddon.fit();

		// Determine workspace cwd
		const folders = this._workspaceCtx.getWorkspace().folders;
		const cwd = folders.length > 0 ? folders[0].uri.fsPath : undefined;

		// Spawn PTY
		const terminalId = await _invoke('terminal_spawn', {
			shell: undefined,
			cwd: cwd ?? null,
			env: null,
		}) as number;
		this._terminalId = terminalId;

		// Listen for PTY output
		const unlisten = await _listen('terminal-data', (event) => {
			const payload = event.payload as { terminal_id: number; data: string };
			if (payload.terminal_id === terminalId) {
				xterm.write(payload.data);
			}
		});
		this._register(toDisposable(() => { unlisten(); }));

		// Forward user input to PTY
		this._register(toDisposable(
			xterm.onData((data: string) => {
				_invoke!('terminal_write', { terminalId, data });
			}).dispose
		));

		// Forward resize events to PTY
		this._register(toDisposable(
			xterm.onResize(({ cols, rows }: { cols: number; rows: number }) => {
				_invoke!('terminal_resize', { terminalId, cols, rows });
			}).dispose
		));

		// Handle window/panel resize
		const resizeObserver = new ResizeObserver(() => {
			fitAddon.fit();
		});
		resizeObserver.observe(termContainer);
		this._register(toDisposable(() => resizeObserver.disconnect()));

		// Update theme on change
		this._register(toDisposable(
			this._themeService.onDidColorThemeChange(() => {
				xterm.options.theme = buildXtermTheme(this._themeService);
			}).dispose
		));

		// Do an initial resize notification so the PTY knows the real dimensions
		const dims = fitAddon.proposeDimensions();
		if (dims) {
			await _invoke('terminal_resize', { terminalId, cols: dims.cols, rows: dims.rows });
		}

		xterm.focus();
	}

	// ── Cleanup ───────────────────────────────────────────────────────────

	override dispose(): void {
		if (this._terminalId !== undefined && _invoke) {
			_invoke('terminal_kill', { terminalId: this._terminalId }).catch(() => { });
		}
		this._xtermInstance?.dispose();
		super.dispose();
	}
}

// ─── Registration ────────────────────────────────────────────────────────────

registerWorkbenchContribution2(
	TauriTerminalContribution.ID,
	TauriTerminalContribution,
	WorkbenchPhase.AfterRestored,
);
