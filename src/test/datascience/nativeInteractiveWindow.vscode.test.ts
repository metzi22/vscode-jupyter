// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { assert } from 'chai';
import { anything, when } from 'ts-mockito';
import * as vscode from 'vscode';
import { IPythonApiProvider } from '../../client/api/types';
import { IApplicationShell } from '../../client/common/application/types';
import { PYTHON_LANGUAGE } from '../../client/common/constants';
import { IExportDialog } from '../../client/datascience/export/types';
import { NativeInteractiveWindow } from '../../client/datascience/interactive-window/nativeInteractiveWindow';
import { NativeInteractiveWindowProvider } from '../../client/datascience/interactive-window/nativeInteractiveWindowProvider';
import { IInteractiveWindowProvider } from '../../client/datascience/types';
import { IExtensionTestApi } from '../common';
import { closeActiveWindows, initialize } from '../initialize';
import { assertHasTextOutputInVSCode, waitForExecutionCompletedSuccessfully } from './notebook/helper';

suite('Native interactive window', () => {
    let api: IExtensionTestApi;
    let interactiveWindowProvider: NativeInteractiveWindowProvider;

    setup(async () => {
        api = await initialize();
        interactiveWindowProvider = api.serviceManager.get(IInteractiveWindowProvider);
    });
    teardown(async () => {
        await closeActiveWindows();
    });

    async function addCode(source: string) {
        const untitledPythonFile = await vscode.workspace.openTextDocument({ language: PYTHON_LANGUAGE });
        const activeInteractiveWindow = await interactiveWindowProvider.getOrCreate(untitledPythonFile.uri) as NativeInteractiveWindow;
        await activeInteractiveWindow.readyPromise;
        await activeInteractiveWindow.addCode(source, untitledPythonFile.uri, 0);
        return activeInteractiveWindow;
    }

    test('Open window and execute a cell', async () => {
        const source = 'print(42)';
        const activeInteractiveWindow = await addCode(source);
        const notebookDocument = vscode.workspace.notebookDocuments.find((doc) => doc.uri.toString() === activeInteractiveWindow?.notebookUri?.toString());

        // Ensure we picked up the active interpreter for use as the kernel
        const pythonApi = await api.serviceManager.get<IPythonApiProvider>(IPythonApiProvider).getApi();
        const activeInterpreter = await pythonApi.getActiveInterpreter();
        assert.equal(activeInteractiveWindow.notebookController?.connection.interpreter?.path, activeInterpreter?.path, 'Controller does not match active interpreter');
        assert.equal(activeInteractiveWindow.notebookController?.connection.interpreter?.envName, activeInterpreter?.envName, 'Controller does not match active interpreter');

        // Verify sys info cell
        const firstCell = notebookDocument?.cellAt(0);
        assert.ok(firstCell?.metadata.isInteractiveWindowMessageCell, 'First cell should be sys info cell');
        assert.equal(firstCell?.kind, vscode.NotebookCellKind.Markup, 'First cell should be markdown cell');

        // Verify executed cell input and output
        const secondCell = notebookDocument?.cellAt(1);
        const actualSource = secondCell?.document.getText();
        assert.equal(actualSource, source, `Executed cell has unexpected source code`);
        await waitForExecutionCompletedSuccessfully(secondCell!);
        assertHasTextOutputInVSCode(secondCell!, '42');
    });

    test('Clear output', async () => {
        const text = `from IPython.display import clear_output
for i in range(10):
    clear_output()
    print("Hello World {0}!".format(i))
`;
        const activeInteractiveWindow = await addCode(text);
        const notebookDocument = vscode.workspace.notebookDocuments.find((doc) => doc.uri.toString() === activeInteractiveWindow?.notebookUri?.toString());
        const cell = notebookDocument?.cellAt(notebookDocument.cellCount - 1);
        await waitForExecutionCompletedSuccessfully(cell!);
        assertHasTextOutputInVSCode(cell!, 'Hello World 9!');
    });

    test('Collapse / expand cell', async () => {
        // Cell should initially be collapsed
        const activeInteractiveWindow = await addCode('a=1\na');
        const notebookDocument = vscode.workspace.notebookDocuments.find((doc) => doc.uri.toString() === activeInteractiveWindow?.notebookUri?.toString());
        const codeCell = notebookDocument?.cellAt(notebookDocument.cellCount - 1);
        await waitForExecutionCompletedSuccessfully(codeCell!);
        assert.ok(codeCell?.metadata.inputCollapsed === true, 'Cell input not initially collapsed');

        // Expand all cells
        await vscode.commands.executeCommand('jupyter.expandallcells');

        // Verify cell is now expanded
        assert.ok(codeCell?.metadata.inputCollapsed === false, 'Cell input not expanded after expanding all cells');

        // Add a markdown cell
        const markdownSource = `# %% [markdown]
# # Heading
# ## Sub-heading
# *bold*,_italic_
# Horizontal rule
# ---
# Bullet List
# * Apples
# * Pears
# Numbered List
# 1. ???
# 2. Profit
#
# [Link](http://www.microsoft.com)`;
        await addCode(markdownSource);

        // Verify markdown cell is initially expanded
        const markdownCell = notebookDocument?.cellAt(notebookDocument.cellCount - 1);
        assert.ok(markdownCell?.metadata.inputCollapsed === false, 'Collapsing all cells should skip markdown cells');

        // Collapse all cells
        await vscode.commands.executeCommand('jupyter.collapseallcells');

        // Verify only the code cell was collapsed, not the markdown
        assert.ok(codeCell?.metadata.inputCollapsed === true, 'Code cell input not collapsed after collapsing all cells');
        assert.ok(markdownCell?.metadata.inputCollapsed === false, 'Collapsing all cells should skip markdown cells');
    });
    // test('Go to source / delete', async () => { });
    test('Export', async () => { });
    // test('Multiple interpreters', async () => { });
    test('Dispose test', async () => {
        const interactiveWindow = await interactiveWindowProvider.getOrCreate(undefined);
        await interactiveWindow.dispose();
        const interactiveWindow2 = await interactiveWindowProvider.getOrCreate(undefined);
        assert.ok(interactiveWindow.notebookUri?.toString() !== interactiveWindow2.notebookUri?.toString(), 'Disposing is not removing the active interactive window');
    });
    // test('Editor Context', async () => { });
    test('Simple input', async () => {
        const interactiveWindow = await interactiveWindowProvider.getOrCreate(undefined);
        const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'vscode-interactive-input');
        const source = 'a=1\na';
        await editor?.edit((e) => {
            e.insert(new vscode.Position(0, 0), source);
        })
        await vscode.commands.executeCommand('interactive.execute');
        const notebookDocument = vscode.workspace.notebookDocuments.find((doc) => doc.uri.toString() === interactiveWindow?.notebookUri?.toString());
        const cells = notebookDocument?.getCells();
        const codeCell = cells?.find((c) => c.kind === vscode.NotebookCellKind.Code);
        await waitForExecutionCompletedSuccessfully(codeCell!);
        assertHasTextOutputInVSCode(codeCell!, '1');
    });
    // test('Restart with session failure', async () => { });
    // test('LiveLossPlot', async () => { });
    // test('Type in input', async () => { });
    // test('Update display data', async () => { });
    // test('Multiple interactive windows', async () => { });
    // test('Multiple executes go to last active window', async () => { });
    // test('Per file', async () => { });
    // test('Per file asks and changes titles', async () => { });
});
