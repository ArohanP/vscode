/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from 'vs/base/common/async';
import { Emitter, Event } from 'vs/base/common/event';
import { IMarkdownString, MarkdownString } from 'vs/base/common/htmlContent';
import { Disposable } from 'vs/base/common/lifecycle';
import { URI, UriComponents } from 'vs/base/common/uri';
import { generateUuid } from 'vs/base/common/uuid';
import { ILogService } from 'vs/platform/log/common/log';
import { IChatProgress, IChatResponse, IChatResponseErrorDetails, IChat, IChatFollowup, IChatReplyFollowup, InteractiveSessionVoteDirection } from 'vs/workbench/contrib/chat/common/chatService';

export interface IInteractiveRequestModel {
	readonly id: string;
	readonly username: string;
	readonly avatarIconUri?: URI;
	readonly session: IChatModel;
	readonly message: string | IChatReplyFollowup;
	readonly response: IInteractiveResponseModel | undefined;
}

export interface IInteractiveResponseModel {
	readonly onDidChange: Event<void>;
	readonly id: string;
	readonly providerId: string;
	readonly providerResponseId: string | undefined;
	readonly username: string;
	readonly avatarIconUri?: URI;
	readonly session: IChatModel;
	readonly response: IMarkdownString;
	readonly isComplete: boolean;
	readonly isCanceled: boolean;
	readonly vote: InteractiveSessionVoteDirection | undefined;
	readonly followups?: IChatFollowup[] | undefined;
	readonly errorDetails?: IChatResponseErrorDetails;
	setVote(vote: InteractiveSessionVoteDirection): void;
}

export function isRequest(item: unknown): item is IInteractiveRequestModel {
	return !!item && typeof (item as IInteractiveRequestModel).message !== 'undefined';
}

export function isResponse(item: unknown): item is IInteractiveResponseModel {
	return !isRequest(item);
}

export class InteractiveRequestModel implements IInteractiveRequestModel {
	private static nextId = 0;

	public response: InteractiveResponseModel | undefined;

	private _id: string;
	public get id(): string {
		return this._id;
	}

	public get username(): string {
		return this.session.requesterUsername;
	}

	public get avatarIconUri(): URI | undefined {
		return this.session.requesterAvatarIconUri;
	}

	constructor(
		public readonly session: ChatModel,
		public readonly message: string | IChatReplyFollowup) {
		this._id = 'request_' + InteractiveRequestModel.nextId++;
	}
}

export class InteractiveResponseModel extends Disposable implements IInteractiveResponseModel {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private static nextId = 0;

	private _id: string;
	public get id(): string {
		return this._id;
	}

	public get providerResponseId(): string | undefined {
		return this._providerResponseId;
	}

	public get isComplete(): boolean {
		return this._isComplete;
	}

	public get isCanceled(): boolean {
		return this._isCanceled;
	}

	public get vote(): InteractiveSessionVoteDirection | undefined {
		return this._vote;
	}

	public get followups(): IChatFollowup[] | undefined {
		return this._followups;
	}

	public get response(): IMarkdownString {
		return this._response;
	}

	public get errorDetails(): IChatResponseErrorDetails | undefined {
		return this._errorDetails;
	}

	public get providerId(): string {
		return this.session.providerId;
	}

	public get username(): string {
		return this.session.responderUsername;
	}

	public get avatarIconUri(): URI | undefined {
		return this.session.responderAvatarIconUri;
	}

	constructor(
		private _response: IMarkdownString,
		public readonly session: ChatModel,
		private _isComplete: boolean = false,
		private _isCanceled = false,
		private _vote?: InteractiveSessionVoteDirection,
		private _providerResponseId?: string,
		private _errorDetails?: IChatResponseErrorDetails,
		private _followups?: IChatFollowup[]
	) {
		super();
		this._id = 'response_' + InteractiveResponseModel.nextId++;
	}

	updateContent(responsePart: string) {
		this._response = new MarkdownString(this.response.value + responsePart);
		this._onDidChange.fire();
	}

