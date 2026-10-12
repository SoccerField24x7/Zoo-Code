import * as vscode from "vscode"

import {
	providerIdentifiers,
	RooCodeEventName,
	type ClineMessage,
	type ProviderSettings,
	type RooCodeAPI,
} from "@roo-code/types"

import type { ClineProvider } from "../../core/webview/ClineProvider"
import { Package } from "../../shared/package"
import { getCachedZooCodeToken, getZooCodeBaseUrl } from "../zoo-code-auth"
import { isZooRemoteControlEligible } from "./eligibility"
import { ZooRemoteControlClient } from "./ZooRemoteControlClient"
import type { ZooRemoteCommand, ZooRemoteEvent } from "./types"

const PRESENCE_INTERVAL_MS = 15_000
const COMMAND_POLL_INTERVAL_MS = 2_000
const EVENT_FLUSH_INTERVAL_MS = 100
const PARTIAL_EVENT_MIN_INTERVAL_MS = 75
const UNAVAILABLE_BACKOFF_MS = 60_000
const INSTANCE_ID_STATE_KEY = "zooRemoteControl.instanceId"

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
	private eventSeq = 0
	private pendingEvents: ZooRemoteEvent[] = []
	private lastPartialFlushAt = 0

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

		if (notifyOffline && this.evaluateEligibleForOfflineNotify()) {
			await this.publishPresence(false)
		}

		this.log("[ZooRemoteControl] disabled")
	}

	private evaluateEligibleForOfflineNotify(): boolean {
		// Only notify offline while a Zoo session can still authenticate the call.
		return Boolean(getCachedZooCodeToken()) && this.getApiProvider() === providerIdentifiers.zooGateway
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

	private async handleMessageEvent(payload: {
		taskId: string
		action?: string
		message: ClineMessage
	}): Promise<void> {
		if (!this.active) {
			return
		}

		const isPartial = payload.message.partial === true
		if (isPartial) {
			const elapsed = this.now() - this.lastPartialFlushAt
			if (elapsed < PARTIAL_EVENT_MIN_INTERVAL_MS) {
				return
			}
			this.lastPartialFlushAt = this.now()
		}

		this.enqueueEvent({
			type: "message",
			taskId: payload.taskId,
			message: payload.message,
			timestamp: this.now(),
		})
	}

	private enqueueEvent(event: Omit<ZooRemoteEvent, "seq">): void {
		if (!this.active) {
			return
		}

		this.pendingEvents.push({ ...event, seq: this.eventSeq++ })
	}

	private markUnavailable(): void {
		this.serverAvailable = false
		this.unavailableUntil = this.now() + UNAVAILABLE_BACKOFF_MS
	}

	private canCallServer(): boolean {
		if (!this.active) {
			return false
		}
		if (this.serverAvailable) {
			return true
		}
		return this.now() >= this.unavailableUntil
	}

	private async publishPresence(online: boolean): Promise<void> {
		if (!this.canCallServer() && online) {
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

		if (result.status === 404) {
			this.markUnavailable()
			return
		}

		if (result.ok) {
			this.serverAvailable = true
		}
	}

	private async flushEvents(): Promise<void> {
		if (!this.active || this.pendingEvents.length === 0 || !this.canCallServer()) {
			return
		}

		const batch = this.pendingEvents.splice(0, this.pendingEvents.length)
		const result = await this.client.postEvents(batch)

		if (result.status === 404) {
			this.markUnavailable()
			// Drop batch while the public endpoint is not available yet.
			return
		}

		if (!result.ok) {
			// Re-queue failed non-404 batches at the front (bounded).
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
					await this.api.sendMessage(command.payload?.text, command.payload?.images)
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
