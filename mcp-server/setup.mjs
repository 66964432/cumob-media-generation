#!/usr/bin/env node
// Setup script for CUMOB Media MCP Server
// Registers the MCP server in Claude Desktop's configuration.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_DIR = __dirname;
const INDEX_PATH = path.join(MCP_SERVER_DIR, "index.mjs");

// Detect Claude Desktop config path (supports both official and 3p deployments)
function getClaudeDesktopConfigPaths() {
  const paths = [];
  if (process.platform === "darwin") {
    const base = path.join(os.homedir(), "Library", "Application Support");
    // 3p (third-party deployment) takes priority — check it first
    paths.push(path.join(base, "Claude-3p", "claude_desktop_config.json"));
    paths.push(path.join(base, "Claude", "claude_desktop_config.json"));
  } else if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    paths.push(path.join(base, "Claude-3p", "claude_desktop_config.json"));
    paths.push(path.join(base, "Claude", "claude_desktop_config.json"));
  } else {
    const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    paths.push(path.join(base, "Claude-3p", "claude_desktop_config.json"));
    paths.push(path.join(base, "Claude", "claude_desktop_config.json"));
  }
  return paths;
}

function getActiveClaudeDesktopConfigs() {
  const allPaths = getClaudeDesktopConfigPaths();
  const active = [];
  for (const p of allPaths) {
    // Config file exists, or its parent directory exists (app installed)
    if (fs.existsSync(p) || fs.existsSync(path.dirname(p))) {
      active.push(p);
    }
  }
  // If nothing detected, default to the standard path
  return active.length ? active : [allPaths[allPaths.length - 1]];
}

// Find Node.js path
function findNodePath() {
  try {
    const result = execSync("which node", { encoding: "utf8" }).trim();
    if (result) return result;
  } catch {}
  // Common paths
  const candidates = [
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    path.join(os.homedir(), ".nvm/versions/node"),
    process.execPath,
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return process.execPath;
}

function main() {
  const configPaths = getActiveClaudeDesktopConfigs();
  const nodePath = findNodePath();
  const apiKey = process.env.CUMOB_API_KEY || process.env.OPENAI_API_KEY || "";
  const baseUrl = process.env.CUMOB_BASE_URL || "https://api.cumob.com/v1";

  console.log("CUMOB Media MCP Server Setup");
  console.log("============================\n");
  console.log(`MCP Server:  ${INDEX_PATH}`);
  console.log(`Node.js:     ${nodePath}`);
  console.log(`Config files: ${configPaths.join(", ")}`);
  console.log();

  for (const configPath of configPaths) {
    // Read or create config
    let config = {};
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } catch {
        console.log(`Warning: ${configPath} is invalid, creating new one`);
      }
    }

    // Ensure mcpServers section
    if (!config.mcpServers) config.mcpServers = {};

    // Build env block
    const envBlock = {};
    if (apiKey) envBlock.CUMOB_API_KEY = apiKey;
    envBlock.CUMOB_BASE_URL = baseUrl;

    // Register server
    config.mcpServers["cumob-media"] = {
      command: nodePath,
      args: [INDEX_PATH],
      ...(Object.keys(envBlock).length ? { env: envBlock } : {}),
    };

    // Write config
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const tempPath = `${configPath}.tmp-${process.pid}`;
    fs.writeFileSync(tempPath, JSON.stringify(config, null, 2) + "\n");
    fs.renameSync(tempPath, configPath);

    const label = configPath.includes("Claude-3p") ? "Claude-3p (third-party)" : "Claude (standard)";
    console.log(`✔ Registered in ${label}: ${configPath}`);
  }

  console.log();

  if (!apiKey) {
    console.log(
      "⚠ No API key found. Set CUMOB_API_KEY before running setup,\n" +
        "  or add it manually to the config files.\n"
    );
  }

  console.log("Next steps:");
  console.log("1. Restart Claude Desktop");
  console.log('2. Say "画一只猫" or "generate an image of a cat"');
  console.log("3. Claude will automatically use the CUMOB API to generate it\n");

  // Show manual config for reference
  console.log("─── Manual config (for reference) ───");
  console.log(JSON.stringify({ mcpServers: { "cumob-media": {
    command: nodePath,
    args: [INDEX_PATH],
    env: { CUMOB_API_KEY: apiKey ? "***" : "", CUMOB_BASE_URL: baseUrl },
  } } }, null, 2));
}

main();
