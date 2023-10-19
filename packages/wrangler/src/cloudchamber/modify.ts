import { cancel, startSection } from "@cloudflare/cli";
import { processArgument } from "@cloudflare/cli/args";
import { inputPrompt, spinner } from "@cloudflare/cli/interactive";
import { pollSSHKeysUntilCondition, waitForPlacement } from "./cli";
import { pickDeployment } from "./cli/deployments";
import { getLocation } from "./cli/locations";
import { DeploymentsService } from "./client";
import {
	handleFailure,
	interactWithUser,
	renderDeploymentConfiguration,
	loadAccountSpinner,
	renderDeploymentMutationError,
	collectEnvironmentVariables,
	promptForEnvironmentVariables,
} from "./common";
import { wrap } from "./helpers/wrap";
import { loadAccount } from "./locations";
import { sshPrompts } from "./ssh/ssh";
import type { Config } from "../config";
import type { CommonYargsOptions } from "../yargs-types";
import type { Deployment, SSHPublicKeyID } from "./client";
import type {
	CommonCloudchamberConfiguration,
	CloudchamberConfiguration,
	inferYargsFn,
} from "./common";
import type { Argv } from "yargs";

function modifyCommandOptionalYargs<T>(yargs: Argv<T>) {
	return yargs
		.positional("deploymentId", {
			type: "string",
			demandOption: false,
			describe: "The deployment you want to modify",
		})
		.option("var", {
			requiresArg: true,
			type: "array",
			demandOption: false,
			describe: "Container environment variables",
			coerce: (arg: unknown[]) => arg.map((a) => a?.toString() ?? ""),
		})
		.option("ssh-public-key-id", {
			requiresArg: true,
			type: "string",
			array: true,
			demandOption: false,
			describe:
				"Public SSH key IDs to include in this container. You can add one to your account with `wrangler cloudchamber ssh create",
		})
		.option("image", {
			requiresArg: true,
			type: "string",
			demandOption: false,
			describe: "The new image that the deployment will have from now on",
		})
		.option("location", {
			requiresArg: true,
			type: "string",
			demandOption: false,
			describe: "The new location that the deployment will have from now on",
		})
		.option("vcpu", {
			requiresArg: true,
			type: "number",
			demandOption: false,
			describe: "The new vcpu that the deployment will have from now on",
		})
		.option("memory", {
			requiresArg: true,
			type: "string",
			demandOption: false,
			describe: "The new memory that the deployment will have from now on",
		});
}

export const modifyCommand = (
	yargs: Argv<CommonYargsOptions & CommonCloudchamberConfiguration>
) => {
	return yargs.command(
		"modify [deploymentId]",
		"Modify an existing deployment in the Cloudflare edge",
		(args) => modifyCommandOptionalYargs(args),
		(args) =>
			handleFailure<typeof args>(async (modifyArgs, config) => {
				await loadAccountSpinner(config);

				if (!interactWithUser(config)) {
					if (!modifyArgs.deploymentId) {
						throw new Error(
							"there needs to be a deploymentId when you can't interact with the wrangler cli"
						);
					}

					const environmentVariables = collectEnvironmentVariables(
						[],
						config.wranglerConfig,
						modifyArgs.var
					);

					const deployment = await DeploymentsService.modifyDeployment(
						modifyArgs.deploymentId,
						{
							image: modifyArgs.image,
							location: modifyArgs.location,
							environment_variables: environmentVariables,
							ssh_public_key_ids: modifyArgs.sshPublicKeyId,
							vcpu: modifyArgs.vcpu ?? config.wranglerConfig.cloudchamber.vcpu,
							memory:
								modifyArgs.memory ?? config.wranglerConfig.cloudchamber.memory,
						}
					);
					console.log(JSON.stringify(deployment, null, 4));
					return;
				}

				await handleModifyCommand(modifyArgs, config);
			})(args)
	);
};

