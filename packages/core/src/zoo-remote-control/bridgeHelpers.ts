/** Nickname-only workspace label — never an absolute disk path. */
export function workspaceNicknameFromFsPath(workspaceRoot: string | undefined) {
	if (!workspaceRoot) {
		return undefined
	}

	return (
		workspaceRoot
			.replace(/[/\\]+$/, "")
			.split(/[/\\]/)
			.pop() || undefined
	)
}

export function remoteMessageKey(taskId: string, message: { messageId?: string; ts: number }) {
	return message.messageId ?? `${taskId}:${message.ts}`
}

export function resolveRemoteMessageAction(
	action: string | undefined,
	partial: boolean | undefined,
): "created" | "updated" {
	if (action === "created" || action === "updated") {
		return action
	}

	return partial ? "updated" : "created"
}

/** Keep failed batch ahead of newer events; retain the newest `max` under pressure. */
export function requeueRemoteEventsKeepingNewest<T>(failedBatch: T[], pending: T[], max = 200) {
	return [...failedBatch, ...pending].slice(-max)
}

export function partialFlushDecision(
	lastPartialFlushAt: number,
	now: number,
	minIntervalMs: number,
): "arm" | "wait" | "flush" {
	if (lastPartialFlushAt === 0) {
		return "arm"
	}

	return now - lastPartialFlushAt < minIntervalMs ? "wait" : "flush"
}

export function isRemoteAuthBlockedStatus(status: number | undefined) {
	return status === 401 || status === 402 || status === 403
}

export function isRemoteNotFoundStatus(status: number | undefined) {
	return status === 404
}
