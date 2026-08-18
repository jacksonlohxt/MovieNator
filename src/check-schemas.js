import fs from "node:fs";
import path from "node:path";

const directory = path.resolve("schemas");
for (const file of fs.readdirSync(directory).filter((name) => name.endsWith(".json"))) {
  const schema = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
  if (schema.additionalProperties !== false || typeof schema.$id !== "string") throw new Error(`Unsafe schema boundary: ${file}`);
}
console.log(`Validated ${fs.readdirSync(directory).filter((name) => name.endsWith(".json")).length} JSON schemas`);
