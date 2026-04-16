/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import * as pfs from '../../../../base/node/pfs.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { flakySuite, getRandomTestPath } from '../../../../base/test/node/testUtils.js';
import { getSingleFolderWorkspaceIdentifier, getWorkspaceIdentifier } from '../../browser/workspaces.js';

flakySuite('Workspaces', () => {
	let testDir: string;

	const tmpDir = os.tmpdir();

	setup(async () => {
		testDir = getRandomTestPath(tmpDir, 'vsctests', 'workspacesmanagementmainservice');

		return fs.promises.mkdir(testDir, { recursive: true });
	});

	teardown(() => {
		return pfs.Promises.rm(testDir);
	});

	test('getSingleWorkspaceIdentifier', async function () {
		const nonLocalUri = URI.parse('myscheme://server/work/p/f1');
		const nonLocalUriId = getSingleFolderWorkspaceIdentifier(nonLocalUri);
		assert.ok(nonLocalUriId?.id);

		const localUri = URI.file(path.join(testDir, 'f1'));
		const localUriId = getSingleFolderWorkspaceIdentifier(localUri);
		assert.ok(localUriId?.id);
	});

	test('workspace identifiers are stable', function () {
		// workspace identifier (local) — IDs are hash-based, just verify they are consistent
		const id1 = getWorkspaceIdentifier(URI.file('/hello/test')).id;
		assert.strictEqual(getWorkspaceIdentifier(URI.file('/hello/test')).id, id1);

		// single folder identifier (local)
		const id2 = getSingleFolderWorkspaceIdentifier(URI.file('/hello/test'))?.id;
		assert.strictEqual(getSingleFolderWorkspaceIdentifier(URI.file('/hello/test'))?.id, id2);

		// workspace identifier (remote)
		const id3 = getWorkspaceIdentifier(URI.parse('vscode-remote:/hello/test')).id;
		assert.strictEqual(getWorkspaceIdentifier(URI.parse('vscode-remote:/hello/test')).id, id3);

		// single folder identifier (remote)
		const id4 = getSingleFolderWorkspaceIdentifier(URI.parse('vscode-remote:/hello/test'))?.id;
		assert.strictEqual(getSingleFolderWorkspaceIdentifier(URI.parse('vscode-remote:/hello/test'))?.id, id4);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
