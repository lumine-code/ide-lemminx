const path = require("node:path");
const { LiveLspClient } = require("./helpers/live-lsp-client");
const { createProject, removeProject } = require("./helpers/project");
const { exerciseServer } = require("./helpers/exercise-server");
const serverJar = process.env.LEMMINX_JAR;
const javaPath =
  process.env.JAVA_LSP_PATH ||
  (process.env.JAVA_HOME &&
    path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java"));
if (process.env.REQUIRE_LEMMINX && (!serverJar || !javaPath))
  throw new Error("CI requires a real LemMinX JAR and Java runtime.");
const liveSuite = serverJar && javaPath ? describe : () => {};
liveSuite("ide-xml real LemMinX protocol and managed pipeline", () => {
  let fixture, client, adapter, edge, timeout;
  beforeAll(() => {
    timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 90000;
  });
  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = timeout;
  });
  beforeEach(async () => {
    jasmine.useRealClock();
    fixture = createProject();
    lumine.config.set("ide-xml.serverJar", serverJar);
    lumine.config.set("ide-xml.javaPath", javaPath);
    const main = (await lumine.packages.activatePackage("ide-xml")).mainModule;
    edge = main.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        client = new LiveLspClient(value, fixture.rootPath);
        return { dispose() {} };
      },
    });
  });
  afterEach(async () => {
    await client.stop();
    edge.dispose();
    for (const key of ["serverJar", "javaPath", "fileAssociations"])
      lumine.config.unset(`ide-xml.${key}`);
    await lumine.packages.deactivatePackage("ide-xml");
    removeProject(fixture.rootPath);
  });
  it("returns all supported XML features from the actual Eclipse release", async () => {
    await client.start();
    expect((await exerciseServer(client, fixture)).length).toBe(10);
    expect(client.registrations.some(({ method }) => method === "textDocument/rename")).toBe(true);
  });
  it("installs the verified full JAR through the real managed pipeline and removes it cleanly", async () => {
    const packagePath = (await lumine.packages.loadPackage("ide-client")).path;
    const ManagedServers = require(path.join(packagePath, "lib", "managed-servers"));
    const managed = new ManagedServers(
      {
        adapters: new Map([[adapter.id, adapter]]),
        allSessions: () => [],
        reattachAll: async () => {},
      },
      { storageRoot: path.join(fixture.configDirPath, "managed") },
    );
    try {
      const record = await managed.install("ide-xml", { version: "0.31.2" });
      expect(record.checksum).toBe(
        "sha256:f4fde164e785c635e5f86361dbf4b993bfe2c5f83fdb52891d058b7dfc9bcfc8",
      );
      lumine.config.set("ide-xml.serverJar", "");
      await client.start(managed.installFor(adapter));
      expect((await exerciseServer(client, fixture)).length).toBe(10);
      await client.stop();
      await managed.uninstall("ide-xml");
      expect(managed.installFor(adapter)).toBeNull();
    } finally {
      managed.emitter.dispose();
    }
  });
  it("uses a configured file association without editing the XML declaration", async () => {
    lumine.config.set("ide-xml.fileAssociations", [
      { pattern: "associated.xml", systemId: fixture.files.schema },
    ]);
    await client.start();
    client.open(fixture.uris.associated, "xml", fixture.texts.associated);
    const diagnostic = await client.waitFor(
      () =>
        client
          .messages("textDocument/publishDiagnostics")
          .find(
            ({ params }) => params.uri === fixture.uris.associated && params.diagnostics.length,
          ),
      "associated schema validation",
    );
    expect(diagnostic.params.diagnostics[0].code).toBe("cvc-complex-type.2.4.a");
  });
});
