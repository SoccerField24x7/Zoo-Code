import * as vscode from "vscode"

import {
	isZooRemoteControlEligible,
	projectClineMessageForRemote,
	projectClineMessagesForSnapshot,
	ZooRemoteControlClient,
	type ZooRemoteCommand,
	type ZooRemoteEvent,
} from "@roo-code/core"
import {
	providerIdentifiers,
	RooCodeEventName,
	type ClineMessage,
	type ProviderSettings,
	type RooCodeAPI,
} from "@roo-code/types"

import type { ClineProvider } from "../../core/webview/ClineProvider"
import type { Mode } from "../../shared/modes"
import { Package } from "../../shared/package"
import { getCachedZooCodeToken, getZooCodeBaseUrl } from "../zoo-code-auth"

const PRESENCE_INTERVAL_MS = 15_000
const COMMAND_POLL_INTERVAL_MS = 2_000
const EVENT_FLUSH_INTERVAL_MS = 100
const PARTIAL_EVENT_MIN_INTERVAL_MS = 75
const UNAVAILABLE_BACKOFF_MS = 60_000
const NOT_ELIGIBLE_BACKOFF_MS = 30_000
const INSTANCE_ID_STATE_KEY = "zooRemoteControl.instanceId"
const EVENT_SEQ_STATE_KEY = "zooRemoteControl.eventSeq"

export type ZooRemoteControlBridgeDeps = {
	api: Pick<RooCodeAPI, "on" | "off" | "sendMessage" | "cancelCurrentTask" | "resumeTask" | "startNewTask">
	provider: ClineProvider
	context: vscode.ExtensionContext
	log?: (message: string) => void
	client?: ZooRemoteControlClient
	now?: () => number
}

/** Publishes task UI events to Zoo and applies inbound remote commands when eligible. */
export class ZooRemoteControlBridge implements vscode.Disposable {
	private readonly api: ZooRemoteControlBridgeDeps["api"]
	private readonly provider: ClineProvider
	private readonly context: vscode.ExtensionContext
	private readonly log: (message: string) => void
	private readonly client: ZooRemoteControlClient
	private readonly now: () => number
	private readonly instanceId: string

	private disposed = false
	private active = false
	private serverAvailable = true
	private unavailableUntil = 0
	private eventSeq: number
	private pendingEvents: ZooRemoteEvent[] = []
	private lastPartialFlushAt = 0
	private pendingPartials = new Map<string, { taskId: string; action?: string; message: ClineMessage }>()

	private presenceTimer: ReturnType<typeof setInterval> | undefined
	private commandTimer: ReturnType<typeof setInterval> | undefined
	private flushTimer: ReturnType<typeof setInterval> | undefined
	private readonly disposables: vscode.Disposable[] = []

	private readonly onMessage = (payload: { taskId: string; action?: string; message: ClineMessage }) => {
		void this.handleMessageEvent(payload)
	}

	private readonly onTaskInteractive = (taskId: string) => {
		this.enqueueEvent({ type: "task_interactive", taskId, timestamp: this.now() })
	}

	private readonly onTaskIdle = (taskId: string) => {
		this.enqueueEvent({ type: "task_idle", taskId, timestamp: this.now() })
	}

	private readonly onTaskResumable = (taskId: string) => {
		this.enqueueEvent({ type: "task_resumable", taskId, timestamp: this.now() })
	}

	private readonly onTaskCompleted = (taskId: string) => {
		this.enqueueEvent({ type: "task_completed", taskId, timestamp: this.now() })
	}

	private readonly onTaskAborted = (taskId: string) => {
		this.enqueueEvent({ type: "task_aborted", taskId, timestamp: this.now() })
	}

	private readonly onModeSwitched = (taskId: string, mode: string) => {
		this.enqueueEvent({ type: "mode_switched", taskId, mode, timestamp: this.now() })
	}

	private readonly onProviderProfileChanged = () => {
		void this.syncActiveState()
	}

	constructor(deps: ZooRemoteControlBridgeDeps) {
		this.api = deps.api
		this.provider = deps.provider
		this.context = deps.context
		this.log = deps.log ?? (() => {})
		this.now = deps.now ?? (() => Date.now())
		this.instanceId = this.resolveInstanceId()
		this.eventSeq = this.resolveEventSeq()
		this.client =
			deps.client ??
			new ZooRemoteControlClient({
				getBaseUrl: getZooCodeBaseUrl,
				getSessionToken: getCachedZooCodeToken,
				log: this.log,
			})

		if (typeof vscode.workspace.onDidChangeConfiguration === "function") {
			this.disposables.push(
				vscode.workspace.onDidChangeConfiguration((event) => {
					if (event.affectsConfiguration("zoo-code.remoteControl.enabled")) {
						void this.syncActiveState()
					}
				}),
			)
		}

		if (typeof this.provider.on === "function") {
			this.provider.on(RooCodeEventName.ProviderProfileChanged, this.onProviderProfileChanged)
		}

		if (typeof this.context.secrets?.onDidChange === "function") {
			this.disposables.push(
				this.context.secrets.onDidChange((event) => {
					if (event.key === "zoo-code-session-token") {
						void this.syncActiveState()
					}
				}),
			)
		}

		void this.syncActiveState()
	}

