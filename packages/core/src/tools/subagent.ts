import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentTool } from "@my-agent/loop";
import type { ChatTransport, Usage } from "@my-agent/llm";
import { Type, type Static } from "typebox";
import type { Agent } from "../agent.ts";
import { openAgent } from "../session-factory.ts";
import { workspaceDir } from "../session/paths.ts";
import { type SessionState, SessionManager, createSessionState } from "../session/session-manager.ts";
import { entryUsage } from "../session/snapshot.ts";
import { SettingsManager } from "../settings-manager.ts";
import type { ModelSource } from "../models.ts";
import type { Workspace } from "../workspace.ts";
import { subagentToolState } from "./manager.ts";
import { textResult, throwIfAborted } from "./types.ts";

/**
 * How long `SubAgentControl` with action `output` waits for a running job before reporting status.
 */
const DEFAULT_WAIT_MS = 30_000;

const subagentParams = Type.Object({
	prompt: Type.String({
		description:
			"The complete, self-contained task for the SubAgent. It starts with no context from this conversation, so name files, paths, and the exact question its report must answer.",
	}),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Start the SubAgent in the background and return a job id immediately instead of waiting for its report (default false). Collect the report later with SubAgentControl.",
		}),
	),
});

const controlParams = Type.Object({
	id: Type.String({ description: "The job id the SubAgent tool returned." }),
	action: Type.Union([Type.Literal("output"), Type.Literal("stop")], {
		description: '"output" waits for and returns the job\'s report; "stop" cancels it.',
	}),
	wait_ms: Type.Optional(
		Type.Integer({
			minimum: 0,
			description: `For "output": how long to wait for a running job before reporting status, 0 polls once (default ${DEFAULT_WAIT_MS}).`,
		}),
	),
});

export type SubagentParams = Static<typeof subagentParams>;
export type SubagentControlParams = Static<typeof controlParams>;

/**
 * One delegation, whether the caller waits for it or not.
 *
 * A background job is an in-process promise tree: it dies with the process, and it is reachable
 * only through the `SubAgentControl` tool of the session that holds this table. The child session's
 * transcript, however, is on disk like any other session's — under a `subagents/` directory the
 * sidebar's listing does not scan — so the work is auditable after the fact.
 */
interface SubagentJob {
	id: string;
	prompt: string;
	status: "running" | "done" | "failed" | "stopped";
	report?: string;
	error?: string;
	child?: Agent;
	/** Aborted by `SubAgentControl`'s stop action, or by the parent run's own cancellation. */
	controller: AbortController;
	/** Resolves when the job leaves `running`, whatever the outcome; never rejects. */
	settled: Promise<void>;
}

/** Everything the two tools need to assemble a child session per delegation. */
export interface SubagentToolDeps {
	workspace: Workspace;
	models: ModelSource;
	/** The parent's resolved model, as its row's name: the child runs on the same one. */
	model?: string;
	thinkingLevel: string;
	/**
	 * The parent's transcript, which receives the child's spend as a `usage` entry.
	 *
	 * The child burns tokens on a transcript of its own, so the delegation is the one source of usage
	 * this session's total cannot fold out of its own assistant messages — the record closes that gap.
	 */
	parentSessionManager: SessionManager;
	/** The bag {@link SubagentToolDeps.parentSessionManager} operates on: the parent's own `SessionState`. */
	parentSessionState: SessionState;
	/** The parent's transport. Omitted in the real process, where it means Anthropic Messages. */
	api?: ChatTransport;
	/** The parent transcript's file, recorded as the child header's `parentSession`. */
	parentSessionFile?: string;
}

/**
 * The delegation pair: `SubAgent` to start a child, `SubAgentControl` to collect or stop a
 * background one.
 *
 * Both close over one job table, so a background job started by one call is exactly the job the
 * control tool answers. A child session is assembled through `openAgent` like any other —
 * its own transcript file, the same model, an in-memory settings manager whose approvals are all
 * off because its tool set cannot need one — and `subagents: false` keeps delegation from nesting.
 */
