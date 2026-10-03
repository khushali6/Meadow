import { findBinary } from "../core/exec";

const TOOLS: Array<{ label: string; names: string[] }> = [
  { label: "node", names: ["node"] },
  { label: "npm", names: ["npm"] },
  { label: "pnpm", names: ["pnpm"] },
  { label: "yarn", names: ["yarn"] },
  { label: "bun", names: ["bun"] },
  { label: "deno", names: ["deno"] },
  { label: "python", names: ["python3", "python", "py"] },
  { label: "uv", names: ["uv"] },
  { label: "go", names: ["go"] },
  { label: "cargo", names: ["cargo"] },
  { label: "java", names: ["java"] },
  { label: "dotnet", names: ["dotnet"] },
  { label: "ruby", names: ["ruby"] },
  { label: "php", names: ["php"] },
];

let cached: Promise<{ available: string[]; missing: string[] }> | null = null;

/** Which build tools this machine has, so plans only use checks that can actually run here. */
export function machineTools(): Promise<{ available: string[]; missing: string[] }> {
  cached ??= (async () => {
    const found = await Promise.all(TOOLS.map(async tool => ((await findBinary(tool.names)) ? tool.label : null)));
    return { available: TOOLS.filter((_, i) => found[i]).map(tool => tool.label), missing: TOOLS.filter((_, i) => !found[i]).map(tool => tool.label) };
  })();
  return cached;
}

export async function machineSummary(): Promise<string> {
  const { available, missing } = await machineTools();
  const os = process.platform === "win32" ? "Windows (cmd: checks run in cmd.exe; prefer node -e or the project's scripts over POSIX tools)" : process.platform === "darwin" ? "macOS (checks run in sh)" : "Linux (checks run in sh)";
  return `Machine: ${os}\nTools installed: ${available.join(", ") || "none detected"}\nNot installed: ${missing.join(", ") || "none"}`;
}
