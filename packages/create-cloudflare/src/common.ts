import { existsSync, mkdirSync } from "fs";
import { basename, dirname, relative, resolve } from "path";
import { chdir } from "process";
import {
	crash,
	endSection,
	log,
	logRaw,
	newline,
	openInBrowser,
	shapes,
	startSection,
	updateStatus,
} from "helpers/cli";
import { dim, blue, gray, bgGreen, brandColor } from "helpers/colors";
import {
	detectPackageManager,
	listAccounts,
	printAsyncStatus,
	runCommand,
	runCommands,
	wranglerLogin,
} from "helpers/command";
import { confirmInput, selectInput, spinner } from "helpers/interactive";
import { poll } from "helpers/poll";
import type { Option } from "helpers/interactive";
import type { PagesGeneratorArgs, PagesGeneratorContext } from "types";

const { npm } = detectPackageManager();

export const setupProjectDirectory = (args: PagesGeneratorArgs) => {
	// Crash if the directory already exists
	const path = resolve(args.projectName);
	const isCWD = path === process.cwd();
	const existsAlready = existsSync(path);

	if (!isCWD && existsAlready) {
		crash(
			`Directory \`${args.projectName}\` already exists. Please choose a new name.`
		);
	}

	const directory = dirname(path);
	const name = basename(path);

	// If the target is a nested directory, create the parent
	mkdirSync(directory, { recursive: true });

	// Change to the parent directory
	chdir(directory);

	return { name, path };
};

export const offerToDeploy = async (ctx: PagesGeneratorContext) => {
	startSection(`Deploy with Cloudflare`, `Step 3 of 3`);

	ctx.args.deploy = await confirmInput({
		question: "Do you want to deploy your application?",
		renderSubmitted: (value: boolean) =>
			`${brandColor(value ? `yes` : `no`)} ${dim(
				`deploying via \`${npm} run ${
					ctx.framework?.config.deployCommand ?? "deploy"
				}\``
			)}`,
		initialValue: ctx.args.deploy,
	});

	if (!ctx.args.deploy) return;

	const loginSuccess = await wranglerLogin();
	if (!loginSuccess) return;

	await chooseAccount(ctx);
};

export const runDeploy = async (ctx: PagesGeneratorContext) => {
	if (ctx.args.deploy === false) return;
	if (!ctx.account?.id) {
		crash("Failed to read Cloudflare account.");
		return;
	}

	const deployCmd = `${npm} run ${
		ctx.framework?.config.deployCommand ?? "deploy"
	}`;
	const result = await runCommand(deployCmd, {
		silent: true,
		cwd: ctx.project.path,
		env: { CLOUDFLARE_ACCOUNT_ID: ctx.account.id },
		startText: `Deploying your application`,
		doneText: `${brandColor("deployed")} ${dim(`via \`${deployCmd}\``)}`,
	});

	const deployedUrlRegex = /https:\/\/.+\.(pages|workers)\.dev/;
	const deployedUrlMatch = result.match(deployedUrlRegex);
	if (deployedUrlMatch) {
		ctx.deployedUrl = deployedUrlMatch[0];
	} else {
		crash("Failed to find deployment url.");
	}

	// if a pages url (<sha1>.<project>.pages.dev), remove the sha1
	if (ctx.deployedUrl?.endsWith(".pages.dev")) {
		const [proto, hostname] = ctx.deployedUrl.split("://");
		const hostnameWithoutSHA1 = hostname.split(".").slice(-3).join("."); // only keep the last 3 parts (discard the 4th, i.e. the SHA1)

		ctx.deployedUrl = `${proto}://${hostnameWithoutSHA1}`;
	}
};

export const chooseAccount = async (ctx: PagesGeneratorContext) => {
	const s = spinner();
	s.start(`Selecting Cloudflare account ${dim("retrieving accounts")}`);
	const accounts = await listAccounts();

	let accountId: string;

	if (Object.keys(accounts).length == 1) {
		const accountName = Object.keys(accounts)[0];
		accountId = accounts[accountName];
		s.stop(`${brandColor("account")} ${dim(accountName)}`);
	} else {
		s.stop(
			`${brandColor("account")} ${dim("more than one account available")}`
		);
		const accountOptions = Object.entries(accounts).map(([name, id]) => ({
			label: name,
			value: id,
		}));

		accountId = await selectInput({
			question: "Which account do you want to use?",
			options: accountOptions,
			renderSubmitted: (option: Option) => {
				return `${brandColor("account")} ${dim(option.label)}`;
			},
		});
	}
	const accountName = Object.keys(accounts).find(
		(name) => accounts[name] == accountId
	) as string;

	ctx.account = { id: accountId, name: accountName };
};

