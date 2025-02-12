// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { inject, injectable, named } from 'inversify';

import * as vscode from 'vscode';
import { Cancellation } from '../../common/cancellation';
import { PYTHON } from '../../common/constants';
import { traceError } from '../../common/logger';
import { IFileSystem } from '../../common/platform/types';

import { sleep } from '../../common/utils/async';
import { noop } from '../../common/utils/misc';
import { StopWatch } from '../../common/utils/stopWatch';
import { sendTelemetryEvent } from '../../telemetry';
import { Identifiers, Telemetry } from '../constants';
import {
    ICell,
    IHoverProvider,
    IInteractiveWindowProvider,
    IJupyterVariables,
    INotebook,
    INotebookExecutionLogger
} from '../types';

// This class provides hashes for debugging jupyter cells. Call getHashes just before starting debugging to compute all of the
// hashes for cells.
@injectable()
export class HoverProvider implements INotebookExecutionLogger, IHoverProvider {
    private runFiles = new Set<string>();
    private hoverProviderRegistration: vscode.Disposable | undefined;
    private stopWatch = new StopWatch();

    constructor(
        @inject(IJupyterVariables) @named(Identifiers.KERNEL_VARIABLES) private variableProvider: IJupyterVariables,
        @inject(IInteractiveWindowProvider) private interactiveProvider: IInteractiveWindowProvider,
        @inject(IFileSystem) private readonly fs: IFileSystem
    ) {}

    public dispose() {
        if (this.hoverProviderRegistration) {
            this.hoverProviderRegistration.dispose();
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public onKernelRestarted() {
        this.runFiles.clear();
    }

    public async preExecute(cell: ICell, silent: boolean): Promise<void> {
        try {
            if (!silent && cell.file && cell.file !== Identifiers.EmptyFileName) {
                const size = this.runFiles.size;
                this.runFiles.add(cell.file.toLocaleLowerCase());
                if (size !== this.runFiles.size) {
                    await this.initializeHoverProvider();
                }
            }
        } catch (exc) {
            // Don't let exceptions in a preExecute mess up normal operation
            traceError(exc);
        }
    }

    public async postExecute(_cell: ICell, _silent: boolean): Promise<void> {
        noop();
    }

    public provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        const timeoutHandler = async () => {
            await sleep(300);
            return null;
        };
        this.stopWatch.reset();
        const result = Promise.race([timeoutHandler(), this.getVariableHover(document, position, token)]);
        sendTelemetryEvent(Telemetry.InteractiveFileTooltipsPerf, this.stopWatch.elapsedTime, {
            isResultNull: !!result
        });
        return result;
    }

    private async initializeHoverProvider() {
        if (!this.hoverProviderRegistration) {
            this.hoverProviderRegistration = vscode.languages.registerHoverProvider(PYTHON, this);
        }
    }

    private getVariableHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | null> {
        // Make sure to fail as soon as the cancel token is signaled
        return Cancellation.race(async (t) => {
            const range = document.getWordRangeAtPosition(position);
            if (range) {
                const word = document.getText(range);
                if (word) {
                    // See if we have any matching notebooks
                    const notebooks = this.getMatchingNotebooks(document);
                    if (notebooks && notebooks.length) {
                        // Just use the first one to reply if more than one.
                        const attributes = await Promise.race(
                            // Note, getVariableProperties is non null here because we are specifically
                            // injecting kernelVariables, which does define this interface method
                            notebooks.map((n) => this.variableProvider.getVariableProperties!(word, n, t))
                        );
                        const entries = Object.entries(attributes);
                        if (entries.length > 0) {
                            const asMarkdown =
                                entries.reduce((accum, entry) => accum + `${entry[0]}: ${entry[1]}\n`, '```\n') + '```';
                            const result = {
                                contents: [new vscode.MarkdownString(asMarkdown)]
                            };
                            return result;
                        }
                    }
                }
            }
            return null;
        }, token);
    }

    private getMatchingNotebooks(document: vscode.TextDocument): INotebook[] {
        // First see if we have an interactive window who's owner is this document
        let result = this.interactiveProvider.windows
            .filter((w) => w.notebook && w.owner && this.fs.arePathsSame(w.owner, document.uri))
            .map((w) => w.notebook!);
        if (!result || result.length === 0) {
            // Not a match on the owner, find all that were submitters? Might be a bit risky
            result = this.interactiveProvider.windows
                .filter((w) => w.notebook && w.submitters.find((s) => this.fs.arePathsSame(s, document.uri)))
                .map((w) => w.notebook!);
        }
        return result;
    }
}
