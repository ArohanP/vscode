/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from 'vs/base/common/event';
import { IProcessEnvironment, isMacintosh, isWindows, OperatingSystem } from 'vs/base/common/platform';
import { withNullAsUndefined } from 'vs/base/common/types';
import { URI } from 'vs/base/common/uri';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ILabelService } from 'vs/platform/label/common/label';
import { ILogService } from 'vs/platform/log/common/log';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { Registry } from 'vs/platform/registry/common/platform';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { ILocalPtyService, IProcessPropertyMap, IPtyService, IShellLaunchConfig, ITerminalChildProcess, ITerminalEnvironment, ITerminalProcessOptions, ITerminalsLayoutInfo, ITerminalsLayoutInfoById, ProcessPropertyType, TerminalIpcChannels, TerminalSettingId, TitleEventSource } from 'vs/platform/terminal/common/terminal';
import { IGetTerminalLayoutInfoArgs, IProcessDetails, ISetTerminalLayoutInfoArgs } from 'vs/platform/terminal/common/terminalProcess';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { ITerminalInstanceService } from 'vs/workbench/contrib/terminal/browser/terminal';
import { ITerminalBackend, ITerminalBackendRegistry, ITerminalConfiguration, ITerminalProfileResolverService, TerminalExtensions, TERMINAL_CONFIG_SECTION } from 'vs/workbench/contrib/terminal/common/terminal';
import { TerminalStorageKeys } from 'vs/workbench/contrib/terminal/common/terminalStorageKeys';
import { LocalPty } from 'vs/workbench/contrib/terminal/electron-sandbox/localPty';
import { IConfigurationResolverService } from 'vs/workbench/services/configurationResolver/common/configurationResolver';
import { IShellEnvironmentService } from 'vs/workbench/services/environment/electron-sandbox/shellEnvironmentService';
import { IHistoryService } from 'vs/workbench/services/history/common/history';
import * as terminalEnvironment from 'vs/workbench/contrib/terminal/common/terminalEnvironment';
import { IProductService } from 'vs/platform/product/common/productService';
import { IEnvironmentVariableService } from 'vs/workbench/contrib/terminal/common/environmentVariable';
import { BaseTerminalBackend } from 'vs/workbench/contrib/terminal/browser/baseTerminalBackend';
import { getWorkspaceForTerminal } from 'vs/workbench/services/configurationResolver/common/terminalResolver';
import { INativeWorkbenchEnvironmentService } from 'vs/workbench/services/environment/electron-sandbox/environmentService';
import { Client as MessagePortClient } from 'vs/base/parts/ipc/common/ipc.mp';
import { acquirePort } from 'vs/base/parts/ipc/electron-sandbox/ipc.mp';
import { ProxyChannel } from 'vs/base/parts/ipc/common/ipc';
import { mark } from 'vs/base/common/performance';

export class LocalTerminalBackendContribution implements IWorkbenchContribution {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
		@ITerminalInstanceService terminalInstanceService: ITerminalInstanceService
	) {
		mark('code/willConnectPtyHost');
		logService.trace('Renderer->PtyHost#connect: before acquirePort');
		acquirePort('vscode:createPtyHostMessageChannel', 'vscode:createPtyHostMessageChannelResult').then(port => {
			mark('code/didConnectPtyHost');
			logService.trace('Renderer->PtyHost#connect: connection established');

			const backend = instantiationService.createInstance(LocalTerminalBackend, port);
			Registry.as<ITerminalBackendRegistry>(TerminalExtensions.Backend).registerTerminalBackend(backend);
			terminalInstanceService.didRegisterBackend(backend.remoteAuthority);
		});
	}
}

class LocalTerminalBackend extends BaseTerminalBackend implements ITerminalBackend {
	readonly remoteAuthority = undefined;

	private readonly _ptys: Map<number, LocalPty> = new Map();

	private _ptyHostDirectProxy: IPtyService;

	private readonly _onDidRequestDetach = this._register(new Emitter<{ requestId: number; workspaceId: string; instanceId: number }>());
	readonly onDidRequestDetach = this._onDidRequestDetach.event;