export function createSubagentTools(deps: SubagentToolDeps): AgentTool<any>[] {
	const jobs = new Map<string, SubagentJob>();

	async function buildChild(): Promise<Agent> {
		const absChildDir = join(workspaceDir(deps.workspace.absRoot), "subagents");
		const sessionState = createSessionState(deps.workspace.absRoot, absChildDir, deps.parentSessionFile);
		return openAgent({
			absWorkspaceRoot: deps.workspace.absRoot,
			sessionManager: deps.parentSessionManager,
			sessionState,
			models: deps.models,
			...(deps.model === undefined ? {} : { model: deps.model }),
			thinkingLevel: deps.thinkingLevel,
			...(deps.api === undefined ? {} : { api: deps.api }),
			// The child's loadout is one ToolState: the read-only narrowing, and every approval off —
			// a SubAgent's approval request has no window to answer it (see `subagentToolState`).
			toolState: subagentToolState(),
			// The child's settings are never the workspace's files: they exist so nothing here reads or
			// writes a real settings.json, and the tools it runs need no setting of their own.
			settingsManager: SettingsManager.inMemory({}),
			subagents: false,
		});
	}

	/** The child's last assistant message, or undefined when it produced none. */
	function lastAssistant(child: Agent) {
		const messages = child.sessionManager.buildSessionContext(child.sessionState).messages;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index]!;
			if (message.role === "assistant") return message;
		}
		return undefined;
	}

	/** The child's last assistant text: the report is the delegation's whole product. */
	function reportOf(child: Agent): string {
		const last = lastAssistant(child);
		if (last === undefined) return "(the SubAgent produced no text)";
		return last.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim() || "(the SubAgent produced no text)";
	}

	/**
	 * The child's whole spend, summed over its own transcript.
	 *
	 * The same fold a session's total runs, aimed at the child's file: assistant messages carry their
	 * request's usage, and a delegation is short enough that a compaction is a stranger — but the
	 * fold reads the entry kinds rather than trusting that. `undefined` means the child completed no
	 * request that reported tokens, so there is no spend to record — a spend of nothing is not a
	 * fact worth a line.
	 */
	function childUsage(child: Agent): Usage | undefined {
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let costInput = 0;
		let costOutput = 0;
		let costCacheRead = 0;
		let costCacheWrite = 0;
		let seen = false;
		for (const entry of child.sessionManager.getEntries(child.sessionState)) {
			const usage = entryUsage(entry);
			if (usage === undefined) continue;
			seen = true;
			input += usage.input;
			output += usage.output;
			cacheRead += usage.cacheRead;
			cacheWrite += usage.cacheWrite;
			costInput += usage.cost.input;
			costOutput += usage.cost.output;
			costCacheRead += usage.cost.cacheRead;
			costCacheWrite += usage.cost.cacheWrite;
		}
		if (!seen || input + output + cacheRead + cacheWrite === 0) return undefined;
		return {
			input,
			output,
			cacheRead,
			cacheWrite,
			totalTokens: input + output + cacheRead + cacheWrite,
			cost: {
				input: costInput,
				output: costOutput,
				cacheRead: costCacheRead,
				cacheWrite: costCacheWrite,
				total: costInput + costOutput + costCacheRead + costCacheWrite,
			},
		};
	}

	function startJob(prompt: string, signal: AbortSignal | undefined): SubagentJob {
		const controller = new AbortController();
		signal?.addEventListener("abort", () => controller.abort(), { once: true });
		const job: SubagentJob = { id: randomUUID().slice(0, 8), prompt, status: "running", controller, settled: undefined! };
		jobs.set(job.id, job);
		job.settled = (async () => {
			try {
				const child = await buildChild();
				job.child = child;
				if (controller.signal.aborted) {
					await child.abort();
					job.status = "stopped";
					return;
				}
				// A failed provider call is not a rejection: the loop ends the run with an assistant
				// message whose stopReason is "error", so the transcript is where the outcome is read.
				await child.prompt(prompt);
				if (controller.signal.aborted) {
					job.status = "stopped";
					return;
				}
				const last = lastAssistant(child);
				if (last?.stopReason === "error") {
					job.status = "failed";
					job.error = last.errorMessage ?? "unknown provider error";
					return;
				}
				job.status = "done";
				job.report = reportOf(child);
			} catch (error) {
				if (controller.signal.aborted) {
					job.status = "stopped";
					return;
				}
				job.status = "failed";
				job.error = error instanceof Error ? error.message : String(error);
			} finally {
				if (job.child !== undefined) {
					// Spend is spend whatever the outcome: a failed or stopped child still burned what
					// it burned, and the parent transcript is where this session's total reads it back.
					const usage = childUsage(job.child);
					if (usage !== undefined) {
						deps.parentSessionManager.appendUsage(deps.parentSessionState, "subagent", job.child.modelName, usage);
					}
					await job.child.close().catch(() => {});
				}
			}
		})();
		return job;
	}

	async function waitFor(job: SubagentJob, ms: number, signal: AbortSignal | undefined): Promise<void> {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, ms);
			signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				resolve();
			}, { once: true });
			job.settled.then(resolve);
		});
	}

	const subagent: AgentTool<typeof subagentParams> = {
		name: "SubAgent",
		label: "SubAgent",
		description:
			"Delegate a self-contained task to a SubAgent: a fresh read-only assistant with its own context window that returns only its final report. Use it for broad work whose intermediate output this conversation does not need — reading many files, searching, summarizing. The SubAgent can read (read, glob, grep) but never edit, and starts with no context from this conversation.",
		parameters: subagentParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			const job = startJob(params.prompt, signal);
			if (params.run_in_background === true) {
				return textResult(
					`SubAgent job ${job.id} started in the background. Collect its report with SubAgentControl (action "output", id "${job.id}"), or stop it with action "stop".`,
				);
			}
			await job.settled;
			throwIfAborted(signal);
			if (job.status === "failed") throw new Error(`SubAgent failed: ${job.error}`);
			if (job.status === "stopped") throw new Error("SubAgent was cancelled before it finished.");
			return textResult(job.report ?? "(the SubAgent produced no text)");
		},
	};

	const control: AgentTool<typeof controlParams> = {
		name: "SubAgentControl",
		label: "SubAgentControl",
		description:
			"Collect or stop a background SubAgent job. `SubAgent` with run_in_background answers with a job id; action \"output\" waits for the job and returns its report, action \"stop\" cancels it.",
		parameters: controlParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			const job = jobs.get(params.id);
			if (job === undefined) throw new Error(`Unknown SubAgent job: ${params.id}`);
			if (params.action === "stop") {
				job.controller.abort();
				job.child?.abort();
				await job.settled;
				return textResult(`SubAgent job ${job.id} ${job.status}.`);
			}
			await waitFor(job, params.wait_ms ?? DEFAULT_WAIT_MS, signal);
			throwIfAborted(signal);
			if (job.status === "running") {
				return textResult(`SubAgent job ${job.id} is still running. Call again to keep waiting.`);
			}
			if (job.status === "failed") return textResult(`SubAgent job ${job.id} failed: ${job.error}`);
			if (job.status === "stopped") return textResult(`SubAgent job ${job.id} was stopped before it finished.`);
			return textResult(job.report ?? "(the SubAgent produced no text)");
		},
	};

	return [subagent, control];
}
