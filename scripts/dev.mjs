#!/usr/bin/env node

// Starts the platform on one machine (requirement V1).
// It uses DATABASE_URL if you set it. Else it starts the Postgres of docker-compose.yml.
// It applies the migrations and makes the login users. Then it starts the Worker and the launcher.
// Ctrl-C stops all the programs.

import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const LOCAL_DATABASE_URL = `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "local"}@127.0.0.1:5432/tensquads`;

function run(command, args, env = process.env) {
	const result = spawnSync(command, args, { cwd: ROOT, env, stdio: "inherit" });
	if (result.status !== 0) {
		console.error(`dev: "${command} ${args.join(" ")}" failed.`);
		process.exit(result.status ?? 1);
	}
}

// Gives the URL of DATABASE_URL with a login user in place of the owner.
function loginUrl(databaseUrl, user, password) {
	const url = new URL(databaseUrl);
	url.username = user;
	url.password = password;
	return url.toString();
}

if (!process.env.DATABASE_URL) {
	console.log("dev: DATABASE_URL is not set. Start the local Postgres with docker compose.");
	run("docker", ["compose", "up", "-d", "--wait"]);
}
const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
const password = process.env.DB_USER_PASSWORD ?? "local";
const env = {
	...process.env,
	DATABASE_URL: databaseUrl,
	DB_USER_PASSWORD: password,
	PETRA_DATABASE_URL: loginUrl(databaseUrl, "ts_petra_login", password),
	PLATFORM_DATABASE_URL: loginUrl(databaseUrl, "ts_platform_login", password),
	ADMIN_VIEWS_DATABASE_URL: loginUrl(databaseUrl, "ts_admin_views_login", password),
};

run("npm", ["run", "db:setup"], env);

// Wrangler reads the local values of the Worker from .dev.vars. Git ignores this file.
const devVars = ["PETRA_DATABASE_URL", "PLATFORM_DATABASE_URL", "ADMIN_VIEWS_DATABASE_URL"]
	.map((name) => `${name}=${JSON.stringify(env[name])}`)
	.join("\n");
writeFileSync(join(ROOT, "apps/platform/.dev.vars"), `${devVars}\n`);

// The Worker bundles @tensquads/core from its dist folder, so the packages are built first.
run("npm", ["run", "build", "-w", "packages", "--if-present"], env);
run("npm", ["run", "build", "-w", "@tensquads/launcher"], env);

const children = [
	spawn("npm", ["run", "dev", "-w", "@tensquads/platform"], { cwd: ROOT, env, stdio: "inherit" }),
	spawn("npm", ["run", "start", "-w", "@tensquads/launcher"], { cwd: ROOT, env, stdio: "inherit" }),
];

function stop(signal) {
	for (const child of children) {
		if (child.exitCode === null) {
			child.kill(signal);
		}
	}
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

// When one program fails, stop the others.
for (const child of children) {
	child.on("exit", (code) => {
		if (code !== 0 && code !== null) {
			process.exitCode = code;
			stop("SIGTERM");
		}
	});
}
