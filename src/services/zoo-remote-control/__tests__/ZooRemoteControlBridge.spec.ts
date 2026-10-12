import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "events"

import { providerIdentifiers, RooCodeEventName } from "@roo-code/types"

import { ZooRemoteControlBridge } from "../ZooRemoteControlBridge"
import type { ZooRemoteControlClient } from "../ZooRemoteControlClient"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: vi.fn((_key: string, defaultValue?: boolean) => defaultValue),
		})),
		onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
		workspaceFolders: [{ uri: { fsPath: "/tmp/project" } }],
	},
	env: {
		sessionId: "test-session-id",
		appName: "Code",
	},
}))

vi.mock("../../zoo-code-auth", () => ({
	getCachedZooCodeToken: vi.fn(() => ""),
	getZooCodeBaseUrl: vi.fn(() => "https://www.zoocode.dev"),
}))

import * as vscode from "vscode"
import { getCachedZooCodeToken } from "../../zoo-code-auth"

describe("ZooRemoteControlBridge", () => {
	let api: EventEmitter & {
		sendMessage: ReturnType<typeof vi.fn>
		cancelCurrentTask: ReturnType<typeof vi.fn>
		resumeTask: ReturnType<typeof vi.fn>
		startNewTask: ReturnType<typeof vi.fn>
	}
	let provider: EventEmitter & {
		contextProxy: { getProviderSettings: ReturnType<typeof vi.fn> }
		getCurrentTask: ReturnType<typeof vi.fn>
	}
	let client: {
		postPresence: ReturnType<typeof vi.fn>
		postEvents: ReturnType<typeof vi.fn>
		getCommands: ReturnType<typeof vi.fn>
		ackCommand: ReturnType<typeof vi.fn>
	}
	let context: {
		globalState: { get: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
		secrets: { onDidChange: ReturnType<typeof vi.fn> }
	}
	let getConfigValue: (key: string, defaultValue?: boolean) => boolean

	beforeEach(() => {
		vi.useFakeTimers()
		vi.clearAllMocks()

		getConfigValue = (_key, defaultValue) => defaultValue ?? false
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: vi.fn((key: string, defaultValue?: boolean) => getConfigValue(key, defaultValue)),
		} as never)

		vi.mocked(getCachedZooCodeToken).mockReturnValue("")

		api = Object.assign(new EventEmitter(), {
			sendMessage: vi.fn().mockResolvedValue(undefined),
			cancelCurrentTask: vi.fn().mockResolvedValue(undefined),
			resumeTask: vi.fn().mockResolvedValue(undefined),
			startNewTask: vi.fn().mockResolvedValue("task-1"),
		})

		provider = Object.assign(new EventEmitter(), {
			contextProxy: {
				getProviderSettings: vi.fn(() => ({ apiProvider: providerIdentifiers.openrouter })),
			},
			getCurrentTask: vi.fn(() => undefined),
		})

		client = {
			postPresence: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
			postEvents: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
			getCommands: vi.fn().mockResolvedValue({ ok: true, status: 200, body: { commands: [] } }),
			ackCommand: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
		}

		context = {
			globalState: {
				get: vi.fn(() => "instance-1"),
				update: vi.fn().mockResolvedValue(undefined),
			},
			secrets: {
				onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
			},
		}
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	function createBridge() {
		return new ZooRemoteControlBridge({
			api: api as never,
			provider: provider as never,
			context: context as never,
			client: client as unknown as ZooRemoteControlClient,
			now: () => Date.now(),
		})
	}

	it("stays inactive when remote control is disabled", async () => {
		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)
		expect(bridge.isActive()).toBe(false)
		expect(client.postPresence).not.toHaveBeenCalled()
		bridge.dispose()
	})

	it("activates when opted in with an eligible Zoo session", async () => {
		getConfigValue = () => true
		vi.mocked(getCachedZooCodeToken).mockReturnValue("zoo_ext_token")
		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.zooGateway,
		})

		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)

		expect(bridge.isActive()).toBe(true)
		expect(client.postPresence).toHaveBeenCalledWith(
			expect.objectContaining({
				instanceId: "instance-1",
				apiProvider: providerIdentifiers.zooGateway,
				online: true,
			}),
		)
		bridge.dispose()
	})

	it("does not activate when the provider is not eligible", async () => {
		getConfigValue = () => true
		vi.mocked(getCachedZooCodeToken).mockReturnValue("zoo_ext_token")
		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.anthropic,
		})

		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)

		expect(bridge.isActive()).toBe(false)
		bridge.dispose()
	})

	it("executes a remote message command and acks success", async () => {
		getConfigValue = () => true
		vi.mocked(getCachedZooCodeToken).mockReturnValue("zoo_ext_token")
		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.zooGateway,
		})
		client.getCommands.mockResolvedValue({
			ok: true,
			status: 200,
			body: {
				commands: [
					{
						commandId: "cmd-1",
						type: "message",
						payload: { text: "hello from remote" },
					},
				],
			},
		})

		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)
		await vi.advanceTimersByTimeAsync(2_000)

		expect(api.sendMessage).toHaveBeenCalledWith("hello from remote", undefined)
		expect(client.ackCommand).toHaveBeenCalledWith({ commandId: "cmd-1", status: "acked" })
		bridge.dispose()
	})

	it("backs off when the remote endpoints return 404", async () => {
		getConfigValue = () => true
		vi.mocked(getCachedZooCodeToken).mockReturnValue("zoo_ext_token")
		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.zooGateway,
		})
		client.postPresence.mockResolvedValue({ ok: false, status: 404 })
		client.getCommands.mockResolvedValue({ ok: false, status: 404 })

		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)
		expect(bridge.isActive()).toBe(true)

		client.postPresence.mockClear()
		await vi.advanceTimersByTimeAsync(15_000)
		// Still in 404 backoff window — presence should not fire again yet.
		expect(client.postPresence).not.toHaveBeenCalled()

		bridge.dispose()
	})

	it("publishes non-partial message events while active", async () => {
		getConfigValue = () => true
		vi.mocked(getCachedZooCodeToken).mockReturnValue("zoo_ext_token")
		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.zooGateway,
		})

		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)

		api.emit(RooCodeEventName.Message, {
			taskId: "task-1",
			action: "created",
			message: { ts: 1, type: "say", say: "text", text: "hi", partial: false },
		})

		await vi.advanceTimersByTimeAsync(100)

		expect(client.postEvents).toHaveBeenCalledWith(
			"instance-1",
			expect.arrayContaining([
				expect.objectContaining({
					type: "message",
					taskId: "task-1",
					message: expect.objectContaining({ text: "hi" }),
				}),
			]),
		)
		bridge.dispose()
	})

	it("deactivates when the session is no longer eligible", async () => {
		getConfigValue = () => true
		vi.mocked(getCachedZooCodeToken).mockReturnValue("zoo_ext_token")
		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.zooGateway,
		})

		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)
		expect(bridge.isActive()).toBe(true)

		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.openrouter,
		})
		provider.emit(RooCodeEventName.ProviderProfileChanged, {
			name: "OpenRouter",
			provider: providerIdentifiers.openrouter,
		})
		await vi.advanceTimersByTimeAsync(0)

		expect(bridge.isActive()).toBe(false)
		bridge.dispose()
	})

	async function activateEligibleBridge() {
		getConfigValue = () => true
		vi.mocked(getCachedZooCodeToken).mockReturnValue("zoo_ext_token")
		provider.contextProxy.getProviderSettings.mockReturnValue({
			apiProvider: providerIdentifiers.zooGateway,
		})
		const bridge = createBridge()
		await vi.advanceTimersByTimeAsync(0)
		expect(bridge.isActive()).toBe(true)
		return bridge
	}

	it("approves and denies asks on the current task", async () => {
		const task = { approveAsk: vi.fn(), denyAsk: vi.fn() }
		provider.getCurrentTask.mockReturnValue(task)
		client.getCommands.mockResolvedValueOnce({
			ok: true,
			status: 200,
			body: {
				commands: [
					{ commandId: "a1", type: "approve_ask", payload: { text: "ok" } },
					{ commandId: "d1", type: "deny_ask", payload: { text: "no" } },
				],
			},
		})

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)

		expect(task.approveAsk).toHaveBeenCalledWith({ text: "ok", images: undefined })
		expect(task.denyAsk).toHaveBeenCalledWith({ text: "no", images: undefined })
		expect(client.ackCommand).toHaveBeenCalledWith({ commandId: "a1", status: "acked" })
		expect(client.ackCommand).toHaveBeenCalledWith({ commandId: "d1", status: "acked" })
		bridge.dispose()
	})

	it("fails ask commands when there is no current task", async () => {
		provider.getCurrentTask.mockReturnValue(undefined)
		client.getCommands.mockResolvedValueOnce({
			ok: true,
			status: 200,
			body: {
				commands: [
					{ commandId: "a1", type: "approve_ask" },
					{ commandId: "d1", type: "deny_ask" },
				],
			},
		})

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)

		expect(client.ackCommand).toHaveBeenCalledWith({
			commandId: "a1",
			status: "failed",
			errorCode: "no_current_task",
		})
		expect(client.ackCommand).toHaveBeenCalledWith({
			commandId: "d1",
			status: "failed",
			errorCode: "no_current_task",
		})
		bridge.dispose()
	})

	it("rejects commands when eligibility is lost mid-flight", async () => {
		client.getCommands.mockImplementation(async () => {
			provider.contextProxy.getProviderSettings.mockReturnValue({
				apiProvider: providerIdentifiers.openrouter,
			})
			return {
				ok: true,
				status: 200,
				body: { commands: [{ commandId: "m1", type: "message", payload: { text: "late" } }] },
			}
		})

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)

		expect(client.ackCommand).toHaveBeenCalledWith({
			commandId: "m1",
			status: "failed",
			errorCode: "not_eligible",
		})
		bridge.dispose()
	})

	it("cancels, resumes, and starts tasks from remote commands", async () => {
		client.getCommands.mockResolvedValueOnce({
			ok: true,
			status: 200,
			body: {
				commands: [
					{ commandId: "c1", type: "cancel_task" },
					{ commandId: "r1", type: "resume_task", taskId: "task-9" },
					{ commandId: "s1", type: "start_task", payload: { text: "new work" } },
				],
			},
		})

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)

		expect(api.cancelCurrentTask).toHaveBeenCalled()
		expect(api.resumeTask).toHaveBeenCalledWith("task-9")
		expect(api.startNewTask).toHaveBeenCalledWith({ text: "new work", images: undefined })
		expect(client.ackCommand).toHaveBeenCalledWith({ commandId: "c1", status: "acked" })
		expect(client.ackCommand).toHaveBeenCalledWith({ commandId: "r1", status: "acked" })
		expect(client.ackCommand).toHaveBeenCalledWith({ commandId: "s1", status: "acked" })
		bridge.dispose()
	})

	it("fails resume_task when taskId is missing", async () => {
		client.getCommands.mockResolvedValueOnce({
			ok: true,
			status: 200,
			body: { commands: [{ commandId: "r1", type: "resume_task" }] },
		})

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)

		expect(client.ackCommand).toHaveBeenCalledWith({
			commandId: "r1",
			status: "failed",
			errorCode: "missing_task_id",
		})
		bridge.dispose()
	})

	it("acks execution_failed when a command throws", async () => {
		api.sendMessage.mockRejectedValueOnce(new Error("boom"))
		client.getCommands.mockResolvedValueOnce({
			ok: true,
			status: 200,
			body: { commands: [{ commandId: "m1", type: "message", payload: { text: "x" } }] },
		})

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)

		expect(client.ackCommand).toHaveBeenCalledWith({
			commandId: "m1",
			status: "failed",
			errorCode: "execution_failed",
			message: "boom",
		})
		bridge.dispose()
	})

	it("emits lifecycle events while active", async () => {
		const bridge = await activateEligibleBridge()

		api.emit(RooCodeEventName.TaskInteractive, "task-1")
		api.emit(RooCodeEventName.TaskIdle, "task-1")
		api.emit(RooCodeEventName.TaskResumable, "task-1")
		api.emit(RooCodeEventName.TaskCompleted, "task-1")
		api.emit(RooCodeEventName.TaskAborted, "task-1")
		api.emit(RooCodeEventName.TaskModeSwitched, "task-1", "code")

		await vi.advanceTimersByTimeAsync(100)

		expect(client.postEvents).toHaveBeenCalledWith(
			"instance-1",
			expect.arrayContaining([
				expect.objectContaining({ type: "task_interactive", taskId: "task-1" }),
				expect.objectContaining({ type: "task_idle", taskId: "task-1" }),
				expect.objectContaining({ type: "task_resumable", taskId: "task-1" }),
				expect.objectContaining({ type: "task_completed", taskId: "task-1" }),
				expect.objectContaining({ type: "task_aborted", taskId: "task-1" }),
				expect.objectContaining({ type: "mode_switched", taskId: "task-1", mode: "code" }),
			]),
		)
		bridge.dispose()
	})

	it("re-queues event batches when postEvents fails non-404", async () => {
		client.postEvents.mockResolvedValue({ ok: false, status: 500 })
		const bridge = await activateEligibleBridge()

		api.emit(RooCodeEventName.TaskIdle, "task-1")
		await vi.advanceTimersByTimeAsync(100)
		expect(client.postEvents).toHaveBeenCalled()

		client.postEvents.mockClear()
		client.postEvents.mockResolvedValue({ ok: true, status: 200 })
		await vi.advanceTimersByTimeAsync(100)

		expect(client.postEvents).toHaveBeenCalledWith(
			"instance-1",
			expect.arrayContaining([expect.objectContaining({ type: "task_idle", taskId: "task-1" })]),
		)
		bridge.dispose()
	})

	it("ignores command poll responses that are not ok", async () => {
		client.getCommands.mockResolvedValue({ ok: false, status: 500 })
		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)
		expect(client.ackCommand).not.toHaveBeenCalled()
		bridge.dispose()
	})

	it("sends message commands to the local API", async () => {
		client.getCommands.mockResolvedValueOnce({
			ok: true,
			status: 200,
			body: {
				commands: [{ commandId: "m1", type: "message", payload: { text: "hello", images: ["img"] } }],
			},
		})

		const bridge = await activateEligibleBridge()
		await vi.advanceTimersByTimeAsync(2_000)

		expect(api.sendMessage).toHaveBeenCalledWith("hello", ["img"])
		expect(client.ackCommand).toHaveBeenCalledWith({ commandId: "m1", status: "acked" })
		bridge.dispose()
	})
})
