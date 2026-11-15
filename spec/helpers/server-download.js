const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Standalone CI/test orchestration uses the same client's GET retry policy.
module.exports = async (url, target, { digest, signal } = {}) => {
  signal?.throwIfAborted();
  if (!/^sha256:[a-f0-9]{64}$/i.test(digest || ""))
    throw new Error("A SHA-256 digest is required.");
  const clientPath = process.env.LUMINE_TEST_IDE_PATH;
  if (!clientPath) throw new Error("Standalone downloads require LUMINE_TEST_IDE_PATH.");
  const fetchWithRetry = require(path.join(clientPath, "lib", "fetch-retry"));
  const { response, value: payload } = await fetchWithRetry(
    (...args) => fetch(...args),
    url,
    { signal },
    async (result) => Buffer.from(await result.arrayBuffer()),
  );
  if (!response.ok) throw new Error(`Eclipse answered ${response.status} for ${url}.`);
  signal?.throwIfAborted();
  const actual = `sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`;
  if (actual !== digest.toLowerCase())
    throw new Error("Downloaded LemMinX SHA-256 does not match.");
  const file = await fs.promises.open(target, "wx");
  let complete = false;
  try {
    signal?.throwIfAborted();
    await file.writeFile(payload);
    signal?.throwIfAborted();
    complete = true;
  } finally {
    await file.close();
    if (!complete) await fs.promises.unlink(target);
  }
};