	constructor(
		port: MessagePort,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ILogService logService: ILogService,
		@ILocalPtyService private readonly _localPtyService: ILocalPtyService,
		@ILabelService private readonly _labelService: ILabelService,
		@IShellEnvironmentService private readonly _shellEnvironmentService: IShellEnvironmentService,
		@IStorageService private readonly _storageService: IStorageService,
		@IConfigurationResolverService private readonly _configurationResolverService: IConfigurationResolverService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IProductService private readonly _productService: IProductService,
		@IHistoryService private readonly _historyService: IHistoryService,
		@ITerminalProfileResolverService private readonly _terminalProfileResolverService: ITerminalProfileResolverService,
		@IEnvironmentVariableService private readonly _environmentVariableService: IEnvironmentVariableService,
		@INotificationService notificationService: INotificationService,
		@IHistoryService historyService: IHistoryService,
		@INativeWorkbenchEnvironmentService private readonly _environmentService: INativeWorkbenchEnvironmentService
	) {
		super(_localPtyService, logService, notificationService, historyService, _configurationResolverService, workspaceContextService);

		// There are two connections to the pty host; one to the regular shared process
		// _localPtyService, and one directly via message port _ptyHostDirectProxy. The former is
		// used for pty host management messages, it would make sense in the future to use a
		// separate interface/service for this one.
		const client = new MessagePortClient(port, `window:${this._environmentService.window.id}`);
		this._ptyHostDirectProxy = ProxyChannel.toService<IPtyService>(client.getChannel(TerminalIpcChannels.PtyHostWindow));

		// Attach process listeners
		this._ptyHostDirectProxy.onProcessData(e => this._ptys.get(e.id)?.handleData(e.event));
		this._ptyHostDirectProxy.onDidChangeProperty(e => this._ptys.get(e.id)?.handleDidChangeProperty(e.property));
		this._ptyHostDirectProxy.onProcessExit(e => {
			const pty = this._ptys.get(e.id);
			if (pty) {
				pty.handleExit(e.event);
				this._ptys.delete(e.id);
			}
		});
		this._ptyHostDirectProxy.onProcessReady(e => this._ptys.get(e.id)?.handleReady(e.event));
		this._ptyHostDirectProxy.onProcessReplay(e => this._ptys.get(e.id)?.handleReplay(e.event));
		this._ptyHostDirectProxy.onProcessOrphanQuestion(e => this._ptys.get(e.id)?.handleOrphanQuestion());
		this._ptyHostDirectProxy.onDidRequestDetach(e => this._onDidRequestDetach.fire(e));

		// Listen for config changes
		const initialConfig = this._configurationService.getValue<ITerminalConfiguration>(TERMINAL_CONFIG_SECTION);
		for (const match of Object.keys(initialConfig.autoReplies)) {
			// Ensure the reply is value
			const reply = initialConfig.autoReplies[match] as string | null;
			if (reply) {
				this._ptyHostDirectProxy.installAutoReply(match, reply);
			}
		}
		// TODO: Could simplify update to a single call
		this._register(this._configurationService.onDidChangeConfiguration(async e => {
			if (e.affectsConfiguration(TerminalSettingId.AutoReplies)) {
				this._ptyHostDirectProxy.uninstallAllAutoReplies();
				const config = this._configurationService.getValue<ITerminalConfiguration>(TERMINAL_CONFIG_SECTION);
				for (const match of Object.keys(config.autoReplies)) {
					// Ensure the reply is value
					const reply = config.autoReplies[match] as string | null;
					if (reply) {
						await this._ptyHostDirectProxy.installAutoReply(match, reply);
					}
				}
			}
		}));
	}

	async requestDetachInstance(workspaceId: string, instanceId: number): Promise<IProcessDetails | undefined> {
		return this._ptyHostDirectProxy.requestDetachInstance(workspaceId, instanceId);
	}

	async acceptDetachInstanceReply(requestId: number, persistentProcessId?: number): Promise<void> {
		if (!persistentProcessId) {
			this._logService.warn('Cannot attach to feature terminals, custom pty terminals, or those without a persistentProcessId');
			return;
		}
		return this._ptyHostDirectProxy.acceptDetachInstanceReply(requestId, persistentProcessId);
	}

