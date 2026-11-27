// Validates packages/serve-droid/web-ui/tools.json, the agent tool manifest
// that WebMCP and `serve-droid mcp` both build their tools from.
// Usage: node .github/scripts/check-tools-manifest.mjs [path]
import { readFileSync } from "node:fs";

const file = process.argv[2] || "packages/serve-droid/web-ui/tools.json";
const errors = [];
let tools;
try {
  tools = JSON.parse(readFileSync(file, "utf8"));
} catch (err) {
  console.error(`${file}: ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(tools) || tools.length === 0) {
  console.error(`${file}: expected a non-empty array of tools`);
  process.exit(1);
}

const seen = new Set();
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
tools.forEach((tool, i) => {
  const at = `tools[${i}]${tool?.name ? ` (${tool.name})` : ""}`;
  if (!isObject(tool)) return errors.push(`${at}: not an object`);
  if (typeof tool.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(tool.name)) errors.push(`${at}: name must be snake_case`);
  else if (seen.has(tool.name)) errors.push(`${at}: duplicate name`);
  else seen.add(tool.name);
  if (typeof tool.description !== "string" || !tool.description.trim()) errors.push(`${at}: missing description`);
  if (!isObject(tool.inputSchema) || tool.inputSchema.type !== "object") errors.push(`${at}: inputSchema must be a JSON Schema with type "object"`);
  if (!isObject(tool.http)) errors.push(`${at}: missing http`);
  else {
    if (!["GET", "POST"].includes(tool.http.method)) errors.push(`${at}: http.method must be GET or POST`);
    if (typeof tool.http.path !== "string" || !tool.http.path || tool.http.path.startsWith("/")) errors.push(`${at}: http.path must be a relative path like "api/tap"`);
  }
  if (tool.result !== undefined && !["json", "image"].includes(tool.result)) errors.push(`${at}: result must be "json" or "image"`);
  if (tool.annotations !== undefined && !isObject(tool.annotations)) errors.push(`${at}: annotations must be an object`);
});

if (errors.length) {
  console.error(`${file}: ${errors.length} problem(s)\n  ${errors.join("\n  ")}`);
  process.exit(1);
}
console.log(`${file}: ${tools.length} tools OK`);