export const printSummary = async (ctx: PagesGeneratorContext) => {
	const nextSteps = [
		[
			`Run the development server`,
			`${npm} run ${ctx.framework?.config.devCommand ?? "start"}`,
		],
		[
			`Deploy your application`,
			`${npm} run ${ctx.framework?.config.deployCommand ?? "deploy"}`,
		],
		[
			`Read the documentation`,
			`https://developers.cloudflare.com/${
				ctx.framework ? "pages" : "workers"
			}`,
		],
		[`Stuck? Join us at`, `https://discord.gg/cloudflaredev`],
	];

	if (ctx.deployedUrl) {
		const msg = [
			`${gray(shapes.leftT)}`,
			`${bgGreen(" SUCCESS ")}`,
			`${dim(`View your deployed application at`)}`,
			`${blue(ctx.deployedUrl)}`,
		].join(" ");
		logRaw(msg);
	} else {
		const msg = [
			`${gray(shapes.leftT)}`,
			`${bgGreen(" APPLICATION CREATED ")}`,
			`${dim(`Deploy your application with`)}`,
			`${blue(
				`${npm} run ${ctx.framework?.config.deployCommand ?? "deploy"}`
			)}`,
		].join(" ");
		logRaw(msg);
	}

	newline();
	nextSteps.forEach((entry) => {
		log(`${dim(entry[0])} ${blue(entry[1])}`);
	});
	newline();

	if (ctx.deployedUrl) {
		const success = await poll(ctx.deployedUrl);
		if (success) {
			if (ctx.args.open) {
				await openInBrowser(ctx.deployedUrl);
			}
		}
	}
	endSection("See you again soon!");
};

export const offerGit = async (ctx: PagesGeneratorContext) => {
	const gitInstalled = await isGitInstalled();

	if (!gitInstalled) {
		// haven't prompted yet, if provided as --git arg
		if (ctx.args.git) {
			updateStatus(
				"Couldn't find `git` installed on your machine. Continuing without git."
			);
		}

		// override true (--git flag) and undefined (not prompted yet) to false (don't use git)
		ctx.args.git = false;

		return; // bail early
	}

	const insideGitRepo = await isInsideGitRepo(ctx.project.path);

	if (insideGitRepo) return;

	ctx.args.git ??= await confirmInput({
		question: "Do you want to use git?",
		renderSubmitted: (value: boolean) =>
			`${brandColor("git")} ${dim(value ? `yes` : `no`)}`,
		defaultValue: true,
	});

	if (ctx.args.git) {
		await printAsyncStatus({
			promise: initializeGit(ctx.project.path),
			startText: "Initializing git repo",
			doneText: `${brandColor("initialized")} ${dim(`git`)}`,
		});
	}
};

export const gitCommit = async (ctx: PagesGeneratorContext) => {
	if (!ctx.args.git) return;

	await runCommands({
		silent: true,
		cwd: ctx.project.path,
		commands: [
			"git add .",
			["git", "commit", "-m", "Initial commit (by Create-Cloudflare CLI)"],
		],
		startText: "Committing new files",
		doneText: `${brandColor("git")} ${dim(`initial commit`)}`,
	});
};

/**
 * Check whether git is available on the user's machine.
 */
export async function isGitInstalled() {
	try {
		await runCommand("git -v", { useSpinner: false, silent: true });

		return true;
	} catch {
		return false;
	}
}

/**
 * Check whether the given current working directory is within a git repository
 * by looking for a `.git` directory in this or an ancestor directory.
 */
export async function isInsideGitRepo(cwd: string) {
	try {
		const output = await runCommand("git status", {
			cwd,
			useSpinner: false,
			silent: true,
			captureOutput: true,
		});

		return output.includes("not a git repository") === false;
	} catch (err) {
		return false;
	}
}

/**
 * Initialize a new Worker project with a git repository.
 *
 * We want the branch to be called `main` but earlier versions of git do not support `--initial-branch`.
 * If that is the case then we just fallback to the default initial branch name.
 */
export async function initializeGit(cwd: string) {
	try {
		// Get the default init branch name
		const defaultBranchName = await runCommand(
			"git config --get init.defaultBranch",
			{ useSpinner: false, silent: true, cwd }
		);

		// Try to create the repository with the HEAD branch of defaultBranchName ?? `main`.
		await runCommand(
			`git init --initial-branch ${defaultBranchName.trim() ?? "main"}`, // branch names can't contain spaces, so this is safe
			{ useSpinner: false, silent: true, cwd }
		);
	} catch {
		// Unable to create the repo with a HEAD branch name, so just fall back to the default.
		await runCommand(`git init`, { useSpinner: false, silent: true, cwd });
	}
}