	async persistTerminalState(): Promise<void> {
		const ids = Array.from(this._ptys.keys());
		const serialized = await this._ptyHostDirectProxy.serializeTerminalState(ids);
		this._storageService.store(TerminalStorageKeys.TerminalBufferState, serialized, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	async updateTitle(id: number, title: string, titleSource: TitleEventSource): Promise<void> {
		await this._ptyHostDirectProxy.updateTitle(id, title, titleSource);
	}

	async updateIcon(id: number, userInitiated: boolean, icon: URI | { light: URI; dark: URI } | { id: string; color?: { id: string } }, color?: string): Promise<void> {
		await this._ptyHostDirectProxy.updateIcon(id, userInitiated, icon, color);
	}

	updateProperty<T extends ProcessPropertyType>(id: number, property: ProcessPropertyType, value: IProcessPropertyMap[T]): Promise<void> {
		return this._ptyHostDirectProxy.updateProperty(id, property, value);
	}

	async createProcess(
		shellLaunchConfig: IShellLaunchConfig,
		cwd: string,
		cols: number,
		rows: number,
		unicodeVersion: '6' | '11',
		env: IProcessEnvironment,
		options: ITerminalProcessOptions,
		shouldPersist: boolean
	): Promise<ITerminalChildProcess> {
		const executableEnv = await this._shellEnvironmentService.getShellEnv();
		const id = await this._ptyHostDirectProxy.createProcess(shellLaunchConfig, cwd, cols, rows, unicodeVersion, env, executableEnv, options, shouldPersist, this._getWorkspaceId(), this._getWorkspaceName());
		const pty = this._instantiationService.createInstance(LocalPty, id, shouldPersist);
		this._ptys.set(id, pty);
		return pty;
	}

	async attachToProcess(id: number): Promise<ITerminalChildProcess | undefined> {
		try {
			await this._ptyHostDirectProxy.attachToProcess(id);
			const pty = this._instantiationService.createInstance(LocalPty, id, true);
			this._ptys.set(id, pty);
			return pty;
		} catch (e) {
			this._logService.warn(`Couldn't attach to process ${e.message}`);
		}
		return undefined;
	}

	async attachToRevivedProcess(id: number): Promise<ITerminalChildProcess | undefined> {
		try {
			const newId = await this._ptyHostDirectProxy.getRevivedPtyNewId(id) ?? id;
			return await this.attachToProcess(newId);
		} catch (e) {
			this._logService.warn(`Couldn't attach to process ${e.message}`);
		}
		return undefined;
	}

	async listProcesses(): Promise<IProcessDetails[]> {
		return this._ptyHostDirectProxy.listProcesses();
	}

	async reduceConnectionGraceTime(): Promise<void> {
		this._ptyHostDirectProxy.reduceConnectionGraceTime();
	}

	async getDefaultSystemShell(osOverride?: OperatingSystem): Promise<string> {
		return this._ptyHostDirectProxy.getDefaultSystemShell(osOverride);
	}

	async getProfiles(profiles: unknown, defaultProfile: unknown, includeDetectedProfiles?: boolean) {
		// TODO: Differentiate interfaces of direct to pty host and pty host service (or just move them all to pty host)
		return this._localPtyService.getProfiles?.(this._workspaceContextService.getWorkspace().id, profiles, defaultProfile, includeDetectedProfiles) || [];
	}

	async getEnvironment(): Promise<IProcessEnvironment> {
		return this._ptyHostDirectProxy.getEnvironment();
	}

	async getShellEnvironment(): Promise<IProcessEnvironment> {
		return this._shellEnvironmentService.getShellEnv();
	}

	async getWslPath(original: string, direction: 'unix-to-win' | 'win-to-unix'): Promise<string> {
		return this._ptyHostDirectProxy.getWslPath(original, direction);
	}

	async setTerminalLayoutInfo(layoutInfo?: ITerminalsLayoutInfoById): Promise<void> {
		const args: ISetTerminalLayoutInfoArgs = {
			workspaceId: this._getWorkspaceId(),
			tabs: layoutInfo ? layoutInfo.tabs : []
		};
		await this._ptyHostDirectProxy.setTerminalLayoutInfo(args);
		// Store in the storage service as well to be used when reviving processes as normally this
		// is stored in memory on the pty host
		this._storageService.store(TerminalStorageKeys.TerminalLayoutInfo, JSON.stringify(args), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	async getTerminalLayoutInfo(): Promise<ITerminalsLayoutInfo | undefined> {
		const layoutArgs: IGetTerminalLayoutInfoArgs = {
			workspaceId: this._getWorkspaceId()
		};

		// Revive processes if needed
		const serializedState = this._storageService.get(TerminalStorageKeys.TerminalBufferState, StorageScope.WORKSPACE);
		const parsed = this._deserializeTerminalState(serializedState);
		if (parsed) {
			try {
				// Create variable resolver
				const activeWorkspaceRootUri = this._historyService.getLastActiveWorkspaceRoot();
				const lastActiveWorkspace = activeWorkspaceRootUri ? withNullAsUndefined(this._workspaceContextService.getWorkspaceFolder(activeWorkspaceRootUri)) : undefined;
				const variableResolver = terminalEnvironment.createVariableResolver(lastActiveWorkspace, await this._terminalProfileResolverService.getEnvironment(this.remoteAuthority), this._configurationResolverService);

				// Re-resolve the environments and replace it on the state so local terminals use a fresh
				// environment
				for (const state of parsed) {
					const freshEnv = await this._resolveEnvironmentForRevive(variableResolver, state.shellLaunchConfig);
					state.processLaunchConfig.env = freshEnv;
				}

				await this._localPtyService.reviveTerminalProcesses(parsed, Intl.DateTimeFormat().resolvedOptions().locale);
				this._storageService.remove(TerminalStorageKeys.TerminalBufferState, StorageScope.WORKSPACE);
				// If reviving processes, send the terminal layout info back to the pty host as it
				// will not have been persisted on application exit
				const layoutInfo = this._storageService.get(TerminalStorageKeys.TerminalLayoutInfo, StorageScope.WORKSPACE);
				if (layoutInfo) {
					await this._localPtyService.setTerminalLayoutInfo(JSON.parse(layoutInfo));
					this._storageService.remove(TerminalStorageKeys.TerminalLayoutInfo, StorageScope.WORKSPACE);
				}
			} catch {
				// no-op
			}
		}

		return this._localPtyService.getTerminalLayoutInfo(layoutArgs);
	}

	private async _resolveEnvironmentForRevive(variableResolver: terminalEnvironment.VariableResolver | undefined, shellLaunchConfig: IShellLaunchConfig): Promise<IProcessEnvironment> {
		const platformKey = isWindows ? 'windows' : (isMacintosh ? 'osx' : 'linux');
		const envFromConfigValue = this._configurationService.getValue<ITerminalEnvironment | undefined>(`terminal.integrated.env.${platformKey}`);
		const baseEnv = await (shellLaunchConfig.useShellEnvironment ? this.getShellEnvironment() : this.getEnvironment());
		const env = await terminalEnvironment.createTerminalEnvironment(shellLaunchConfig, envFromConfigValue, variableResolver, this._productService.version, this._configurationService.getValue(TerminalSettingId.DetectLocale), baseEnv);
		if (!shellLaunchConfig.strictEnv && !shellLaunchConfig.hideFromUser) {
			const workspaceFolder = getWorkspaceForTerminal(shellLaunchConfig.cwd, this._workspaceContextService, this._historyService);
			await this._environmentVariableService.mergedCollection.applyToProcessEnvironment(env, { workspaceFolder }, variableResolver);
		}
		return env;
	}

	private _getWorkspaceId(): string {
		return this._workspaceContextService.getWorkspace().id;
	}

	private _getWorkspaceName(): string {
		return this._labelService.getWorkspaceLabel(this._workspaceContextService.getWorkspace());
	}
}
