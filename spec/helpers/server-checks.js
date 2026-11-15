const { resolutionContext } = require("./server-resolution");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const server = require("../../lib/server");
const downloadFile = require("./server-download");
const { createProject, removeProject } = require("./project");
const { LiveLspClient } = require("./live-lsp-client");
const { exerciseServer } = require("./exercise-server");
const clientConfiguration = () => {
  const clientPath = process.env.LUMINE_TEST_IDE_PATH;
  if (!clientPath)
    throw new Error("Standalone server checks require LUMINE_TEST_IDE_PATH to name ide.");
  return require(path.join(clientPath, "lib", "workspace-configuration"));
};
if (process.env.REQUIRE_LEMMINX) clientConfiguration();
test("reject relative paths, directories, invalid JARs and unstable versions", async () => {
  const fixture = createProject();
  try {
    assert.throws(() => server.stableVersion("0.32.0-SNAPSHOT"), /stable/);
    await assert.rejects(server.validateJava("java"), /absolute/);
    await assert.rejects(server.validateJar(fixture.rootPath), /JAR file/);
    fs.writeFileSync(path.join(fixture.rootPath, "bad.jar"), "bad");
    await assert.rejects(server.validateJar(path.join(fixture.rootPath, "bad.jar")), /archive/);
    if (process.env.LUMINE_TEST_IDE_PATH) {
      assert.equal(
        (await server.resolveJar(resolutionContext({ managedServer: null }), "", {}))?.path ?? null,
        null,
      );
      assert.equal(
        (await server.resolveJava(resolutionContext(), "", { PATH: "" }))?.path ?? null,
        null,
      );
    }
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

const mirror =
  "https://download.eclipse.org/releases/2026-09/202609091000/plugins/org.eclipse.lemminx.uber-jar_0.31.2.jar";
const digest = "sha256:f4fde164e785c635e5f86361dbf4b993bfe2c5f83fdb52891d058b7dfc9bcfc8";
test("uses the reviewed identical release after Nexus 503 without disguising the outage", async () => {
  const oldFetch = global.fetch,
    oldWarn = console.warn,
    warnings = [],
    calls = [],
    fixture = createProject();
  try {
    global.fetch = async () => ({ ok: false, status: 503 });
    console.warn = (message) => warnings.push(message);
    assert.equal(await server.latestServerVersion(), "0.31.2");
    const installed = await server.installServer({
      storagePath: fixture.rootPath,
      version: "0.31.2",
      api: {
        setServerInstallationStatus() {},
        async downloadFile(url, target, options) {
          calls.push({ url, target, options });
          fs.writeFileSync(target, Buffer.from([0x50, 0x4b, 3, 4]));
        },
      },
    });
    assert.equal(installed.metadataSource, "reviewed-eclipse-simrel");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, mirror);
    assert.equal(calls[0].options.digest, digest);
    assert.equal(installed.version, "0.31.2");
    assert.equal(installed.module, "org.eclipse.lemminx-0.31.2-uber.jar");
    assert.equal(warnings.length, 2);
    assert(
      warnings.every((message) => /Eclipse answered 503.*reviewed Eclipse SimRel/.test(message)),
    );
  } finally {
    global.fetch = oldFetch;
    console.warn = oldWarn;
    removeProject(fixture.rootPath);
  }
});
test("does not substitute the reviewed release for permanent, malformed or mismatched metadata", async () => {
  const oldFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, status: 404 });
    await assert.rejects(server.resolveServerRelease("0.31.2"), /Eclipse answered 404/);
    global.fetch = async () => ({ ok: true, text: async () => "not JSON" });
    await assert.rejects(server.resolveServerRelease("0.31.2"), SyntaxError);
    global.fetch = async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          items: [
            {
              downloadUrl:
                "https://repo.eclipse.org/repository/lemminx-maven2-releases/org/eclipse/lemminx/org.eclipse.lemminx/0.31.2/org.eclipse.lemminx-0.31.2-uber.jar",
              maven2: { extension: "jar", version: "0.31.2" },
              checksum: { sha256: "a".repeat(64) },
            },
          ],
        }),
    });
    await assert.rejects(server.resolveServerRelease("0.31.2"), /does not match the reviewed/);
    global.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(server.resolveServerRelease("0.32.0"), /Eclipse answered 503/);
  } finally {
    global.fetch = oldFetch;
  }
});
test("does not enter metadata fallback after cancellation", async () => {
  const oldFetch = global.fetch,
    oldWarn = console.warn,
    controller = new AbortController();
  let warning = false,
    release;
  try {
    global.fetch = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    console.warn = () => {
      warning = true;
    };
    const pending = server.resolveServerRelease("0.31.2", { signal: controller.signal });
    controller.abort(new Error("cancelled lookup"));
    release({ ok: false, status: 503 });
    await assert.rejects(pending, /cancelled lookup/);
    assert.equal(warning, false);
  } finally {
    global.fetch = oldFetch;
    console.warn = oldWarn;
  }
});
if (process.env.LUMINE_TEST_IDE_PATH) {
  test("fails when the official mirror is also unavailable without creating an artifact", async () => {
    const oldFetch = global.fetch,
      oldWarn = console.warn,
      urls = [],
      fixture = createProject();
    try {
      console.warn = () => {};
      global.fetch = async (url) => {
        urls.push(url);
        return { ok: false, status: 503 };
      };
      await assert.rejects(
        server.installServer({
          storagePath: fixture.rootPath,
          version: "0.31.2",
          api: { downloadFile, setServerInstallationStatus() {} },
        }),
        /Eclipse answered 503.*download\.eclipse\.org/,
      );
      assert.equal(urls.filter((url) => url === mirror).length, 3);
      assert.equal(
        fs.existsSync(path.join(fixture.rootPath, "org.eclipse.lemminx-0.31.2-uber.jar")),
        false,
      );
    } finally {
      global.fetch = oldFetch;
      console.warn = oldWarn;
      removeProject(fixture.rootPath);
    }
  });
  test("rejects a payload checksum mismatch before writing and without retrying integrity failure", async () => {
    const oldFetch = global.fetch,
      fixture = createProject();
    let calls = 0;
    try {
      global.fetch = async () => {
        calls++;
        return { ok: true, status: 200, arrayBuffer: async () => Buffer.from("wrong jar") };
      };
      const target = path.join(fixture.rootPath, "unaccepted.jar");
      await assert.rejects(downloadFile(mirror, target, { digest }), /SHA-256 does not match/);
      assert.equal(calls, 1);
      assert.equal(fs.existsSync(target), false);
    } finally {
      global.fetch = oldFetch;
      removeProject(fixture.rootPath);
    }
  });
  test("rejects cancellation while the payload body completes without writing an artifact", async () => {
    const oldFetch = global.fetch,
      fixture = createProject(),
      controller = new AbortController();
    const bodyStarted = Promise.withResolvers();
    let release;
    try {
      const body = new Promise((resolve) => {
        release = resolve;
      });
      global.fetch = async () => ({
        ok: true,
        status: 200,
        arrayBuffer: () => {
          bodyStarted.resolve();
          return body;
        },
      });
      const target = path.join(fixture.rootPath, "cancelled.jar"),
        pending = downloadFile(mirror, target, { digest, signal: controller.signal });
      await Promise.race([bodyStarted.promise, pending]);
      controller.abort(new Error("cancelled body"));
      release(Buffer.from("late body"));
      await assert.rejects(pending, /cancelled body/);
      assert.equal(fs.existsSync(target), false);
    } finally {
      global.fetch = oldFetch;
      removeProject(fixture.rootPath);
    }
  });
  test("standalone configuration uses the actual client API without an editor global", async () => {
    const fixture = createProject();
    try {
      const client = new LiveLspClient(
        { getSettings: async () => ({ xml: { validation: { enabled: false } } }) },
        fixture.rootPath,
        { configurationApi: clientConfiguration() },
      );
      assert.deepEqual(
        await client.configuration([{ section: "xml.validation" }, { section: "constructor" }]),
        [{ enabled: false }, null],
      );
      assert.equal(client.configurationContext().rootPath, fixture.rootPath);
    } finally {
      removeProject(fixture.rootPath);
    }
  });
}
if (process.env.REQUIRE_LEMMINX) {
  test(
    "install and exercise the real checksum-verified universal server",
    { timeout: 90000 },
    async (context) => {
      const fixture = createProject();
      let client;
      try {
        const configurationApi = clientConfiguration();
        fs.mkdirSync(fixture.configDirPath);
        const installed = await server.installServer({
          storagePath: fixture.configDirPath,
          version: "0.31.2",
          api: {
            setServerInstallationStatus() {},
            downloadFile: (url, target, options) =>
              downloadFile(url, target, { ...options, signal: context.signal }),
          },
        });
        assert.match(installed.checksum, /^sha256:/);
        client = new LiveLspClient(
          {
            displayName: "LemMinX",
            resolveServer: (context) =>
              server.resolveServer(
                resolutionContext({ ...context, configDirPath: fixture.configDirPath }),
                { javaPath: process.env.JAVA_LSP_PATH || "" },
              ),
            getSettings: () => ({
              xml: { validation: { noGrammar: "ignore" }, codeLens: { enabled: false } },
            }),
          },
          fixture.rootPath,
          { configurationApi },
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
