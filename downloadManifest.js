import axios from "axios";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { execSync } from "child_process";

dotenv.config();

const API_KEY = process.env.BUNGIE_API_KEY;
if (!API_KEY) {
  console.error("Missing BUNGIE_API_KEY in environment.");
  process.exit(1);
}

const DEFINITIONS = [
  "DestinyInventoryItemDefinition",
  "DestinyStatDefinition",
  "DestinyStatGroupDefinition",
  "DestinySandboxPerkDefinition",
  "DestinyPlugSetDefinition",
  "DestinyDamageTypeDefinition",
];

// Definitions large enough to need splitting. Add more here if a table
// starts approaching the limit (e.g. DestinyPlugSetDefinition someday).
const SPLIT_DEFINITIONS = new Set(["DestinyInventoryItemDefinition"]);

// Stay well under jsDelivr's ~50MB ceiling to leave margin for JSON
// overhead and future growth of the table.
const MAX_CHUNK_BYTES = 35 * 1024 * 1024;

const MANIFEST_DIR = path.join(process.cwd(), "manifest");

function sanitizeTag(version) {
  return String(version).replace(/[^A-Za-z0-9._-]/g, "-");
}

async function fetchJson(url, label) {
  try {
    const { data } = await axios.get(url, { timeout: 60_000 });
    return data;
  } catch (err) {
    throw new Error(`Failed to fetch ${label}: ${err.message}`);
  }
}

/** Split an object into byte-bounded chunks and write them + an index file. */
async function writeSplitDefinition(definition, json) {
  const dir = path.join(MANIFEST_DIR, definition);

  // Clear stale parts from a previous run before writing new ones, so a
  // shrinking table doesn't leave orphaned part files behind.
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  const entries = Object.entries(json);
  const index = {};
  let chunk = {};
  let chunkBytes = 0;
  let partNumber = 0;

  const flush = async () => {
    if (Object.keys(chunk).length === 0) return;
    const fileName = `part-${String(partNumber).padStart(3, "0")}.json`;
    await fs.writeFile(path.join(dir, fileName), JSON.stringify(chunk));
    console.log(
      `  Saved ${fileName} (${(chunkBytes / 1024 / 1024).toFixed(1)}MB, ${Object.keys(chunk).length} entries)`,
    );
    partNumber += 1;
    chunk = {};
    chunkBytes = 0;
  };

  for (const [hash, def] of entries) {
    const serialized = JSON.stringify(def);
    // +hash length + a few bytes for quotes/colon/comma overhead
    const entryBytes = Buffer.byteLength(serialized) + hash.length + 4;

    if (
      chunkBytes + entryBytes > MAX_CHUNK_BYTES &&
      Object.keys(chunk).length > 0
    ) {
      await flush();
    }

    chunk[hash] = def;
    chunkBytes += entryBytes;
    index[hash] = partNumber;
  }
  await flush();

  await fs.writeFile(path.join(dir, "index.json"), JSON.stringify(index));
  console.log(
    `  Saved index.json (${Object.keys(index).length} hashes across ${partNumber} parts)`,
  );
}

async function main() {
  await fs.mkdir(MANIFEST_DIR, { recursive: true });
  const manifestFile = path.join(MANIFEST_DIR, "manifest.json");

  let currentVersion = null;
  try {
    const current = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    currentVersion = current.version;
  } catch {
    console.log("No existing manifest found.");
  }

  console.log("Checking Bungie manifest...");
  const manifestResponse = await fetchJson(
    "https://www.bungie.net/Platform/Destiny2/Manifest/",
    "manifest index",
  );
  // Note: this GET didn't send X-API-Key in the original script either;
  // Bungie's manifest index endpoint doesn't require it, so that's fine.
  const manifest = manifestResponse.Response;
  const latestVersion = manifest.version;
  console.log(`Latest version: ${latestVersion}`);

  if (latestVersion === currentVersion) {
    console.log("Manifest is already up to date.");
    return;
  }

  console.log("Downloading new manifest...");
  const paths = manifest.jsonWorldComponentContentPaths.en;

  for (const definition of DEFINITIONS) {
    console.log(`Downloading ${definition}`);
    const url = `https://www.bungie.net${paths[definition]}`;
    const json = await fetchJson(url, definition);

    if (SPLIT_DEFINITIONS.has(definition)) {
      await writeSplitDefinition(definition, json);
    } else {
      await fs.writeFile(
        path.join(MANIFEST_DIR, `${definition}.json`),
        JSON.stringify(json),
      );
    }
    console.log(`Saved ${definition}`);
  }

  // Write the version file last, only after every definition succeeded,
  // so a failed run doesn't get marked as up-to-date.
  await fs.writeFile(
    manifestFile,
    JSON.stringify(
      { version: latestVersion, updatedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.log("Manifest updated.");

  // Git tag names can't contain arbitrary characters (spaces, ~, ^, :, etc.),
  // and Bungie's version string isn't guaranteed to be tag-safe.
  const tagName = `manifest-v${sanitizeTag(latestVersion)}`;

  try {
    execSync("git add manifest", { stdio: "inherit" });
    execSync(`git commit -m "Update Destiny manifest ${latestVersion}"`, {
      stdio: "inherit",
    });
    execSync("git push", { stdio: "inherit" });
    console.log("Changes pushed to GitHub.");

    // Tag this commit so jsDelivr can serve it as an immutable, aggressively
    // cached ref (cdn.jsdelivr.net/gh/user/repo@TAG/...). The client resolves
    // which tag to use via the small, unpinned manifest.json pointer file.
    execSync(`git tag ${tagName}`, { stdio: "inherit" });
    execSync(`git push origin ${tagName}`, { stdio: "inherit" });
    console.log(`Tagged and pushed ${tagName}.`);
  } catch {
    console.log("No git changes to commit.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
