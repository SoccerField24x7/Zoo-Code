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
})
