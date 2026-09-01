#!/usr/bin/env node
/**
 * 跨平台的「env 前缀」。
 *
 * npm 的 script 在 Windows 上跑在 cmd.exe 里，POSIX 的两种写法都不成立：
 * `VAR=value cmd` 与 `${VAR:-default}`。`MODE=stub` 那条尤其难查 —— cmd 把 `MODE`
 * 当成内置的 mode.com，报的是 `Invalid parameter - =stub`，跟环境变量毫无关系。
 *
 * 用法：
 *   node scripts/with-env.mjs KEY=value KEY?=默认值 -- node --experimental-strip-types Server.ts
 *
 *   KEY=value    无条件设
 *   KEY?=value   只在调用方没设过时设 —— 等价于 POSIX 的 ${KEY:-value}
 *
 * 退出码原样透传，`SIGINT`/`SIGTERM` 转发给子进程，`npm start` 之后 Ctrl-C
 * 仍然能让 Server.ts 自己的退出钩子跑完（它要关 pg 连接池与 Redis 客户端）。
 */
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
if (split < 0) {
	console.error("用法：node scripts/with-env.mjs KEY=value KEY?=默认值 -- <命令> [参数…]");
	process.exit(2);
}

const env = { ...process.env };
for (const assignment of argv.slice(0, split)) {
	const eq = assignment.indexOf("=");
	if (eq <= 0) {
		console.error(`认不出这个赋值：${assignment}。要么 KEY=value，要么 KEY?=默认值。`);
		process.exit(2);
	}
	const raw = assignment.slice(0, eq);
	const value = assignment.slice(eq + 1);
	const soft = raw.endsWith("?");
	const key = soft ? raw.slice(0, -1) : raw;
	// 软赋值只在「没设过」时生效。设成空串算设过 —— 那通常是故意要清掉它
	if (soft && env[key] !== undefined) continue;
	env[key] = value;
}

const [command, ...rest] = argv.slice(split + 1);
if (command === undefined) {
	console.error("`--` 后面得有一个命令。");
	process.exit(2);
}

const child = spawn(command, rest, { env, stdio: "inherit", shell: false });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", err => {
	console.error(`起不来 ${command}：${String(err)}`);
	process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