	public dispose(): void {
		this.disposed = true
		void this.deactivate({ notifyOffline: true })
		if (typeof this.provider.off === "function") {
			this.provider.off(RooCodeEventName.ProviderProfileChanged, this.onProviderProfileChanged)
		}
		for (const disposable of this.disposables) {
			disposable.dispose()
		}
		this.disposables.length = 0
	}

	/** Test helper */
	public isActive(): boolean {
		return this.active
	}

	/** Test helper */
	public getInstanceId(): string {
		return this.instanceId
	}

	private resolveInstanceId(): string {
		const existing = this.context.globalState.get<string>(INSTANCE_ID_STATE_KEY)
		if (existing) {
			return existing
		}

		const generated =
			typeof vscode.env.sessionId === "string" && vscode.env.sessionId.length > 0
				? vscode.env.sessionId
				: `zoo-${this.now()}-${Math.random().toString(36).slice(2, 10)}`

		void this.context.globalState.update(INSTANCE_ID_STATE_KEY, generated)
		return generated
	}

	private resolveEventSeq(): number {
		const existing = this.context.globalState.get<number>(EVENT_SEQ_STATE_KEY)
		return typeof existing === "number" && Number.isFinite(existing) && existing >= 0 ? existing : 0
	}

	private persistEventSeq(): void {
		void this.context.globalState.update(EVENT_SEQ_STATE_KEY, this.eventSeq)
	}

	private isSettingEnabled(): boolean {
		return vscode.workspace.getConfiguration(Package.name).get<boolean>("remoteControl.enabled", false) === true
	}

	private getApiProvider(): string | undefined {
		try {
			const getSettings = this.provider.contextProxy?.getProviderSettings
			if (typeof getSettings !== "function") {
				return undefined
			}
			const settings: ProviderSettings = getSettings.call(this.provider.contextProxy)
			return settings?.apiProvider
		} catch {
			return undefined
		}
	}

	private evaluateEligible(): boolean {
		return isZooRemoteControlEligible({
			remoteControlEnabled: this.isSettingEnabled(),
			apiProvider: this.getApiProvider(),
			sessionToken: getCachedZooCodeToken() || undefined,
		})
	}

