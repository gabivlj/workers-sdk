import { handleFailure } from "./common";
import { createCommand, createCommandOptionalYargs } from "./create";
import { deleteCommand, deleteCommandOptionalYargs } from "./delete";
import { RegistriesCommand } from "./images/images";
import { listCommand, listDeploymentsYargs } from "./list";
import { modifyCommand, modifyCommandOptionalYargs } from "./modify";
import { SSHCommand } from "./ssh/ssh";
import type { CommonYargsArgv } from "../yargs-types";

export const cloudchamber = (yargs: CommonYargsArgv) => {
	const argsJson = yargs.option("json", {
		requiresArg: false,
		default: false,
		type: "boolean",
		describe: "if this is true, wrangler will output json only",
	});
	return argsJson
		.command(
			"delete [deploymentId]",
			"Delete an existing deployment that is running in the Cloudflare edge",
			(args) => deleteCommandOptionalYargs(args),
			(args) => handleFailure(deleteCommand)(args)
		)
		.command(
			"create",
			"Create a new deployment in the Cloudflare edge",
			(args) => createCommandOptionalYargs(args),
			(args) => handleFailure(createCommand)(args)
		)
		.command(
			"list [deploymentIdPrefix]",
			"List and view status of deployments",
			(args) => listDeploymentsYargs(args),
			(args) => handleFailure(listCommand)(args)
		)
		.command(
			"modify [deploymentId]",
			"Modify an existing deployment in the Cloudflare edge",
			(args) => modifyCommandOptionalYargs(args),
			(args) => handleFailure(modifyCommand)(args)
		)
		.command(SSHCommand)
		.command(RegistriesCommand);
};
