import type { ClineMessage } from "@roo-code/types"

/** Cap remote tool payloads so dashboard mirror stays usable without huge transfers. */
export const REMOTE_MESSAGE_TEXT_MAX_CHARS = 48_000
export const REMOTE_MESSAGE_IMAGE_MAX_COUNT = 2
export const REMOTE_MESSAGE_IMAGE_MAX_CHARS = 8_000
export const REMOTE_SNAPSHOT_MAX_MESSAGES = 80
/** Cap nested arrays (e.g. batchDiffs) so snapshots stay bounded. */
export const REMOTE_MESSAGE_ARRAY_MAX_ITEMS = 20

function truncateString(value: string, max: number): string {
	if (value.length <= max) {
		return value
	}
	return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`
}

function boundJsonValue(value: unknown): unknown {
	if (typeof value === "string") {
		return truncateString(value, REMOTE_MESSAGE_TEXT_MAX_CHARS)
	}

	if (Array.isArray(value)) {
		return value.slice(0, REMOTE_MESSAGE_ARRAY_MAX_ITEMS).map((entry) => boundJsonValue(entry))
	}

	if (value && typeof value === "object") {
		const record: Record<string, unknown> = {}
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			record[key] = boundJsonValue(child)
		}
		return record
	}

	return value
}

function shapeToolText(text: string): string {
	try {
		const parsed: unknown = JSON.parse(text)
		if (parsed === null || typeof parsed !== "object") {
			return truncateString(text, REMOTE_MESSAGE_TEXT_MAX_CHARS)
		}

		return JSON.stringify(boundJsonValue(parsed))
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
