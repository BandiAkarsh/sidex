/*---------------------------------------------------------------------------------------------
 *  Tauri Git SCM Provider for SideX
 *  Registers a native Git source control provider using Tauri's invoke() API
 *  instead of the VS Code extension host protocol.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { observableValue } from '../../../../base/common/observable.js';
import type { IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { ResourceTree } from '../../../../base/common/resourceTree.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { basename, relativePath } from '../../../../base/common/resources.js';
import { Schemas } from '../../../../base/common/network.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { ISCMService, ISCMProvider, ISCMResource, ISCMResourceGroup, ISCMResourceDecorations, ISCMActionButtonDescriptor } from '../common/scm.js';
import type { ISCMHistoryProvider, ISCMHistoryOptions, ISCMHistoryItem, ISCMHistoryItemChange, ISCMHistoryItemRef, ISCMHistoryItemRefsChangeEvent } from '../common/history.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { ISCMArtifactProvider } from '../common/artifact.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { FileSystemProviderCapabilities, FileType, FilePermission } from '../../../../platform/files/common/files.js';
import type { IFileSystemProvider, IStat, IFileDeleteOptions, IFileOverwriteOptions, IFileWriteOptions, IWatchOptions, IFileChange } from '../../../../platform/files/common/files.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import type { Command } from '../../../../editor/common/languages.js';
import type { Event } from '../../../../base/common/event.js';

// ─── Tauri invoke() bridge ──────────────────────────────────────────────────

interface TauriGitChange {
	path: string;
	status: string;
	staged: boolean;
}

interface TauriGitStatus {
	branch: string;
	changes: TauriGitChange[];
}

interface TauriGitLogEntry {
	hash: string;
	message: string;
	author: string;
	date: string;
}

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined;

async function getTauriInvoke(): Promise<typeof _invoke> {
	if (_invoke) {
		return _invoke;
	}
	try {
		const mod = await import('@tauri-apps/api/core');
		_invoke = mod.invoke;
		return _invoke;
	} catch {
		return undefined;
	}
}

async function invokeGit<T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
	const invoke = await getTauriInvoke();
	if (!invoke) {
		return undefined;
	}
	return invoke(cmd, args) as Promise<T>;
}

// ─── Git Original File System Provider ──────────────────────────────────────

const GIT_ORIGINAL_SCHEME = 'git-original';

class TauriGitOriginalFileProvider implements IFileSystemProvider {

	readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.Readonly;

	private readonly _onDidChangeCapabilities = new Emitter<void>();
	readonly onDidChangeCapabilities: Event<void> = this._onDidChangeCapabilities.event;

	private readonly _onDidChangeFile = new Emitter<readonly IFileChange[]>();
	readonly onDidChangeFile: Event<readonly IFileChange[]> = this._onDidChangeFile.event;

	constructor(private readonly _workspaceRoot: string) {}

	watch(_resource: URI, _opts: IWatchOptions): IDisposable {
		return Disposable.None;
	}

	async stat(_resource: URI): Promise<IStat> {
		return { type: FileType.File, ctime: 0, mtime: 0, size: 0, permissions: FilePermission.Readonly };
	}

	async mkdir(_resource: URI): Promise<void> {
		throw new Error('git-original is read-only');
	}

	async readdir(_resource: URI): Promise<[string, FileType][]> {
		return [];
	}

	async delete(_resource: URI, _opts: IFileDeleteOptions): Promise<void> {
		throw new Error('git-original is read-only');
	}

	async rename(_from: URI, _to: URI, _opts: IFileOverwriteOptions): Promise<void> {
		throw new Error('git-original is read-only');
	}

	async readFile(resource: URI): Promise<Uint8Array> {
		const filePath = resource.path.startsWith('/') ? resource.path.slice(1) : resource.path;
		const invoke = await getTauriInvoke();
		if (!invoke) {
			return new Uint8Array();
		}
		try {
			const bytes = await invoke('git_show', { path: this._workspaceRoot, file: filePath }) as number[];
			return new Uint8Array(bytes);
		} catch {
			return new Uint8Array();
		}
	}

	async writeFile(_resource: URI, _content: Uint8Array, _opts: IFileWriteOptions): Promise<void> {
		throw new Error('git-original is read-only');
	}
}

// ─── SCM Resource ───────────────────────────────────────────────────────────

class TauriGitResource implements ISCMResource {

	readonly decorations: ISCMResourceDecorations;
	readonly contextValue: string | undefined;
	readonly command: Command | undefined;
	readonly multiDiffEditorOriginalUri: URI | undefined;
	readonly multiDiffEditorModifiedUri: URI | undefined;

	constructor(
		readonly resourceGroup: ISCMResourceGroup,
		readonly sourceUri: URI,
		private readonly _status: string,
		private readonly _staged: boolean,
		private readonly _workspaceRootUri: URI,
	) {
		this.decorations = TauriGitResource._decorationForStatus(_status);
		this.contextValue = _staged ? 'staged' : 'unstaged';

		const relPath = relativePath(_workspaceRootUri, sourceUri) ?? sourceUri.path;

		if (_status === 'untracked' || _status === 'added') {
			this.command = { id: 'tauri-git.openFile', title: 'Open File' };
			this.multiDiffEditorOriginalUri = undefined;
			this.multiDiffEditorModifiedUri = sourceUri;
		} else if (_status === 'deleted') {
			const originalUri = URI.from({ scheme: GIT_ORIGINAL_SCHEME, path: `/${relPath}` });
			this.command = { id: 'tauri-git.openDiff', title: 'Open Changes' };
			this.multiDiffEditorOriginalUri = originalUri;
			this.multiDiffEditorModifiedUri = undefined;
		} else {
			const originalUri = URI.from({ scheme: GIT_ORIGINAL_SCHEME, path: `/${relPath}` });
			this.command = { id: 'tauri-git.openDiff', title: 'Open Changes' };
			this.multiDiffEditorOriginalUri = originalUri;
			this.multiDiffEditorModifiedUri = sourceUri;
		}
	}

	async open(_preserveFocus: boolean): Promise<void> {
		const commandService = (globalThis as any).__sidex_commandService;
		if (!commandService) {
			return;
		}
		if (this.command?.id === 'tauri-git.openDiff') {
			await commandService.executeCommand('tauri-git.openDiff', this);
		} else {
			await commandService.executeCommand('tauri-git.openFile', this);
		}
	}

	private static _decorationForStatus(status: string): ISCMResourceDecorations {
		switch (status) {
			case 'modified':
				return { tooltip: 'Modified', icon: ThemeIcon.fromId('diff-modified') };
			case 'added':
			case 'new file':
				return { tooltip: 'Added', icon: ThemeIcon.fromId('diff-added') };
			case 'deleted':
				return { tooltip: 'Deleted', icon: ThemeIcon.fromId('diff-removed'), strikeThrough: true };
			case 'renamed':
				return { tooltip: 'Renamed', icon: ThemeIcon.fromId('diff-renamed') };
			case 'untracked':
				return { tooltip: 'Untracked', icon: ThemeIcon.fromId('question'), faded: true };
			default:
				return { tooltip: status };
		}
	}
}

// ─── SCM Resource Group ─────────────────────────────────────────────────────

class TauriGitResourceGroup implements ISCMResourceGroup {

	resources: ISCMResource[] = [];

	private _resourceTree: ResourceTree<ISCMResource, ISCMResourceGroup> | undefined;
	get resourceTree(): ResourceTree<ISCMResource, ISCMResourceGroup> {
		if (!this._resourceTree) {
			const rootUri = this.provider.rootUri ?? URI.file('/');
			this._resourceTree = new ResourceTree<ISCMResource, ISCMResourceGroup>(this, rootUri, this._uriIdentService.extUri);
			for (const resource of this.resources) {
				this._resourceTree.add(resource.sourceUri, resource);
			}
		}
		return this._resourceTree;
	}

	readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	readonly _onDidChangeResources = new Emitter<void>();
	readonly onDidChangeResources: Event<void> = this._onDidChangeResources.event;

	readonly hideWhenEmpty: boolean;
	contextValue: string | undefined;
	readonly multiDiffEditorEnableViewChanges = false;

	constructor(
		readonly id: string,
		readonly label: string,
		readonly provider: ISCMProvider,
		private readonly _uriIdentService: IUriIdentityService,
		hideWhenEmpty: boolean = false,
	) {
		this.contextValue = id;
		this.hideWhenEmpty = hideWhenEmpty;
	}

	setResources(resources: ISCMResource[]): void {
		this.resources = resources;
		this._resourceTree = undefined;
		this._onDidChangeResources.fire();
		this._onDidChange.fire();
	}
}

// ─── SCM History Provider ───────────────────────────────────────────────────

class TauriGitHistoryProvider implements ISCMHistoryProvider {

	private readonly _historyItemRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
	readonly historyItemRef: IObservable<ISCMHistoryItemRef | undefined> = this._historyItemRef;

	private readonly _historyItemRemoteRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
	readonly historyItemRemoteRef: IObservable<ISCMHistoryItemRef | undefined> = this._historyItemRemoteRef;

	private readonly _historyItemBaseRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
	readonly historyItemBaseRef: IObservable<ISCMHistoryItemRef | undefined> = this._historyItemBaseRef;

	private readonly _historyItemRefChanges = observableValue<ISCMHistoryItemRefsChangeEvent>(this, { added: [], removed: [], modified: [], silent: true });
	readonly historyItemRefChanges: IObservable<ISCMHistoryItemRefsChangeEvent> = this._historyItemRefChanges;

	constructor(
		private readonly _rootPath: string,
		private readonly _rootUri: URI,
		private readonly _logService: ILogService,
	) { }

	updateRef(branch: string, headHash?: string): void {
		this._historyItemRef.set({
			id: `refs/heads/${branch}`,
			name: branch,
			revision: headHash,
			icon: ThemeIcon.fromId('git-branch'),
		}, undefined);
	}

	async provideHistoryItemRefs(_historyItemRefs?: string[], _token?: CancellationToken): Promise<ISCMHistoryItemRef[] | undefined> {
		const current = this._historyItemRef.get();
		return current ? [current] : [];
	}

	async provideHistoryItems(options: ISCMHistoryOptions, _token?: CancellationToken): Promise<ISCMHistoryItem[] | undefined> {
		try {
			const limit = typeof options.limit === 'number' ? options.limit : 50;
			const entries = await invokeGit<TauriGitLogEntry[]>('git_log', {
				path: this._rootPath,
				limit: limit + (options.skip ?? 0),
			});

			if (!entries) {
				return [];
			}

			const skip = options.skip ?? 0;
			const sliced = skip > 0 ? entries.slice(skip) : entries;

			return sliced.map(entry => ({
				id: entry.hash,
				parentIds: [],
				subject: entry.message,
				message: entry.message,
				displayId: entry.hash.substring(0, 7),
				author: entry.author,
				timestamp: new Date(entry.date).getTime(),
				references: [],
			} satisfies ISCMHistoryItem));
		} catch (err) {
			this._logService.warn('[TauriGit] git_log failed', err);
			return [];
		}
	}

	async provideHistoryItemChanges(historyItemId: string, _historyItemParentId: string | undefined, _token?: CancellationToken): Promise<ISCMHistoryItemChange[] | undefined> {
		try {
			const parentRef = _historyItemParentId ?? `${historyItemId}~1`;

			const invoke = await getTauriInvoke();
			if (!invoke) {
				return [];
			}

			let nameOutput: string;
			try {
				nameOutput = await invoke('git_run', {
					path: this._rootPath,
					args: ['diff-tree', '--no-commit-id', '-r', '--name-status', parentRef, historyItemId],
				}) as string;
			} catch {
				// git_run may not exist; fall back to returning empty
				nameOutput = await invoke('git_run', {
					path: this._rootPath,
					args: ['diff-tree', '--no-commit-id', '-r', '--name-only', historyItemId],
				}) as string;
			}

			if (!nameOutput || !nameOutput.trim()) {
				return [];
			}

			return nameOutput.trim().split('\n')
				.filter(line => line.trim())
				.map(line => {
					const parts = line.split('\t');
					const filePath = parts.length > 1 ? parts[parts.length - 1] : parts[0];
					const fileUri = URI.joinPath(this._rootUri, filePath.trim());
					return {
						uri: fileUri,
						originalUri: fileUri.with({ scheme: 'git', query: parentRef }),
						modifiedUri: fileUri.with({ scheme: 'git', query: historyItemId }),
					} satisfies ISCMHistoryItemChange;
				});
		} catch (err) {
			this._logService.warn('[TauriGit] provideHistoryItemChanges failed', err);
			return [];
		}
	}

	async resolveHistoryItem(historyItemId: string, _token?: CancellationToken): Promise<ISCMHistoryItem | undefined> {
		const items = await this.provideHistoryItems({ limit: 100 });
		return items?.find(item => item.id === historyItemId);
	}

	async resolveHistoryItemChatContext(_historyItemId: string, _token?: CancellationToken): Promise<string | undefined> {
		return undefined;
	}

	async resolveHistoryItemChangeRangeChatContext(_historyItemId: string, _historyItemParentId: string, _path: string, _token?: CancellationToken): Promise<string | undefined> {
		return undefined;
	}

	async resolveHistoryItemRefsCommonAncestor(_historyItemRefs: string[], _token?: CancellationToken): Promise<string | undefined> {
		return undefined;
	}
}

// ─── SCM Provider ───────────────────────────────────────────────────────────

class TauriGitSCMProvider extends Disposable implements ISCMProvider {

	readonly id: string;
	readonly providerId = 'tauri-git';
	readonly label = 'Git';
	readonly name: string;
	readonly rootUri: URI;
	readonly iconPath = ThemeIcon.fromId('source-control');
	readonly isHidden = false;
	readonly inputBoxTextModel: ITextModel;

	private readonly _contextValue = observableValue<string | undefined>(this, 'tauri-git');
	get contextValue(): IObservable<string | undefined> { return this._contextValue; }

	private readonly _count = observableValue<number | undefined>(this, undefined);
	get count(): IObservable<number | undefined> { return this._count; }

	private readonly _commitTemplate = observableValue<string>(this, '');
	get commitTemplate(): IObservable<string> { return this._commitTemplate; }

	private readonly _actionButton = observableValue<ISCMActionButtonDescriptor | undefined>(this, undefined);
	get actionButton(): IObservable<ISCMActionButtonDescriptor | undefined> { return this._actionButton; }

	private readonly _statusBarCommands = observableValue<readonly Command[] | undefined>(this, undefined);
	get statusBarCommands(): IObservable<readonly Command[] | undefined> { return this._statusBarCommands; }

	private readonly _artifactProvider = observableValue<ISCMArtifactProvider | undefined>(this, undefined);
	get artifactProvider(): IObservable<ISCMArtifactProvider | undefined> { return this._artifactProvider; }

	private readonly _historyProvider = observableValue<ISCMHistoryProvider | undefined>(this, undefined);
	get historyProvider(): IObservable<ISCMHistoryProvider | undefined> { return this._historyProvider; }

	readonly acceptInputCommand: Command = {
		id: 'tauri-git.commit',
		title: 'Commit',
	};

	private readonly _stagedGroup: TauriGitResourceGroup;
	private readonly _changesGroup: TauriGitResourceGroup;
	readonly groups: TauriGitResourceGroup[];
	private _historyProviderInstance: TauriGitHistoryProvider | undefined;

	private readonly _onDidChangeResourceGroups = new Emitter<void>();
	readonly onDidChangeResourceGroups: Event<void> = this._onDidChangeResourceGroups.event;

	private readonly _onDidChangeResources = new Emitter<void>();
	readonly onDidChangeResources: Event<void> = this._onDidChangeResources.event;

	private _branch = '';

	constructor(
		rootUri: URI,
		modelService: IModelService,
		languageService: ILanguageService,
		private readonly uriIdentityService: IUriIdentityService,
		private readonly logService: ILogService,
	) {
		super();

		this.rootUri = rootUri;
		this.id = `tauri-git:${rootUri.toString()}`;
		this.name = basename(rootUri) || 'Git';

		const inputUri = URI.from({ scheme: Schemas.vscodeSourceControl, path: `/${this.id}/input` });
		let model = modelService.getModel(inputUri);
		if (!model) {
			model = modelService.createModel('', languageService.createById('scminput'), inputUri);
		}
		this.inputBoxTextModel = model;

		this._stagedGroup = new TauriGitResourceGroup('staged', 'Staged Changes', this, uriIdentityService, true);
		this._changesGroup = new TauriGitResourceGroup('changes', 'Changes', this, uriIdentityService, false);
		this.groups = [this._stagedGroup, this._changesGroup];

		this._register(this._onDidChangeResourceGroups);
		this._register(this._onDidChangeResources);
		this._register(this._stagedGroup._onDidChange);
		this._register(this._stagedGroup._onDidChangeResources);
		this._register(this._changesGroup._onDidChange);
		this._register(this._changesGroup._onDidChangeResources);
	}

	setupHistoryProvider(): void {
		this._historyProviderInstance = new TauriGitHistoryProvider(
			this.rootUri.fsPath,
			this.rootUri,
			this.logService,
		);
		this._historyProvider.set(this._historyProviderInstance, undefined);
	}

	async getOriginalResource(uri: URI): Promise<URI | null> {
		const relPath = relativePath(this.rootUri, uri);
		if (!relPath) {
			return null;
		}
		return URI.from({ scheme: GIT_ORIGINAL_SCHEME, path: `/${relPath}` });
	}

	async refresh(): Promise<void> {
		const rootPath = this.rootUri.fsPath;
		let status: TauriGitStatus | undefined;
		try {
			status = await invokeGit<TauriGitStatus>('git_status', { path: rootPath });
			console.log('[TauriGit] git_status result:', status);
		} catch (err) {
			console.error('[TauriGit] git_status failed:', err);
			this.logService.warn('[TauriGit] git_status failed', err);
			return;
		}

		if (!status) {
			console.log('[TauriGit] No status returned');
			return;
		}

		this._branch = status.branch;
		console.log('[TauriGit] Branch:', this._branch, 'Changes:', status.changes.length);

		if (this._historyProviderInstance) {
			try {
				const logEntries = await invokeGit<TauriGitLogEntry[]>('git_log', { path: rootPath, limit: 1 });
				const headHash = logEntries?.[0]?.hash;
				this._historyProviderInstance.updateRef(this._branch, headHash);
			} catch {
				this._historyProviderInstance.updateRef(this._branch);
			}
		}

		const stagedResources: ISCMResource[] = [];
		const changesResources: ISCMResource[] = [];

		for (const change of status.changes) {
			const fileUri = URI.joinPath(this.rootUri, change.path);
			if (change.staged) {
				stagedResources.push(new TauriGitResource(this._stagedGroup, fileUri, change.status, true, this.rootUri));
			} else {
				changesResources.push(new TauriGitResource(this._changesGroup, fileUri, change.status, false, this.rootUri));
			}
		}

		this._stagedGroup.setResources(stagedResources);
		this._changesGroup.setResources(changesResources);

		// Fire provider-level change events so the SCM view updates
		this._onDidChangeResources.fire();
		this._onDidChangeResourceGroups.fire();

		const total = stagedResources.length + changesResources.length;
		this._count.set(total, undefined);

		this._statusBarCommands.set([{
			id: 'tauri-git.checkoutTo',
			title: `$(git-branch) ${this._branch}`,
			tooltip: `Branch: ${this._branch}`,
		}, {
			id: 'tauri-git.sync',
			title: '$(sync)',
			tooltip: 'Synchronize Changes',
		}], undefined);

		this._actionButton.set({
			command: { id: 'tauri-git.commit', title: '$(check) Commit' },
			enabled: true,
		}, undefined);

		this._onDidChangeResources.fire();
	}
}

// ─── Workbench Contribution ─────────────────────────────────────────────────

class TauriGitContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.tauriGit';

	private _pollHandle: ReturnType<typeof setInterval> | undefined;

	constructor(
		@ISCMService private readonly scmService: ISCMService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
		this._init();
	}

	private async _init(): Promise<void> {
		console.log('[TauriGit] _init started');
		const folders = this.workspaceContextService.getWorkspace().folders;
		console.log('[TauriGit] Workspace folders:', folders.length, folders.map(f => f.uri.toString()));

		// Store folders globally for git.init command
		(window as any).__sidex_workspaceFolders = folders.map(f => f.uri.fsPath);

		if (folders.length === 0) {
			console.log('[TauriGit] No workspace folders, skipping');
			return;
		}

		const rootUri = folders[0].uri;
		const rootPath = rootUri.fsPath;
		console.log('[TauriGit] Checking if git repo:', rootPath);

		let isRepo: boolean | undefined;
		try {
			isRepo = await invokeGit<boolean>('git_is_repo', { path: rootPath });
			console.log('[TauriGit] git_is_repo result:', isRepo);
		} catch (err) {
			console.error('[TauriGit] git_is_repo failed:', err);
			this.logService.info('[TauriGit] git_is_repo unavailable — Tauri backend not present', err);
			return;
		}

		if (!isRepo) {
			console.log('[TauriGit] Not a git repo, skipping');
			return;
		}

		console.log('[TauriGit] Git repository detected, registering SCM provider');

		const provider = new TauriGitSCMProvider(
			rootUri,
			this.modelService,
			this.languageService,
			this.uriIdentityService,
			this.logService,
		);

		const repository = this.scmService.registerSCMProvider(provider);
		this._register(repository);
		this._register(provider);

		// Register the git-original file system provider for diff views
		const originalProvider = new TauriGitOriginalFileProvider(rootPath);
		try {
			this._register(this.fileService.registerProvider(GIT_ORIGINAL_SCHEME, originalProvider));
		} catch {
			// Already registered from a previous init
		}

		// Set the commit message placeholder
		repository.input.placeholder = `Message (⌘Enter to commit on "${provider.name}")`;

		this._registerDiffCommands(provider, rootPath);
		this._registerCommitCommand(provider, rootPath);

		provider.setupHistoryProvider();

		await provider.refresh();

		this._pollHandle = setInterval(() => provider.refresh(), 3000);
		this._register({
			dispose: () => {
				if (this._pollHandle !== undefined) {
					clearInterval(this._pollHandle);
					this._pollHandle = undefined;
				}
			}
		});
	}

	private _registerDiffCommands(provider: TauriGitSCMProvider, rootPath: string): void {
		this._register(CommandsRegistry.registerCommand('tauri-git.openDiff', async (_accessor, ...args: any[]) => {
			try {
				const commandService = (globalThis as any).__sidex_commandService;
				if (!commandService) { return; }

				const resource = args[0];
				const sourceUri: URI | undefined = resource?.sourceUri ?? resource;
				if (!sourceUri) { return; }

				const relPath = relativePath(provider.rootUri, sourceUri) ?? sourceUri.path;
				const originalUri = URI.from({ scheme: GIT_ORIGINAL_SCHEME, path: `/${relPath}` });
				const modifiedUri = sourceUri;
				const fileName = basename(sourceUri);
				const title = `${fileName} (Working Tree)`;

				await commandService.executeCommand('vscode.diff', originalUri, modifiedUri, title);
			} catch (err) {
				console.error('[TauriGit] open diff failed:', err);
			}
		}));
	}

	private _registerCommitCommand(provider: TauriGitSCMProvider, rootPath: string): void {
		this._register(CommandsRegistry.registerCommand('tauri-git.commit', async () => {
			const message = provider.inputBoxTextModel.getValue();
			if (!message.trim()) {
				return;
			}
			try {
				const hash = await invokeGit<string>('git_commit', { path: rootPath, message });
				this.logService.info(`[TauriGit] Committed: ${hash}`);
				provider.inputBoxTextModel.setValue('');
				await provider.refresh();
			} catch (err) {
				this.logService.error('[TauriGit] commit failed', err);
			}
		}));

		this._register(CommandsRegistry.registerCommand('tauri-git.stageAll', async () => {
			try {
				await invokeGit('git_add', { path: rootPath, files: ['.'] });
				await provider.refresh();
			} catch (err) {
				this.logService.error('[TauriGit] stage all failed', err);
			}
		}));

		this._register(CommandsRegistry.registerCommand('tauri-git.unstageAll', async () => {
			try {
				const invoke = await getTauriInvoke();
				if (invoke) {
					await invoke('git_checkout', { path: rootPath, branch: 'HEAD' });
				}
				await provider.refresh();
			} catch (err) {
				this.logService.error('[TauriGit] unstage all failed', err);
			}
		}));

		this._register(CommandsRegistry.registerCommand('tauri-git.refresh', async () => {
			await provider.refresh();
		}));

		this._register(CommandsRegistry.registerCommand('tauri-git.discardAll', async () => {
			try {
				const invoke = await getTauriInvoke();
				if (invoke) {
					await invoke('git_checkout', { path: rootPath, branch: '.' });
				}
				await provider.refresh();
			} catch (err) {
				this.logService.error('[TauriGit] discard all failed', err);
			}
		}));

		this._register(CommandsRegistry.registerCommand('tauri-git.openAllChanges', async () => {
			try {
				const commandService = (globalThis as any).__sidex_commandService;
				if (!commandService) { return; }
				const status = await invokeGit<TauriGitStatus>('git_status', { path: rootPath });
				if (!status) { return; }
				for (const change of status.changes) {
					const fileUri = URI.joinPath(provider.rootUri, change.path);
					if (change.status === 'untracked' || change.status === 'added') {
						await commandService.executeCommand('vscode.open', fileUri);
					} else {
						const relPath = change.path;
						const originalUri = URI.from({ scheme: GIT_ORIGINAL_SCHEME, path: `/${relPath}` });
						const fileName = basename(fileUri);
						await commandService.executeCommand('vscode.diff', originalUri, fileUri, `${fileName} (Working Tree)`);
					}
				}
			} catch (err) {
				console.error('[TauriGit] open all changes failed', err);
			}
		}));

		this._register(CommandsRegistry.registerCommand('tauri-git.stageFile', async (_accessor, ...args: any[]) => {
			try {
				const resource = args[0];
				const uri = resource?.sourceUri ?? resource;
				if (uri?.fsPath) {
					await invokeGit('git_add', { path: rootPath, files: [uri.fsPath] });
					await provider.refresh();
				}
			} catch (err) {
				console.error('[TauriGit] stage file failed', err);
			}
		}));

		this._register(CommandsRegistry.registerCommand('tauri-git.discardFile', async (_accessor, ...args: any[]) => {
			try {
				const resource = args[0];
				const uri = resource?.sourceUri ?? resource;
				if (uri?.fsPath) {
					await invokeGit('git_checkout', { path: rootPath, branch: '-- ' + uri.fsPath });
					await provider.refresh();
				}
			} catch (err) {
				console.error('[TauriGit] discard file failed', err);
			}
		}));

		this._register(CommandsRegistry.registerCommand('tauri-git.openFile', async (_accessor, ...args: any[]) => {
			try {
				const resource = args[0];
				const uri = resource?.sourceUri ?? resource;
				if (uri) {
					const commandService = (globalThis as any).__sidex_commandService;
					if (commandService) {
						const status = (resource as any)?._status;
						if (status && status !== 'untracked' && status !== 'added' && status !== 'deleted') {
							await commandService.executeCommand('tauri-git.openDiff', resource);
						} else {
							await commandService.executeCommand('vscode.open', uri);
						}
					}
				}
			} catch (err) {
				console.error('[TauriGit] open file failed', err);
			}
		}));

		this._register(CommandsRegistry.registerCommand('tauri-git.unstageFile', async (_accessor, ...args: any[]) => {
			try {
				const resource = args[0];
				const uri = resource?.sourceUri ?? resource;
				if (uri?.fsPath) {
					await invokeGit('git_reset', { path: rootPath, files: [uri.fsPath] });
					await provider.refresh();
				}
			} catch (err) {
				console.error('[TauriGit] unstage file failed', err);
			}
		}));

		this._register(CommandsRegistry.registerCommand('tauri-git.unstageAll', async () => {
			try {
				await invokeGit('git_reset', { path: rootPath, files: ['.'] });
				await provider.refresh();
			} catch (err) {
				console.error('[TauriGit] unstage all failed', err);
			}
		}));
	}
}

// Register git.init command globally so the "Initialize Repository" button works
CommandsRegistry.registerCommand('git.init', async () => {
	try {
		const invoke = await getTauriInvoke();
		if (!invoke) { return; }

		const { open } = await import('@tauri-apps/plugin-dialog');
		// Use the current workspace folder if available, otherwise ask
		const folders = (window as any).__sidex_workspaceFolders;
		let targetPath: string | undefined;

		if (folders && folders.length > 0) {
			targetPath = folders[0];
		} else {
			const selected = await open({ directory: true, title: 'Initialize Git Repository' });
			if (selected && typeof selected === 'string') {
				targetPath = selected;
			}
		}

		if (!targetPath) { return; }

		await invoke('git_init', { path: targetPath });
		console.log('[TauriGit] Repository initialized at', targetPath);

		// Reload to pick up the new git repo
		window.location.reload();
	} catch (err) {
		console.error('[TauriGit] git init failed:', err);
	}
});

registerWorkbenchContribution2(
	TauriGitContribution.ID,
	TauriGitContribution,
	WorkbenchPhase.AfterRestored,
);

// ─── Repository-level commands ──────────────────────────────────────────────

function getWorkspacePath(): string | undefined {
	const folders = (window as any).__sidex_workspaceFolders;
	return folders && folders.length > 0 ? folders[0] : undefined;
}

CommandsRegistry.registerCommand('tauri-git.pull', async () => {
	const path = getWorkspacePath();
	if (!path) { return; }
	try {
		const result = await invokeGit<string>('git_pull', { path });
		console.log('[TauriGit] pull:', result);
	} catch (err) {
		console.error('[TauriGit] pull failed:', err);
	}
});

CommandsRegistry.registerCommand('tauri-git.push', async () => {
	const path = getWorkspacePath();
	if (!path) { return; }
	try {
		const result = await invokeGit<string>('git_push', { path });
		console.log('[TauriGit] push:', result);
	} catch (err) {
		console.error('[TauriGit] push failed:', err);
	}
});

CommandsRegistry.registerCommand('tauri-git.fetch', async () => {
	const path = getWorkspacePath();
	if (!path) { return; }
	try {
		const result = await invokeGit<string>('git_fetch', { path });
		console.log('[TauriGit] fetch:', result);
	} catch (err) {
		console.error('[TauriGit] fetch failed:', err);
	}
});

CommandsRegistry.registerCommand('tauri-git.clone', async () => {
	const url = window.prompt('Repository URL to clone:');
	if (!url) { return; }
	const dest = window.prompt('Destination path:');
	if (!dest) { return; }
	try {
		await invokeGit('git_clone', { url, path: dest });
		console.log('[TauriGit] cloned', url, 'to', dest);
	} catch (err) {
		console.error('[TauriGit] clone failed:', err);
	}
});

CommandsRegistry.registerCommand('tauri-git.checkoutTo', async () => {
	const path = getWorkspacePath();
	if (!path) { return; }
	const branch = window.prompt('Branch name to checkout:');
	if (!branch) { return; }
	try {
		await invokeGit('git_checkout', { path, branch });
		console.log('[TauriGit] checked out', branch);
	} catch (err) {
		console.error('[TauriGit] checkout failed:', err);
	}
});

CommandsRegistry.registerCommand('tauri-git.createBranch', async () => {
	const path = getWorkspacePath();
	if (!path) { return; }
	const name = window.prompt('New branch name:');
	if (!name) { return; }
	try {
		await invokeGit('git_create_branch', { path, name });
		console.log('[TauriGit] created branch', name);
	} catch (err) {
		console.error('[TauriGit] create branch failed:', err);
	}
});

CommandsRegistry.registerCommand('tauri-git.sync', async () => {
	const path = getWorkspacePath();
	if (!path) { return; }
	try {
		await invokeGit<string>('git_pull', { path });
		await invokeGit<string>('git_push', { path });
		console.log('[TauriGit] sync complete');
	} catch (err) {
		console.error('[TauriGit] sync failed:', err);
	}
});

// ─── SCM Source Control ("...") menu items ──────────────────────────────────

MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	command: { id: 'tauri-git.pull', title: 'Pull' },
	group: '1_sync',
	order: 1,
});

MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	command: { id: 'tauri-git.push', title: 'Push' },
	group: '1_sync',
	order: 2,
});

MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	command: { id: 'tauri-git.fetch', title: 'Fetch' },
	group: '1_sync',
	order: 3,
});

MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	command: { id: 'tauri-git.sync', title: 'Synchronize Changes', icon: ThemeIcon.fromId('sync') },
	group: '1_sync',
	order: 4,
});

MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	command: { id: 'tauri-git.clone', title: 'Clone...' },
	group: '1_sync',
	order: 5,
});

MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	command: { id: 'tauri-git.checkoutTo', title: 'Checkout to...' },
	group: '4_branch',
	order: 1,
});

MenuRegistry.appendMenuItem(MenuId.SCMSourceControlInline, {
	command: { id: 'tauri-git.createBranch', title: 'Create Branch...' },
	group: '4_branch',
	order: 2,
});

// Register SCM title toolbar actions (the buttons next to "CHANGES" header)
MenuRegistry.appendMenuItem(MenuId.SCMTitle, {
	command: { id: 'tauri-git.commit', title: 'Commit', icon: ThemeIcon.fromId('check') },
	group: 'navigation',
	order: 1,
});

MenuRegistry.appendMenuItem(MenuId.SCMTitle, {
	command: { id: 'tauri-git.refresh', title: 'Refresh', icon: ThemeIcon.fromId('refresh') },
	group: 'navigation',
	order: 2,
});

// Buttons on the "Changes" group header
MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, {
	command: { id: 'tauri-git.stageAll', title: 'Stage All Changes', icon: ThemeIcon.fromId('add') },
	group: 'inline',
	order: 3,
	when: ContextKeyExpr.equals('scmResourceGroup', 'changes'),
});

MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, {
	command: { id: 'tauri-git.discardAll', title: 'Discard All Changes', icon: ThemeIcon.fromId('discard') },
	group: 'inline',
	order: 2,
	when: ContextKeyExpr.equals('scmResourceGroup', 'changes'),
});

MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, {
	command: { id: 'tauri-git.openAllChanges', title: 'Open All Changes', icon: ThemeIcon.fromId('go-to-file') },
	group: 'inline',
	order: 1,
	when: ContextKeyExpr.equals('scmResourceGroup', 'changes'),
});

// Buttons on the "Staged Changes" group header
MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, {
	command: { id: 'tauri-git.unstageAll', title: 'Unstage All Changes', icon: ThemeIcon.fromId('remove') },
	group: 'inline',
	order: 2,
	when: ContextKeyExpr.equals('scmResourceGroup', 'staged'),
});

MenuRegistry.appendMenuItem(MenuId.SCMResourceGroupContext, {
	command: { id: 'tauri-git.openAllChanges', title: 'Open All Staged Changes', icon: ThemeIcon.fromId('go-to-file') },
	group: 'inline',
	order: 1,
	when: ContextKeyExpr.equals('scmResourceGroup', 'staged'),
});

// Register buttons on individual changed files (stage, discard, open)
// Buttons on unstaged files: Open File, Discard, Stage
MenuRegistry.appendMenuItem(MenuId.SCMResourceContext, {
	command: { id: 'tauri-git.stageFile', title: 'Stage Changes', icon: ThemeIcon.fromId('add') },
	group: 'inline',
	order: 3,
	when: ContextKeyExpr.equals('scmResourceGroup', 'changes'),
});

MenuRegistry.appendMenuItem(MenuId.SCMResourceContext, {
	command: { id: 'tauri-git.discardFile', title: 'Discard Changes', icon: ThemeIcon.fromId('discard') },
	group: 'inline',
	order: 2,
	when: ContextKeyExpr.equals('scmResourceGroup', 'changes'),
});

MenuRegistry.appendMenuItem(MenuId.SCMResourceContext, {
	command: { id: 'tauri-git.openFile', title: 'Open File', icon: ThemeIcon.fromId('go-to-file') },
	group: 'inline',
	order: 1,
});

// Buttons on staged files: Open File, Unstage
MenuRegistry.appendMenuItem(MenuId.SCMResourceContext, {
	command: { id: 'tauri-git.unstageFile', title: 'Unstage Changes', icon: ThemeIcon.fromId('remove') },
	group: 'inline',
	order: 3,
	when: ContextKeyExpr.equals('scmResourceGroup', 'staged'),
});
