/*---------------------------------------------------------------------------------------------
 *  SideX — Tauri-backed search provider.
 *  Delegates file search and text search to Rust via `invoke()`.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { Schemas } from '../../../../base/common/network.js';
import { IEditorService } from '../../editor/common/editorService.js';
import { IExtensionService } from '../../extensions/common/extensions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import {
	IFileMatch,
	IFileQuery,
	ISearchComplete,
	ISearchProgressItem,
	ISearchResultProvider,
	ISearchService,
	ITextQuery,
	SearchProviderType,
	SearchRange,
} from '../common/search.js';
import { SearchService } from '../common/searchService.js';

// ── Rust ↔ TypeScript DTOs ──────────────────────────────────────────────────

interface TauriFileMatch {
	path: string;
	name: string;
	is_dir: boolean;
}

interface TauriTextMatch {
	path: string;
	line_number: number;
	line_content: string;
	column: number;
}

// ── Provider ────────────────────────────────────────────────────────────────

class TauriSearchProvider extends Disposable implements ISearchResultProvider {

	constructor(
		private readonly logService: ILogService,
	) {
		super();
	}

	async getAIName(): Promise<string | undefined> {
		return undefined;
	}

	async textSearch(
		query: ITextQuery,
		onProgress?: (p: ISearchProgressItem) => void,
		token?: CancellationToken,
	): Promise<ISearchComplete> {
		const results: IFileMatch[] = [];
		let limitHit = false;

		for (const fq of query.folderQueries) {
			if (token?.isCancellationRequested) { break; }

			const root = fq.folder.fsPath;
			const pattern = query.contentPattern.pattern;

			try {
				const matches = await invoke<TauriTextMatch[]>('search_text', {
					root,
					query: pattern,
					options: {
						max_results: query.maxResults ?? 500,
						case_sensitive: query.contentPattern.isCaseSensitive ?? false,
					},
				});

				const byFile = new Map<string, TauriTextMatch[]>();
				for (const m of matches) {
					const existing = byFile.get(m.path);
					if (existing) {
						existing.push(m);
					} else {
						byFile.set(m.path, [m]);
					}
				}

				for (const [filePath, fileMatches] of byFile) {
					const resource = URI.file(filePath);
					const textResults = fileMatches.map(m => {
						const lineNumber = m.line_number - 1; // 0-based
						const startColumn = m.column;
						const endColumn = m.column + pattern.length;
						const sourceRange = new SearchRange(lineNumber, startColumn, lineNumber, endColumn);
						const previewRange = new SearchRange(0, startColumn, 0, endColumn);
						return {
							previewText: m.line_content,
							rangeLocations: [{
								source: sourceRange,
								preview: previewRange,
							}],
						};
					});

					const fileMatch: IFileMatch = { resource, results: textResults };

					if (onProgress) {
						onProgress(fileMatch);
					}
					results.push(fileMatch);
				}

				if (matches.length >= (query.maxResults ?? 500)) {
					limitHit = true;
				}
			} catch (err) {
				this.logService.error('[SideX-Search] textSearch failed:', err);
			}
		}

		return { results, limitHit, messages: [] };
	}

	async fileSearch(
		query: IFileQuery,
		token?: CancellationToken,
	): Promise<ISearchComplete> {
		const results: IFileMatch[] = [];
		let limitHit = false;

		for (const fq of query.folderQueries) {
			if (token?.isCancellationRequested) { break; }

			const root = fq.folder.fsPath;
			const pattern = query.filePattern ?? '';

			try {
				const matches = await invoke<TauriFileMatch[]>('search_files', {
					root,
					pattern,
					options: {
						max_results: query.maxResults ?? 500,
					},
				});

				for (const m of matches) {
					if (!m.is_dir) {
						results.push({ resource: URI.file(m.path) });
					}
				}

				if (matches.length >= (query.maxResults ?? 500)) {
					limitHit = true;
				}
			} catch (err) {
				this.logService.error('[SideX-Search] fileSearch failed:', err);
			}
		}

		return { results, limitHit, messages: [] };
	}

	async clearCache(_cacheKey: string): Promise<void> {
		// no-op — Tauri search is stateless
	}
}

// ── Service ─────────────────────────────────────────────────────────────────

export class TauriSearchService extends SearchService {
	constructor(
		@IModelService modelService: IModelService,
		@IEditorService editorService: IEditorService,
		@ITelemetryService telemetryService: ITelemetryService,
		@ILogService logService: ILogService,
		@IExtensionService extensionService: IExtensionService,
		@IFileService fileService: IFileService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
	) {
		super(modelService, editorService, telemetryService, logService, extensionService, fileService, uriIdentityService);

		const provider = new TauriSearchProvider(logService);
		this.registerSearchResultProvider(Schemas.file, SearchProviderType.file, provider);
		this.registerSearchResultProvider(Schemas.file, SearchProviderType.text, provider);
		logService.info('[SideX] Registered TauriSearchProvider for file:// scheme');
	}
}

registerSingleton(ISearchService, TauriSearchService, InstantiationType.Delayed);
