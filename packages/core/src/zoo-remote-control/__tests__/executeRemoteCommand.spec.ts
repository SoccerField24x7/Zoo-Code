import { describe, expect, it, vi } from "vitest"

import { executeRemoteCommand } from "../executeRemoteCommand.js"

describe("executeRemoteCommand", () => {
	it("acks and sends a message when eligible and lifecycle is current", async () => {
		const ackCommand = vi.fn().mockResolvedValue({ ok: true, status: 200 })
		const sendMessage = vi.fn().mockResolvedValue(undefined)

		await executeRemoteCommand({
			command: { commandId: "c1", type: "message", payload: { text: "hi" } },
			epoch: 1,
			client: { ackCommand },
			host: {
				isLifecycleCurrent: () => true,
				isEligible: () => true,
				sendMessage,
				handleModeSwitch: vi.fn(),
				getCurrentTask: () => undefined,
				cancelCurrentTask: vi.fn(),
				resumeTask: vi.fn(),
				startNewTask: vi.fn(),
			},
		})

		expect(sendMessage).toHaveBeenCalledWith("hi", undefined)
		expect(ackCommand).toHaveBeenCalledWith({ commandId: "c1", status: "acked" })
	})

	it("skips host actions when lifecycle is stale", async () => {
		const ackCommand = vi.fn()
		const sendMessage = vi.fn()

		await executeRemoteCommand({
			command: { commandId: "c1", type: "message", payload: { text: "hi" } },
			epoch: 1,
			client: { ackCommand },
			host: {
				isLifecycleCurrent: () => false,
				isEligible: () => true,
				sendMessage,
				handleModeSwitch: vi.fn(),
				getCurrentTask: () => undefined,
				cancelCurrentTask: vi.fn(),
				resumeTask: vi.fn(),
				startNewTask: vi.fn(),
			},
		})

		expect(sendMessage).not.toHaveBeenCalled()
		expect(ackCommand).not.toHaveBeenCalled()
	})
})
