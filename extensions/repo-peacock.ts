/**
 * pi-peacock
 *
 * Peacock-style repo identity for pi:
 * - repo-specific theme
 * - colored footer badge
 * - terminal title with repo + branch
 */

import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const execFileAsync = promisify(execFile);
const STATUS_KEY = "pi-peacock";

const AUTO_THEMES = [
	"peacock-amber",
	"peacock-blue",
	"peacock-cyan",
	"peacock-green",
	"peacock-purple",
	"peacock-rose",
] as const;

type PeacockRule = {
	repo?: string;
	pathIncludes?: string | string[];
	theme?: string;
	label?: string;
	title?: string;
	status?: string;
};

type PeacockConfig = {
	autoAssignTheme?: boolean;
	fallbackLabel?: string;
	fallbackTheme?: string;
	rules?: PeacockRule[];
	showBranch?: boolean;
	showStatus?: boolean;
	showTitle?: boolean;
	titlePrefix?: string;
};

type RepoInfo = {
	branch: string;
	cwd: string;
	gitRoot: string | null;
	repoName: string;
};

type ResolvedIdentity = {
	label: string;
	source: "auto" | "fallback" | "rule";
	status?: string;
	theme: string;
	title?: string;
};

type AppliedIdentity = {
	configPaths: string[];
	identity: ResolvedIdentity;
	repo: RepoInfo;
	signature: string;
};

const DEFAULT_CONFIG = {
	autoAssignTheme: true,
	showBranch: true,
	showStatus: true,
	showTitle: true,
	titlePrefix: "π",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd });
		return stdout.trim();
	} catch {
		return "";
	}
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

function hashString(value: string): number {
	let hash = 0;

	for (const char of value) {
		hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	}

	return hash;
}

function asArray(value: string | string[] | undefined): string[] {
	if (!value) return [];
	return Array.isArray(value) ? value : [value];
}

function fillTemplate(template: string, repo: RepoInfo, label: string): string {
	return template
		.replaceAll("{repo}", repo.repoName)
		.replaceAll("{branch}", repo.branch)
		.replaceAll("{label}", label)
		.replaceAll("{cwd}", repo.cwd)
		.replaceAll("{gitRoot}", repo.gitRoot ?? "");
}

function pickAutoTheme(repoName: string): string {
	return AUTO_THEMES[hashString(repoName) % AUTO_THEMES.length] ?? "peacock-blue";
}

function ruleMatches(rule: PeacockRule, repo: RepoInfo): boolean {
	let hasSelector = false;

	if (rule.repo) {
		hasSelector = true;
		if (rule.repo !== repo.repoName) return false;
	}

	const pathIncludes = asArray(rule.pathIncludes);
	if (pathIncludes.length > 0) {
		hasSelector = true;
		const haystacks = [repo.cwd, repo.gitRoot ?? ""];
		const matched = pathIncludes.some((needle) =>
			haystacks.some((haystack) => haystack.includes(needle)),
		);
		if (!matched) return false;
	}

	return hasSelector;
}

async function readConfigFile(
	filePath: string,
	reportedErrors: Set<string>,
	ctx: ExtensionContext,
): Promise<PeacockConfig | undefined> {
	if (!(await exists(filePath))) return undefined;

	try {
		return JSON.parse(await readFile(filePath, "utf8")) as PeacockConfig;
	} catch (error) {
		if (!reportedErrors.has(filePath)) {
			reportedErrors.add(filePath);
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(
				`pi-peacock: failed to parse ${filePath} (${message})`,
				"warning",
			);
		}
		return undefined;
	}
}

async function getRepoInfo(cwd: string): Promise<RepoInfo> {
	const gitRoot = (await git(cwd, "rev-parse", "--show-toplevel")) || null;
	const repoName = path.basename(gitRoot ?? cwd);
	const branch = gitRoot
		? (await git(cwd, "branch", "--show-current")) ||
			(await git(cwd, "rev-parse", "--short", "HEAD"))
		: "";

	return {
		branch,
		cwd,
		gitRoot,
		repoName,
	};
}

async function loadConfig(
	repo: RepoInfo,
	reportedErrors: Set<string>,
	ctx: ExtensionContext,
): Promise<{ config: PeacockConfig; configPaths: string[] }> {
	const globalConfigPath = path.join(os.homedir(), ".pi", "agent", "peacock.json");
	const projectConfigPath = path.join(repo.gitRoot ?? repo.cwd, ".pi", "peacock.json");
	const configPaths: string[] = [];

	const globalConfig = await readConfigFile(globalConfigPath, reportedErrors, ctx);
	const projectConfig = await readConfigFile(projectConfigPath, reportedErrors, ctx);

	if (globalConfig) configPaths.push(globalConfigPath);
	if (projectConfig) configPaths.push(projectConfigPath);

	return {
		config: {
			...globalConfig,
			...projectConfig,
			rules: [...(projectConfig?.rules ?? []), ...(globalConfig?.rules ?? [])],
		},
		configPaths,
	};
}