	setProviderResponseId(providerResponseId: string) {
		this._providerResponseId = providerResponseId;
	}

	complete(errorDetails?: IChatResponseErrorDetails): void {
		this._isComplete = true;
		this._errorDetails = errorDetails;
		this._onDidChange.fire();
	}

	cancel(): void {
		this._isComplete = true;
		this._isCanceled = true;
		this._onDidChange.fire();
	}

	setFollowups(followups: IChatFollowup[] | undefined): void {
		this._followups = followups;
		this._onDidChange.fire(); // Fire so that command followups get rendered on the row
	}

	setVote(vote: InteractiveSessionVoteDirection): void {
		this._vote = vote;
		this._onDidChange.fire();
	}
}

export interface IChatModel {
	readonly onDidDispose: Event<void>;
	readonly onDidChange: Event<IChatChangeEvent>;
	readonly sessionId: string;
	readonly providerId: string;
	readonly isInitialized: boolean;
	// readonly title: string;
	readonly welcomeMessage: IChatWelcomeMessageModel | undefined;
	readonly requestInProgress: boolean;
	readonly inputPlaceholder?: string;
	getRequests(): IInteractiveRequestModel[];
	waitForInitialization(): Promise<void>;
	toExport(): IExportableChatData;
	toJSON(): ISerializableChatData;
}

export interface ISerializableChatsData {
	[sessionId: string]: ISerializableChatData;
}

export interface ISerializableChatRequestData {
	providerResponseId: string | undefined;
	message: string;
	response: string | undefined;
	responseErrorDetails: IChatResponseErrorDetails | undefined;
	followups: IChatFollowup[] | undefined;
	isCanceled: boolean | undefined;
	vote: InteractiveSessionVoteDirection | undefined;
}

export interface IExportableChatData {
	providerId: string;
	welcomeMessage: (string | IChatReplyFollowup[])[] | undefined;
	requests: ISerializableChatRequestData[];
	requesterUsername: string;
	responderUsername: string;
	requesterAvatarIconUri: UriComponents | undefined;
	responderAvatarIconUri: UriComponents | undefined;
	providerState: any;
}

export interface ISerializableChatData extends IExportableChatData {
	sessionId: string;
	creationDate: number;
}

export function isExportableSessionData(obj: unknown): obj is IExportableChatData {
	const data = obj as IExportableChatData;
	return typeof data === 'object' &&
		typeof data.providerId === 'string' &&
		typeof data.requesterUsername === 'string' &&
		typeof data.responderUsername === 'string';
}

export function isSerializableSessionData(obj: unknown): obj is ISerializableChatData {
	const data = obj as ISerializableChatData;
	return isExportableSessionData(obj) &&
		typeof data.creationDate === 'number' &&
		typeof data.sessionId === 'string';
}

export type IChatChangeEvent = IChatAddRequestEvent | IChatAddResponseEvent | IChatInitEvent;

export interface IChatAddRequestEvent {
	kind: 'addRequest';
	request: IInteractiveRequestModel;
}

export interface IChatAddResponseEvent {
	kind: 'addResponse';
	response: IInteractiveResponseModel;
}

export interface IChatInitEvent {
	kind: 'initialize';
}

export class ChatModel extends Disposable implements IChatModel {
	private readonly _onDidDispose = this._register(new Emitter<void>());
	readonly onDidDispose = this._onDidDispose.event;

	private readonly _onDidChange = this._register(new Emitter<IChatChangeEvent>());
	readonly onDidChange = this._onDidChange.event;

	private _requests: InteractiveRequestModel[];
	private _isInitializedDeferred = new DeferredPromise<void>();

	private _session: IChat | undefined;
	get session(): IChat | undefined {
		return this._session;
	}

	private _welcomeMessage: ChatWelcomeMessageModel | undefined;
	get welcomeMessage(): ChatWelcomeMessageModel | undefined {
		return this._welcomeMessage;
	}

	private _providerState: any;
	get providerState(): any {
		return this._providerState;
	}

