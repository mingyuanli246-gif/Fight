import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const args = {
    frontendRoot: path.resolve(process.cwd(), "src"),
    rustLib: path.resolve(process.cwd(), "src-tauri/src/lib.rs"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === "--frontend-root" && next) {
      args.frontendRoot = path.resolve(process.cwd(), next);
      index += 1;
      continue;
    }

    if (current === "--rust-lib" && next) {
      args.rustLib = path.resolve(process.cwd(), next);
      index += 1;
    }
  }

  return args;
}

async function collectFiles(rootDir, extensions) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolutePath, extensions)));
      continue;
    }

    if (extensions.has(path.extname(entry.name))) {
      files.push(absolutePath);
    }
  }

  return files;
}

function extractInvokeCommands(source) {
  const commandNames = new Set();
  const invokePattern = /\binvoke(?:<[\s\S]*?>)?\s*\(\s*["'`]([^"'`]+)["'`]/g;

  for (const match of source.matchAll(invokePattern)) {
    const commandName = match[1]?.trim();
    if (commandName) {
      commandNames.add(commandName);
    }
  }

  return commandNames;
}

function extractRegisteredCommands(source) {
  const handlerPattern = /generate_handler!\s*\[([\s\S]*?)\]/m;
  const match = source.match(handlerPattern);

  if (!match?.[1]) {
    throw new Error("未找到 tauri::generate_handler![] 注册列表。");
  }

  const normalized = match[1]
    .split(",")
    .map((item) => item.replace(/\/\/.*$/g, "").trim())
    .filter(Boolean);

  return new Set(normalized);
}

async function main() {
  const { frontendRoot, rustLib } = parseArgs(process.argv.slice(2));
  const frontendStats = await stat(frontendRoot);
  const rustLibStats = await stat(rustLib);

  if (!frontendStats.isDirectory()) {
    throw new Error(`前端目录不存在：${frontendRoot}`);
  }

  if (!rustLibStats.isFile()) {
    throw new Error(`Rust lib.rs 不存在：${rustLib}`);
  }

  const frontendFiles = await collectFiles(frontendRoot, new Set([".ts", ".tsx"]));
  const frontendCommands = new Set();

  for (const file of frontendFiles) {
    const source = await readFile(file, "utf8");
    for (const commandName of extractInvokeCommands(source)) {
      frontendCommands.add(commandName);
    }
  }

  const rustSource = await readFile(rustLib, "utf8");
  const registeredCommands = extractRegisteredCommands(rustSource);

  const missingCommands = [...frontendCommands]
    .filter((commandName) => !registeredCommands.has(commandName))
    .sort();
  const unusedCommands = [...registeredCommands]
    .filter((commandName) => !frontendCommands.has(commandName))
    .sort();

  console.info(
    `[check:tauri-commands] frontend invoke commands: ${frontendCommands.size}, registered commands: ${registeredCommands.size}`,
  );

  if (unusedCommands.length > 0) {
    console.warn("[check:tauri-commands] 已注册但前端未直接 invoke 的命令：");
    for (const commandName of unusedCommands) {
      console.warn(`  - ${commandName}`);
    }
  }

  if (missingCommands.length > 0) {
    console.error("[check:tauri-commands] 以下前端 invoke 缺少 lib.rs 注册：");
    for (const commandName of missingCommands) {
      console.error(`  - ${commandName}`);
    }
    process.exitCode = 1;
    return;
  }

  console.info("[check:tauri-commands] 所有前端 invoke 均已注册。");
}

main().catch((error) => {
  console.error("[check:tauri-commands] 运行失败：", error);
  process.exitCode = 1;
});