function resolveIdentity(repo: RepoInfo, config: PeacockConfig): ResolvedIdentity {
	const matchedRule = (config.rules ?? []).find((rule) => ruleMatches(rule, repo));
	if (matchedRule) {
		return {
			label: matchedRule.label ?? repo.repoName,
			source: "rule",
			status: matchedRule.status,
			theme:
				matchedRule.theme ?? config.fallbackTheme ?? pickAutoTheme(repo.repoName),
			title: matchedRule.title,
		};
	}

	if (config.autoAssignTheme ?? DEFAULT_CONFIG.autoAssignTheme) {
		return {
			label: config.fallbackLabel ?? repo.repoName,
			source: "auto",
			theme: pickAutoTheme(repo.repoName),
		};
	}

	return {
		label: config.fallbackLabel ?? repo.repoName,
		source: "fallback",
		theme: config.fallbackTheme ?? "dark",
	};
}

function getStatusText(
	ctx: ExtensionContext,
	repo: RepoInfo,
	identity: ResolvedIdentity,
	config: PeacockConfig,
): string {
	if (identity.status) {
		return ctx.ui.theme.fg(
			"accent",
			fillTemplate(identity.status, repo, identity.label),
		);
	}

	const badge = ctx.ui.theme.fg("accent", `🦚 ${identity.label}`);
	const branch =
		(config.showBranch ?? DEFAULT_CONFIG.showBranch) && repo.branch
			? ctx.ui.theme.fg("dim", ` · ${repo.branch}`)
			: "";
	return `${badge}${branch}`;
}

function getTitle(repo: RepoInfo, identity: ResolvedIdentity, config: PeacockConfig): string {
	if (identity.title) {
		return fillTemplate(identity.title, repo, identity.label);
	}

	const branch =
		(config.showBranch ?? DEFAULT_CONFIG.showBranch) && repo.branch
			? ` · ${repo.branch}`
			: "";
	const prefix = config.titlePrefix ?? DEFAULT_CONFIG.titlePrefix;
	return `${prefix} ${identity.label}${branch}`.trim();
}

function getSignature(repo: RepoInfo, identity: ResolvedIdentity, config: PeacockConfig): string {
	return JSON.stringify({
		branch: repo.branch,
		label: identity.label,
		showBranch: config.showBranch ?? DEFAULT_CONFIG.showBranch,
		showStatus: config.showStatus ?? DEFAULT_CONFIG.showStatus,
		showTitle: config.showTitle ?? DEFAULT_CONFIG.showTitle,
		source: identity.source,
		status: identity.status,
		theme: identity.theme,
		title: identity.title,
	});
}

export default function (pi: ExtensionAPI) {
	let lastSignature = "";
	const reportedConfigErrors = new Set<string>();
	const reportedThemeErrors = new Set<string>();

	async function applyIdentity(
		ctx: ExtensionContext,
		force: boolean = false,
	): Promise<AppliedIdentity> {
		const repo = await getRepoInfo(ctx.cwd);
		const { config, configPaths } = await loadConfig(repo, reportedConfigErrors, ctx);
		const identity = resolveIdentity(repo, config);
		const signature = getSignature(repo, identity, config);

		if (!force && signature === lastSignature) {
			return { configPaths, identity, repo, signature };
		}

		const themeResult = ctx.ui.setTheme(identity.theme);
		if (!themeResult.success && !reportedThemeErrors.has(identity.theme)) {
			reportedThemeErrors.add(identity.theme);
			ctx.ui.notify(
				`pi-peacock: theme '${identity.theme}' not found`,
				"warning",
			);
		}

		if (config.showStatus ?? DEFAULT_CONFIG.showStatus) {
			ctx.ui.setStatus(STATUS_KEY, getStatusText(ctx, repo, identity, config));
		} else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}

		if (config.showTitle ?? DEFAULT_CONFIG.showTitle) {
			ctx.ui.setTitle(getTitle(repo, identity, config));
		}

		lastSignature = signature;
		return { configPaths, identity, repo, signature };
	}

	pi.registerCommand("peacock", {
		description: "Show or refresh the current pi-peacock repo identity",
		handler: async (_args, ctx) => {
			const applied = await applyIdentity(ctx, true);
			const branch = applied.repo.branch ? ` · ${applied.repo.branch}` : "";
			const configText =
				applied.configPaths.length > 0
					? ` configs: ${applied.configPaths.join(", ")}`
					: " configs: none";

			ctx.ui.notify(
				`pi-peacock: ${applied.identity.label} → ${applied.identity.theme} (${applied.identity.source})${branch}${configText}`,
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await applyIdentity(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		lastSignature = "";
		await applyIdentity(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await applyIdentity(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
