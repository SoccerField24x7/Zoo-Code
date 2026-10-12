import { describe, expect, it } from "vitest"

import { projectClineMessageForRemote, projectClineMessagesForSnapshot } from "../projectMessage"

describe("projectClineMessageForRemote", () => {
	it("truncates oversized tool diff payloads while keeping path metadata", () => {
		const huge = "x".repeat(60_000)
		const shaped = projectClineMessageForRemote({
			ts: 1,
			type: "ask",
			ask: "tool",
			text: JSON.stringify({
				tool: "appliedDiff",
				path: "src/a.ts",
				diff: huge,
				diffStats: { added: 1, removed: 0 },
			}),
		})

		expect(shaped.text).toBeTruthy()
		const parsed = JSON.parse(shaped.text!) as {
			path: string
			diff: string
			diffStats: { added: number }
		}
		expect(parsed.path).toBe("src/a.ts")
		expect(parsed.diffStats.added).toBe(1)
		expect(parsed.diff.length).toBeLessThan(huge.length)
		expect(parsed.diff).toContain("[truncated")
	})

	it("limits snapshot windows", () => {
		const messages = Array.from({ length: 120 }, (_, i) => ({
			ts: i,
			type: "say" as const,
			say: "text" as const,
			text: `m${i}`,
		}))
		const window = projectClineMessagesForSnapshot(messages)
		expect(window).toHaveLength(80)
		expect(window[0]?.text).toBe("m40")
		expect(window.at(-1)?.text).toBe("m119")
	})
})
