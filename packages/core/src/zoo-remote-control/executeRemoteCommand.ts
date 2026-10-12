import type { ZooRemoteCommand } from "./types.js"
import type { ZooRemoteControlClient } from "./ZooRemoteControlClient.js"

export type ZooRemoteCommandHost = {
	isLifecycleCurrent: (epoch: number) => boolean
	isEligible: () => boolean
	sendMessage: (text?: string, images?: string[]) => Promise<void>
	handleModeSwitch: (mode: string) => Promise<void>
	getCurrentTask: () =>
		| {
				approveAsk: (payload?: { text?: string; images?: string[] }) => void
				denyAsk: (payload?: { text?: string; images?: string[] }) => void
		  }
		| undefined
	cancelCurrentTask: () => Promise<void>
	resumeTask: (taskId: string) => Promise<void>
	startNewTask: (payload: { text?: string; images?: string[] }) => Promise<void>
}

/** Apply one remote command through host callbacks, respecting lifecycle epoch checks. */
export async function executeRemoteCommand(options: {
	command: ZooRemoteCommand
	epoch: number
	client: Pick<ZooRemoteControlClient, "ackCommand">
	host: ZooRemoteCommandHost
}): Promise<void> {
	const { command, epoch, client, host } = options

	if (!host.isLifecycleCurrent(epoch)) {
		return
	}

	if (!host.isEligible()) {
		if (!host.isLifecycleCurrent(epoch)) {
			return
		}
		await client.ackCommand({
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
				if (!host.isLifecycleCurrent(epoch)) {
					return
				}
				await host.sendMessage(command.payload?.text, command.payload?.images)
				if (command.payload?.mode) {
					if (!host.isLifecycleCurrent(epoch)) {
						return
					}
					await host.handleModeSwitch(command.payload.mode)
				}
				break
			case "approve_ask": {
				const task = host.getCurrentTask()
				if (!task) {
					if (!host.isLifecycleCurrent(epoch)) {
						return
					}
					await client.ackCommand({
						commandId: command.commandId,
						status: "failed",
						errorCode: "no_current_task",
					})
					return
				}
				if (!host.isLifecycleCurrent(epoch)) {
					return
				}
				task.approveAsk({ text: command.payload?.text, images: command.payload?.images })
				break
			}
			case "deny_ask": {
				const task = host.getCurrentTask()
				if (!task) {
					if (!host.isLifecycleCurrent(epoch)) {
						return
					}
					await client.ackCommand({
						commandId: command.commandId,
						status: "failed",
						errorCode: "no_current_task",
					})
					return
				}
				if (!host.isLifecycleCurrent(epoch)) {
					return
				}
				task.denyAsk({ text: command.payload?.text, images: command.payload?.images })
				break
			}
			case "cancel_task":
				if (!host.isLifecycleCurrent(epoch)) {
					return
				}
				await host.cancelCurrentTask()
				break
			case "resume_task":
				if (!command.taskId) {
					if (!host.isLifecycleCurrent(epoch)) {
						return
					}
					await client.ackCommand({
						commandId: command.commandId,
						status: "failed",
						errorCode: "missing_task_id",
					})
					return
				}
				if (!host.isLifecycleCurrent(epoch)) {
					return
				}
				await host.resumeTask(command.taskId)
				break
			case "start_task":
				if (!host.isLifecycleCurrent(epoch)) {
					return
				}
				await host.startNewTask({
					text: command.payload?.text,
					images: command.payload?.images,
				})
				break
			case "switch_mode": {
				const mode = command.payload?.mode
				if (!mode) {
					if (!host.isLifecycleCurrent(epoch)) {
						return
					}
					await client.ackCommand({
						commandId: command.commandId,
						status: "failed",
						errorCode: "missing_mode",
					})
					return
				}
				if (!host.isLifecycleCurrent(epoch)) {
					return
				}
				await host.handleModeSwitch(mode)
				break
			}
			default: {
				const _exhaustive: never = command.type
				if (!host.isLifecycleCurrent(epoch)) {
					return
				}
				await client.ackCommand({
					commandId: command.commandId,
					status: "failed",
					errorCode: "unknown_command",
					message: String(_exhaustive),
				})
				return
			}
		}

		if (!host.isLifecycleCurrent(epoch)) {
			return
		}
		// Ack 404 (command_not_found) must not mark the bridge unavailable.
		await client.ackCommand({ commandId: command.commandId, status: "acked" })
	} catch (error) {
		if (!host.isLifecycleCurrent(epoch)) {
			return
		}
		await client.ackCommand({
			commandId: command.commandId,
			status: "failed",
			errorCode: "execution_failed",
			message: error instanceof Error ? error.message : String(error),
		})
	}
}