	// TODO to be clear, this is not the same as the id from the session object, which belongs to the provider.
	// It's easier to be able to identify this model before its async initialization is complete
	private _sessionId: string;
	get sessionId(): string {
		return this._sessionId;
	}

	get inputPlaceholder(): string | undefined {
		return this._session?.inputPlaceholder;
	}

	get requestInProgress(): boolean {
		const lastRequest = this._requests[this._requests.length - 1];
		return !!lastRequest && !!lastRequest.response && !lastRequest.response.isComplete;
	}

	private _creationDate: number;
	get creationDate(): number {
		return this._creationDate;
	}

	get requesterUsername(): string {
		return this._session?.requesterUsername ?? this.initialData?.requesterUsername ?? '';
	}

	get responderUsername(): string {
		return this._session?.responderUsername ?? this.initialData?.responderUsername ?? '';
	}

	private readonly _initialRequesterAvatarIconUri: URI | undefined;
	get requesterAvatarIconUri(): URI | undefined {
		return this._session?.requesterAvatarIconUri ?? this._initialRequesterAvatarIconUri;
	}

	private readonly _initialResponderAvatarIconUri: URI | undefined;
	get responderAvatarIconUri(): URI | undefined {
		return this._session?.responderAvatarIconUri ?? this._initialResponderAvatarIconUri;
	}

	get isInitialized(): boolean {
		return this._isInitializedDeferred.isSettled;
	}

	constructor(
		public readonly providerId: string,
		private readonly initialData: ISerializableChatData | undefined,
		@ILogService private readonly logService: ILogService
	) {
		super();
		this._sessionId = initialData?.sessionId ?? generateUuid();
		this._requests = initialData ? this._deserialize(initialData) : [];
		this._providerState = initialData ? initialData.providerState : undefined;
		this._creationDate = initialData?.creationDate ?? Date.now();

		this._initialRequesterAvatarIconUri = initialData?.requesterAvatarIconUri && URI.revive(initialData.requesterAvatarIconUri);
		this._initialResponderAvatarIconUri = initialData?.responderAvatarIconUri && URI.revive(initialData.responderAvatarIconUri);
	}

	private _deserialize(obj: ISerializableChatData): InteractiveRequestModel[] {
		const requests = obj.requests;
		if (!Array.isArray(requests)) {
			this.logService.error(`Ignoring malformed session data: ${obj}`);
			return [];
		}

		if (obj.welcomeMessage) {
			const content = obj.welcomeMessage.map(item => typeof item === 'string' ? new MarkdownString(item) : item);
			this._welcomeMessage = new ChatWelcomeMessageModel(content, obj.responderUsername, obj.responderAvatarIconUri && URI.revive(obj.responderAvatarIconUri));
		}

		return requests.map((raw: ISerializableChatRequestData) => {
			const request = new InteractiveRequestModel(this, raw.message);
			if (raw.response || raw.responseErrorDetails) {
				request.response = new InteractiveResponseModel(new MarkdownString(raw.response), this, true, raw.isCanceled, raw.vote, raw.providerResponseId, raw.responseErrorDetails, raw.followups);
			}
			return request;
		});
	}

	initialize(session: IChat, welcomeMessage: ChatWelcomeMessageModel | undefined): void {
		if (this._session || this._isInitializedDeferred.isSettled) {
			throw new Error('ChatModel is already initialized');
		}

		this._session = session;
		if (!this._welcomeMessage) {
			// Could also have loaded the welcome message from persisted data
			this._welcomeMessage = welcomeMessage;
		}

		this._isInitializedDeferred.complete();

		if (session.onDidChangeState) {
			this._register(session.onDidChangeState(state => {
				this._providerState = state;
				this.logService.trace('ChatModel#acceptNewSessionState');
			}));
		}
		this._onDidChange.fire({ kind: 'initialize' });
	}

	setInitializationError(error: Error): void {
		if (!this._isInitializedDeferred.isSettled) {
			this._isInitializedDeferred.error(error);
		}
	}

	waitForInitialization(): Promise<void> {
		return this._isInitializedDeferred.p;
	}

