import type { ClineMessage } from "@roo-code/types"

/** Cap remote tool payloads so dashboard mirror stays usable without huge transfers. */
export const REMOTE_MESSAGE_TEXT_MAX_CHARS = 48_000
export const REMOTE_MESSAGE_IMAGE_MAX_COUNT = 2
export const REMOTE_MESSAGE_IMAGE_MAX_CHARS = 8_000
export const REMOTE_SNAPSHOT_MAX_MESSAGES = 80

function truncateString(value: string, max: number): string {
	if (value.length <= max) {
		return value
	}
	return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`
}

function shapeToolText(text: string): string {
	try {
		const parsed: unknown = JSON.parse(text)
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return truncateString(text, REMOTE_MESSAGE_TEXT_MAX_CHARS)
		}

		const record = { ...(parsed as Record<string, unknown>) }
		for (const key of ["content", "diff", "originalContent", "code", "result"] as const) {
			const value = record[key]
			if (typeof value === "string") {
				record[key] = truncateString(value, REMOTE_MESSAGE_TEXT_MAX_CHARS)
			}
		}

		if (Array.isArray(record.batchDiffs)) {
			record.batchDiffs = record.batchDiffs.slice(0, 20).map((entry) => {
				if (!entry || typeof entry !== "object") {
					return entry
				}
				const item = { ...(entry as Record<string, unknown>) }
				if (typeof item.diff === "string") {
					item.diff = truncateString(item.diff, REMOTE_MESSAGE_TEXT_MAX_CHARS)
				}
				if (typeof item.content === "string") {
					item.content = truncateString(item.content, REMOTE_MESSAGE_TEXT_MAX_CHARS)
				}
				return item
			})
		}

		return JSON.stringify(record)
	} catch {
		return truncateString(text, REMOTE_MESSAGE_TEXT_MAX_CHARS)
	}
}

/** Shape a ClineMessage for remote publish (size-safe, still useful for asks/diffs). */
export function projectClineMessageForRemote(message: ClineMessage): ClineMessage {
	const next: ClineMessage = { ...message }

	if (typeof next.text === "string") {
		const isToolish =
			next.ask === "tool" || next.say === "tool" || next.ask === "command" || next.ask === "use_mcp_server"

		next.text = isToolish ? shapeToolText(next.text) : truncateString(next.text, REMOTE_MESSAGE_TEXT_MAX_CHARS)
	}

	if (typeof next.reasoning === "string") {
		next.reasoning = truncateString(next.reasoning, REMOTE_MESSAGE_TEXT_MAX_CHARS)
	}

	if (Array.isArray(next.images) && next.images.length > 0) {
		next.images = next.images
			.slice(0, REMOTE_MESSAGE_IMAGE_MAX_COUNT)
			.map((image) => truncateString(image, REMOTE_MESSAGE_IMAGE_MAX_CHARS))
	}

	return next
}

export function projectClineMessagesForSnapshot(messages: ClineMessage[]): ClineMessage[] {
	const window = messages.slice(-REMOTE_SNAPSHOT_MAX_MESSAGES)
	return window.map(projectClineMessageForRemote)
}