async function handleSSH(
	args: inferYargsFn<typeof modifyCommandOptionalYargs>,
	config: CloudchamberConfiguration,
	deployment: Deployment
): Promise<SSHPublicKeyID[] | undefined> {
	if (args.sshPublicKeyId !== undefined) {
		return args.sshPublicKeyId;
	}

	await sshPrompts(config);
	const keys = await pollSSHKeysUntilCondition(() => true);
	let keysToAdd = [...(deployment.ssh_public_key_ids ?? [])];
	const yes = await inputPrompt<boolean>({
		type: "confirm",
		question: "Do you want to modify existing ssh keys from the deployment?",
		label: "",
		defaultValue: false,
	});
	if (!yes) {
		return undefined;
	}

	if ((deployment.ssh_public_key_ids?.length || 0) > 0) {
		const keysSelected = await inputPrompt<string[]>({
			type: "multiselect",
			question: "Select the keys you want to remove from the deployment",
			helpText: "You can select pressing 'space'. Submit with 'enter'",
			options: keys
				.filter((k) => deployment.ssh_public_key_ids?.includes(k.id))
				.map((key) => ({ label: key.name, value: key.id })),
			label: "removing",
		});
		keysToAdd = keys
			.filter((key) => deployment.ssh_public_key_ids?.includes(key.id))
			.filter((key) => !keysSelected.includes(key.id))
			.map((k) => k.id);
	}

	const addKeysOptions = keys
		.filter((k) => !deployment.ssh_public_key_ids?.includes(k.id))
		.map((key) => ({ label: key.name, value: key.id }));
	if (addKeysOptions.length > 0) {
		const newKeys = await inputPrompt<string[]>({
			type: "multiselect",
			question: "Select the keys you want to add to the deployment",
			options: addKeysOptions,
			label: "adding",
			defaultValue: [],
		});

		keysToAdd = [...newKeys, ...keysToAdd];
	}

	return keysToAdd;
}

async function handleModifyCommand(
	args: inferYargsFn<typeof modifyCommandOptionalYargs>,
	config: CloudchamberConfiguration & { wranglerConfig: Config }
) {
	startSection("Modify deployment");

	const deployment = await pickDeployment(args.deploymentId);

	const keys = await handleSSH(args, config, deployment);
	const imagePrompt = await processArgument<string>(args, "image", {
		question: modifyImageQuestion,
		label: "",
		validate: (value) => {
			if (typeof value !== "string") return "unknown error";
			if (value.endsWith(":latest")) return "we don't allow :latest tags";
		},
		defaultValue: args.image ?? "",
		initialValue: args.image ?? "",
		helpText: "if you don't want to modify the image, press return",
		type: "text",
	});
	const image = !imagePrompt ? undefined : imagePrompt;

	const locationPick = await getLocation(args, { skipLocation: true });
	const location = locationPick === "Skip" ? undefined : locationPick;

	const environmentVariables = collectEnvironmentVariables(
		deployment.environment_variables,
		config.wranglerConfig,
		args.var
	);
	const selectedEnvironmentVariables = await promptForEnvironmentVariables(
		environmentVariables,
		(deployment.environment_variables ?? []).map((v) => v.name),
		true
	);

	renderDeploymentConfiguration("modify", {
		image: image ?? deployment.image,
		location: location ?? deployment.location,
		vcpu:
			args.vcpu ?? config.wranglerConfig.cloudchamber.vcpu ?? deployment.vcpu,
		memory:
			args.memory ??
			config.wranglerConfig.cloudchamber.memory ??
			deployment.memory,
		env: config.env,
		environmentVariables:
			selectedEnvironmentVariables !== undefined
				? selectedEnvironmentVariables
				: deployment.environment_variables, // show the existing environment variables if any
	});

	const yesOrNo = await inputPrompt({
		question: "Want to go ahead and modify the deployment?",
		label: "",
		type: "confirm",
	});
	if (!yesOrNo) {
		cancel("Not modifying the deployment");
		return;
	}

	const { start, stop } = spinner();
	start(
		"Modifying your container",
		"shortly your container will be modified to a new version"
	);
	const [newDeployment, err] = await wrap(
		DeploymentsService.modifyDeployment(deployment.id, {
			image,
			location,
			ssh_public_key_ids: keys,
			environment_variables: selectedEnvironmentVariables,
			vcpu: args.vcpu ?? config.wranglerConfig.cloudchamber.vcpu,
			memory: args.memory ?? config.wranglerConfig.cloudchamber.memory,
		})
	);
	stop();
	if (err) {
		renderDeploymentMutationError(await loadAccount(), err);
		return;
	}

	await waitForPlacement(newDeployment);
}

const modifyImageQuestion =
	"Insert the image url you want to change your deployment to";