	getRequests(): InteractiveRequestModel[] {
		return this._requests;
	}

	addRequest(message: string | IChatReplyFollowup): InteractiveRequestModel {
		if (!this._session) {
			throw new Error('addRequest: No session');
		}

		const request = new InteractiveRequestModel(this, message);
		request.response = new InteractiveResponseModel(new MarkdownString(''), this);

		this._requests.push(request);
		this._onDidChange.fire({ kind: 'addRequest', request });
		return request;
	}

	acceptResponseProgress(request: InteractiveRequestModel, progress: IChatProgress): void {
		if (!this._session) {
			throw new Error('acceptResponseProgress: No session');
		}

		if (!request.response) {
			request.response = new InteractiveResponseModel(new MarkdownString(''), this);
		}

		if (request.response.isComplete) {
			throw new Error('acceptResponseProgress: Adding progress to a completed response');
		}

		if ('content' in progress) {
			request.response.updateContent(progress.content);
		} else {
			request.response.setProviderResponseId(progress.responseId);
		}
	}

	cancelRequest(request: InteractiveRequestModel): void {
		if (request.response) {
			request.response.cancel();
		}
	}

	completeResponse(request: InteractiveRequestModel, rawResponse: IChatResponse): void {
		if (!this._session) {
			throw new Error('completeResponse: No session');
		}

		if (!request.response) {
			request.response = new InteractiveResponseModel(new MarkdownString(''), this);
		}

		request.response.complete(rawResponse.errorDetails);
	}

	setFollowups(request: InteractiveRequestModel, followups: IChatFollowup[] | undefined): void {
		if (!request.response) {
			// Maybe something went wrong?
			return;
		}

		request.response.setFollowups(followups);
	}

	setResponse(request: InteractiveRequestModel, response: InteractiveResponseModel): void {
		request.response = response;
		this._onDidChange.fire({ kind: 'addResponse', response });
	}

	toExport(): IExportableChatData {
		return {
			requesterUsername: this._session!.requesterUsername,
			requesterAvatarIconUri: this._session!.requesterAvatarIconUri,
			responderUsername: this._session!.responderUsername,
			responderAvatarIconUri: this._session!.responderAvatarIconUri,
			welcomeMessage: this._welcomeMessage?.content.map(c => {
				if (Array.isArray(c)) {
					return c;
				} else {
					return c.value;
				}
			}),
			requests: this._requests.map((r): ISerializableChatRequestData => {
				return {
					providerResponseId: r.response?.providerResponseId,
					message: typeof r.message === 'string' ? r.message : r.message.message,
					response: r.response ? r.response.response.value : undefined,
					responseErrorDetails: r.response?.errorDetails,
					followups: r.response?.followups,
					isCanceled: r.response?.isCanceled,
					vote: r.response?.vote
				};
			}),
			providerId: this.providerId,
			providerState: this._providerState
		};
	}

	toJSON(): ISerializableChatData {
		return {
			...this.toExport(),
			sessionId: this.sessionId,
			creationDate: this._creationDate,
		};
	}

	override dispose() {
		this._session?.dispose?.();
		this._requests.forEach(r => r.response?.dispose());
		this._onDidDispose.fire();
		if (!this._isInitializedDeferred.isSettled) {
			this._isInitializedDeferred.error(new Error('model disposed before initialization'));
		}

		super.dispose();
	}
}

export type IInteractiveWelcomeMessageContent = IMarkdownString | IChatReplyFollowup[];

export interface IChatWelcomeMessageModel {
	readonly id: string;
	readonly content: IInteractiveWelcomeMessageContent[];
	readonly username: string;
	readonly avatarIconUri?: URI;

}

export class ChatWelcomeMessageModel implements IChatWelcomeMessageModel {
	private static nextId = 0;

	private _id: string;
	public get id(): string {
		return this._id;
	}

	constructor(public readonly content: IInteractiveWelcomeMessageContent[], public readonly username: string, public readonly avatarIconUri?: URI) {
		this._id = 'welcome_' + ChatWelcomeMessageModel.nextId++;
	}
}