	private async syncActiveState(): Promise<void> {
		if (this.disposed) {
			return
		}

		try {
			const eligible = this.evaluateEligible()
			if (eligible && !this.active) {
				await this.activate()
			} else if (!eligible && this.active) {
				await this.deactivate({ notifyOffline: true })
			} else if (eligible && this.active) {
				await this.publishPresence(true)
			}
		} catch (error) {
			this.log(`[ZooRemoteControl] sync failed: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	private async activate(): Promise<void> {
		if (this.active || this.disposed) {
			return
		}

		this.active = true
		this.serverAvailable = true
		this.unavailableUntil = 0
		this.bindApiListeners(true)
		this.presenceTimer = setInterval(() => {
			void this.publishPresence(true)
		}, PRESENCE_INTERVAL_MS)
		this.commandTimer = setInterval(() => {
			void this.pollCommands()
		}, COMMAND_POLL_INTERVAL_MS)
		this.flushTimer = setInterval(() => {
			void this.flushEvents()
		}, EVENT_FLUSH_INTERVAL_MS)

		this.log("[ZooRemoteControl] enabled")
		await this.publishPresence(true)
		await this.publishSnapshot()
	}

	private async deactivate({ notifyOffline }: { notifyOffline: boolean }): Promise<void> {
		if (!this.active && !notifyOffline) {
			this.clearTimers()
			this.bindApiListeners(false)
			return
		}

		this.active = false
		this.clearTimers()
		this.bindApiListeners(false)
		this.pendingEvents = []
		this.pendingPartials.clear()

		if (notifyOffline) {
			// Always try offline presence while a session token remains (even if provider changed).
			await this.publishPresence(false, { force: true })
		}

		this.log("[ZooRemoteControl] disabled")
	}

	private clearTimers(): void {
		if (this.presenceTimer) {
			clearInterval(this.presenceTimer)
			this.presenceTimer = undefined
		}
		if (this.commandTimer) {
			clearInterval(this.commandTimer)
			this.commandTimer = undefined
		}
		if (this.flushTimer) {
			clearInterval(this.flushTimer)
			this.flushTimer = undefined
		}
	}

	private bindApiListeners(bind: boolean): void {
		const method = bind ? "on" : "off"
		this.api[method](RooCodeEventName.Message, this.onMessage)
		this.api[method](RooCodeEventName.TaskInteractive, this.onTaskInteractive)
		this.api[method](RooCodeEventName.TaskIdle, this.onTaskIdle)
		this.api[method](RooCodeEventName.TaskResumable, this.onTaskResumable)
		this.api[method](RooCodeEventName.TaskCompleted, this.onTaskCompleted)
		this.api[method](RooCodeEventName.TaskAborted, this.onTaskAborted)
		this.api[method](RooCodeEventName.TaskModeSwitched, this.onModeSwitched)
	}

	private messageKey(taskId: string, message: ClineMessage): string {
		return message.messageId ?? `${taskId}:${message.ts}`
	}

	private async handleMessageEvent(payload: {
		taskId: string
		action?: string
		message: ClineMessage
	}): Promise<void> {
		if (!this.active) {
			return
		}

		const shaped = {
			taskId: payload.taskId,
			action: payload.action,
			message: projectClineMessageForRemote(payload.message),
		}

		const isPartial = shaped.message.partial === true
		if (isPartial) {
			this.pendingPartials.set(this.messageKey(shaped.taskId, shaped.message), shaped)
			const elapsed = this.now() - this.lastPartialFlushAt
			if (elapsed < PARTIAL_EVENT_MIN_INTERVAL_MS) {
				return
			}
			this.flushPendingPartials()
			return
		}

		this.pendingPartials.delete(this.messageKey(shaped.taskId, shaped.message))
		this.enqueueMessageEvent(shaped)
	}

	private flushPendingPartials(): void {
		if (this.pendingPartials.size === 0) {
			return
		}
		this.lastPartialFlushAt = this.now()
		for (const shaped of this.pendingPartials.values()) {
			this.enqueueMessageEvent(shaped)
		}
		this.pendingPartials.clear()
	}

	private enqueueMessageEvent(shaped: { taskId: string; action?: string; message: ClineMessage }): void {
		const action =
			shaped.action === "created" || shaped.action === "updated"
				? shaped.action
				: shaped.message.partial
					? "updated"
					: "created"

		this.enqueueEvent({
			type: "message",
			taskId: shaped.taskId,
			action,
			message: shaped.message,
			timestamp: this.now(),
		})
	}

	private enqueueEvent(event: Omit<ZooRemoteEvent, "seq">): void {
		if (!this.active) {
			return
		}

		this.pendingEvents.push({ ...event, seq: this.eventSeq++ })
		this.persistEventSeq()
	}

	private markUnavailable(): void {
		this.serverAvailable = false
		this.unavailableUntil = this.now() + UNAVAILABLE_BACKOFF_MS
	}

	private markNotEligibleBackoff(): void {
		this.serverAvailable = false
		this.unavailableUntil = this.now() + NOT_ELIGIBLE_BACKOFF_MS
	}

	private canCallServer(): boolean {
		if (this.serverAvailable) {
			return true
		}
		return this.now() >= this.unavailableUntil
	}

	private async publishPresence(online: boolean, options?: { force?: boolean }): Promise<void> {
		if (!options?.force && !this.canCallServer() && online) {
			return
		}
		if (!getCachedZooCodeToken()) {
			return
		}

		const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		const taskId = this.provider.getCurrentTask()?.taskId
		const result = await this.client.postPresence({
			instanceId: this.instanceId,
			apiProvider: this.getApiProvider() ?? providerIdentifiers.zooGateway,
			workspacePath,
			taskId,
			online,
			editorName: vscode.env.appName,
			extensionVersion: Package.version,
		})

		if (result.status === 401 || result.status === 402 || result.status === 403) {
			this.markNotEligibleBackoff()
			if (this.active) {
				await this.deactivate({ notifyOffline: false })
			}
			return
		}

		if (result.status === 404) {
			this.markUnavailable()
			return
		}

		if (result.ok) {
			this.serverAvailable = true
		}
	}

	private async publishSnapshot(): Promise<void> {
		if (!this.active || !this.canCallServer()) {
			return
		}

		const task = this.provider.getCurrentTask()
		if (!task?.taskId || !Array.isArray(task.clineMessages)) {
			return
		}

		let mode: string | undefined
		try {
			mode = task.taskMode
		} catch {
			mode = undefined
		}

		const result = await this.client.postSnapshot({
			instanceId: this.instanceId,
			taskId: task.taskId,
			messages: projectClineMessagesForSnapshot(task.clineMessages),
			mode,
		})

		if (result.status === 401 || result.status === 402 || result.status === 403) {
			this.markNotEligibleBackoff()
			return
		}

		if (result.status === 404) {
			this.markUnavailable()
			return
		}

		if (result.ok) {
			this.serverAvailable = true
		}
	}

	private async flushEvents(): Promise<void> {
		if (!this.active || !this.canCallServer()) {
			return
		}

		this.flushPendingPartials()
		if (this.pendingEvents.length === 0) {
			return
		}

		const batch = this.pendingEvents.splice(0, this.pendingEvents.length)
		const result = await this.client.postEvents(this.instanceId, batch)

		if (result.status === 401 || result.status === 402 || result.status === 403) {
			this.markNotEligibleBackoff()
			this.pendingEvents = [...batch.slice(-50), ...this.pendingEvents].slice(0, 200)
			return
		}

		if (result.status === 404) {
			this.markUnavailable()
			// Drop batch while the public endpoint is not available yet.
			return
		}

		if (!result.ok) {
			this.pendingEvents = [...batch.slice(-50), ...this.pendingEvents].slice(0, 200)
			return
		}

		this.serverAvailable = true
	}

	private async pollCommands(): Promise<void> {
		if (!this.active || !this.canCallServer()) {
			return
		}

		if (!this.evaluateEligible()) {
			await this.deactivate({ notifyOffline: true })
			return
		}

		const result = await this.client.getCommands(this.instanceId)

		if (result.status === 401 || result.status === 402 || result.status === 403) {
			this.markNotEligibleBackoff()
			await this.deactivate({ notifyOffline: false })
			return
		}

		if (result.status === 404) {
			this.markUnavailable()
			return
		}

		if (!result.ok || !result.body) {
			return
		}

		this.serverAvailable = true

		for (const command of result.body.commands) {
			await this.executeCommand(command)
		}
	}

	private async executeCommand(command: ZooRemoteCommand): Promise<void> {
		if (!this.evaluateEligible()) {
			await this.client.ackCommand({
				commandId: command.commandId,
				status: "failed",
				errorCode: "not_eligible",
			})
			return
		}

		try {
			switch (command.type) {
				case "message":
				case "answer_followup":
					await this.api.sendMessage(command.payload?.text, command.payload?.images)
					if (command.payload?.mode) {
						await this.provider.handleModeSwitch(command.payload.mode as Mode)
					}
					break
				case "approve_ask": {
					const task = this.provider.getCurrentTask()
					if (!task) {
						await this.client.ackCommand({
							commandId: command.commandId,
							status: "failed",
							errorCode: "no_current_task",
						})
						return
					}
					task.approveAsk({ text: command.payload?.text, images: command.payload?.images })
					break
				}
				case "deny_ask": {
					const task = this.provider.getCurrentTask()
					if (!task) {
						await this.client.ackCommand({
							commandId: command.commandId,
							status: "failed",
							errorCode: "no_current_task",
						})
						return
					}
					task.denyAsk({ text: command.payload?.text, images: command.payload?.images })
					break
				}
				case "cancel_task":
					await this.api.cancelCurrentTask()
					break
				case "resume_task":
					if (!command.taskId) {
						await this.client.ackCommand({
							commandId: command.commandId,
							status: "failed",
							errorCode: "missing_task_id",
						})
						return
					}
					await this.api.resumeTask(command.taskId)
					break
				case "start_task":
					await this.api.startNewTask({
						text: command.payload?.text,
						images: command.payload?.images,
					})
					break
				case "switch_mode": {
					const mode = command.payload?.mode
					if (!mode) {
						await this.client.ackCommand({
							commandId: command.commandId,
							status: "failed",
							errorCode: "missing_mode",
						})
						return
					}
					await this.provider.handleModeSwitch(mode as Mode)
					break
				}
				default: {
					const _exhaustive: never = command.type
					await this.client.ackCommand({
						commandId: command.commandId,
						status: "failed",
						errorCode: "unknown_command",
						message: String(_exhaustive),
					})
					return
				}
			}

			// Ack 404 (command_not_found) must not mark the bridge unavailable.
			await this.client.ackCommand({ commandId: command.commandId, status: "acked" })
		} catch (error) {
			await this.client.ackCommand({
				commandId: command.commandId,
				status: "failed",
				errorCode: "execution_failed",
				message: error instanceof Error ? error.message : String(error),
			})
		}
	}
}
