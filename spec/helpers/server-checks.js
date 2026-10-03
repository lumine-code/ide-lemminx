const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const test = require("node:test");
const server = require("../../lib/server");
const { createProject, removeProject } = require("./project");
const { LiveLspClient } = require("./live-lsp-client");
const { exerciseServer } = require("./exercise-server");
test("reject relative paths, directories, invalid JARs and unstable versions", async () => {
  const fixture = createProject();
  try {
    assert.throws(() => server.stableVersion("0.32.0-SNAPSHOT"), /stable/);
    await assert.rejects(server.validateJava("java"), /absolute/);
    await assert.rejects(server.validateJar(fixture.rootPath), /JAR file/);
    fs.writeFileSync(path.join(fixture.rootPath, "bad.jar"), "bad");
    await assert.rejects(server.validateJar(path.join(fixture.rootPath, "bad.jar")), /archive/);
    assert.equal(await server.resolveJar("", null, {}), null);
    assert.equal(await server.resolveJava("", { PATH: "" }), null);
  } finally {
    removeProject(fixture.rootPath);
  }
});
test("reject absent or mismatched Maven digests before a download", async () => {
  const old = server.fetchText;
  try {
    server.fetchText = async () =>
      JSON.stringify({
        items: [
          { downloadUrl: "https://example.com/payload.jar", checksum: { sha256: "a".repeat(64) } },
        ],
      });
    await assert.rejects(
      server.installServer({
        storagePath: path.resolve("unused"),
        version: "0.31.2",
        api: {
          setServerInstallationStatus() {},
          downloadFile() {
            throw new Error("must not download");
          },
        },
      }),
      /SHA-256/,
    );
    server.fetchText = async () => "<metadata><release>0.31.2</release></metadata>";
    assert.equal(await server.latestServerVersion(), "0.31.2");
  } finally {
    server.fetchText = old;
  }
});
if (process.env.REQUIRE_LEMMINX) {
  test(
    "install and exercise the real checksum-verified universal server",
    { timeout: 90000 },
    async () => {
      const fixture = createProject();
      let client;
      try {
        fs.mkdirSync(fixture.configDirPath);
        const installed = await server.installServer({
          storagePath: fixture.configDirPath,
          version: "0.31.2",
          api: {
            setServerInstallationStatus() {},
            async downloadFile(url, target, { digest }) {
              const response = await fetch(url);
              assert(response.ok);
              const payload = Buffer.from(await response.arrayBuffer());
              assert.equal(
                `sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`,
                digest,
              );
              fs.writeFileSync(target, payload);
            },
          },
        });
        assert.match(installed.checksum, /^sha256:/);
        client = new LiveLspClient(
          {
            displayName: "LemMinX",
            resolveServer: (context) =>
              server.resolveServer({
                javaPath: process.env.JAVA_LSP_PATH || "",
                context: { ...context, configDirPath: fixture.configDirPath },
              }),
            getSettings: () => ({
              xml: { validation: { noGrammar: "ignore" }, codeLens: { enabled: false } },
            }),
          },
          fixture.rootPath,
        );
        await client.start({
          version: installed.version,
          modulePath: path.join(fixture.configDirPath, installed.module),
        });
        assert.equal((await exerciseServer(client, fixture)).length, 10);
      } finally {
        await client?.stop();
        removeProject(fixture.rootPath);
      }
    },
  );
}
