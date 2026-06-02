#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function usage() {
  process.stdout.write(`Usage:
  node ./scripts/install-config-helper.mjs claude-mcp <config-path> <project-root> <server-name> <command-name>
  node ./scripts/install-config-helper.mjs gemini-mcp <config-path> <server-name> <command-name>
  node ./scripts/install-config-helper.mjs opencode-mcp <primary-config-path> <secondary-config-path> <server-name> <command-name>
  node ./scripts/install-config-helper.mjs copy-into-dir <target-dir> <source-path> [<source-path> ...]
`);
}

function readTextIfExists(filePath) {
  if (!existsSync(filePath)) {
    return "";
  }
  return readFileSync(filePath, "utf8");
}

function ensureParentDir(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJSONObjectConfig(configPath, label) {
  const raw = readTextIfExists(configPath);
  if (raw.trim().length === 0) {
    return {};
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    fail(`Existing ${label} is not valid JSON: ${error.message}`);
  }

  if (data === null || Array.isArray(data) || typeof data !== "object") {
    fail(`Existing ${label} root is not a JSON object; refusing to modify it.`);
  }

  return data;
}

function ensureObjectField(parent, key, label) {
  const value = parent[key] ?? {};
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(label);
  }
  parent[key] = value;
  return value;
}

function getOptionalObjectField(parent, key, label) {
  if (!(key in parent) || parent[key] === undefined) {
    return undefined;
  }

  const value = parent[key];
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(label);
  }

  return value;
}

function writeJSONConfig(configPath, data) {
  ensureParentDir(configPath);
  writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function installClaudeMcp(configPath, projectRoot, serverName, commandName) {
  const desiredEntry = {
    type: "stdio",
    command: commandName,
    args: ["mcp"],
  };
  const data = readJSONObjectConfig(configPath, `Claude config ${configPath}`);
  const projects = ensureObjectField(data, "projects", 'Existing Claude config has non-object "projects"; refusing to modify it.');
  const projectEntry = ensureObjectField(
    projects,
    projectRoot,
    `Existing Claude project entry for ${projectRoot} is not an object; refusing to modify it.`,
  );
  const mcpServers = ensureObjectField(
    projectEntry,
    "mcpServers",
    `Existing Claude project MCP config for ${projectRoot} is not an object; refusing to modify it.`,
  );

  const target = mcpServers[serverName];
  const targetMatches = JSON.stringify(target) === JSON.stringify(desiredEntry);

  if (targetMatches) {
    process.stdout.write(`Claude MCP server "${serverName}" is already installed for ${projectRoot} in ${configPath}.\n`);
    return;
  }

  mcpServers[serverName] = desiredEntry;

  writeJSONConfig(configPath, data);
  process.stdout.write(`Installed Claude MCP server "${serverName}" for ${projectRoot} into ${configPath}.\n`);
}

function installGeminiMcp(configPath, serverName, commandName) {
  const desiredEntry = {
    command: commandName,
    args: ["mcp"],
  };
  const data = readJSONObjectConfig(configPath, `Gemini config ${configPath}`);
  const mcpServers = ensureObjectField(
    data,
    "mcpServers",
    `Existing Gemini config has non-object "mcpServers"; refusing to modify it.`,
  );

  const target = mcpServers[serverName];
  const targetMatches = JSON.stringify(target) === JSON.stringify(desiredEntry);

  if (targetMatches) {
    process.stdout.write(`Gemini MCP server "${serverName}" is already installed in ${configPath}.\n`);
    return;
  }

  mcpServers[serverName] = desiredEntry;

  writeJSONConfig(configPath, data);
  process.stdout.write(`Installed Gemini MCP server "${serverName}" into ${configPath}.\n`);
}

function installOpencodeMcp(primaryConfigPath, secondaryConfigPath, serverName, commandName) {
  const desiredEntry = {
    type: "local",
    command: [commandName, "mcp"],
  };
  const configEntries = [{ path: primaryConfigPath, role: "primary" }];
  if (secondaryConfigPath && secondaryConfigPath !== primaryConfigPath) {
    configEntries.push({ path: secondaryConfigPath, role: "secondary" });
  }

  const records = configEntries.map((entry) => ({
    ...entry,
    data: readJSONObjectConfig(entry.path, `opencode config ${entry.path}`),
    dirty: false,
  }));

  const targetMatches = [];
  const extraAliases = [];
  for (const record of records) {
    const mcp = getOptionalObjectField(
      record.data,
      "mcp",
      `Existing opencode config has non-object "mcp" in ${record.path}; refusing to modify it.`,
    );
    if (!mcp) {
      continue;
    }

    if (JSON.stringify(mcp[serverName]) === JSON.stringify(desiredEntry)) {
      targetMatches.push(record.path);
    }
    if (serverName in mcp) {
      extraAliases.push(record.path);
    }
  }

  if (targetMatches.length === 1 && extraAliases.length === 1 && targetMatches[0] === extraAliases[0]) {
    process.stdout.write(`opencode MCP server "${serverName}" is already installed in ${targetMatches[0]}.\n`);
    return;
  }

  for (const record of records) {
    const mcp = ensureObjectField(
      record.data,
      "mcp",
      `Existing opencode config has non-object "mcp" in ${record.path}; refusing to modify it.`,
    );

    if (record.role === "primary") {
      if (JSON.stringify(mcp[serverName]) !== JSON.stringify(desiredEntry)) {
        mcp[serverName] = desiredEntry;
        record.dirty = true;
      }
      continue;
    }

    if (serverName in mcp) {
      delete mcp[serverName];
      record.dirty = true;
    }
    if (Object.keys(mcp).length === 0) {
      delete record.data.mcp;
    }
  }

  for (const record of records) {
    if (record.dirty) {
      writeJSONConfig(record.path, record.data);
    }
  }

  process.stdout.write(`Installed opencode MCP server "${serverName}" into ${primaryConfigPath}.\n`);
}

function copyIntoDir(targetDir, sourcePaths) {
  if (sourcePaths.length === 0) {
    fail("copy-into-dir requires at least one source path.");
  }

  mkdirSync(targetDir, { recursive: true });

  for (const sourcePath of sourcePaths) {
    if (!existsSync(sourcePath)) {
      fail(`Source path does not exist: ${sourcePath}`);
    }

    const destinationPath = path.join(targetDir, path.basename(sourcePath));
    rmSync(destinationPath, { recursive: true, force: true });
    cpSync(sourcePath, destinationPath, { recursive: true });
  }
}

function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case "claude-mcp":
      if (args.length !== 4) {
        usage();
        process.exit(1);
      }
      installClaudeMcp(...args);
      return;
    case "gemini-mcp":
      if (args.length !== 3) {
        usage();
        process.exit(1);
      }
      installGeminiMcp(...args);
      return;
    case "opencode-mcp":
      if (args.length !== 4) {
        usage();
        process.exit(1);
      }
      installOpencodeMcp(...args);
      return;
    case "copy-into-dir":
      if (args.length < 2) {
        usage();
        process.exit(1);
      }
      copyIntoDir(args[0], args.slice(1));
      return;
    default:
      usage();
      process.exit(1);
  }
}

main(process.argv.slice(2));
