const { resolutionContext } = require("./helpers/server-resolution");
const fs = require("node:fs");
const path = require("node:path");
const { createProject, removeProject } = require("./helpers/project");
describe("ide-lemminx discovery and managed metadata", () => {
  let fixture, server;
  beforeEach(async () => {
    jasmine.useRealClock();
    fixture = createProject();
    await lumine.packages.activatePackage("ide-lemminx");
    server = require("../lib/server");
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide-lemminx");
    removeProject(fixture.rootPath);
  });
  it("validates supported Java runtimes and explicit paths", async () => {
    spyOn(server, "javaMajorVersion").and.resolveTo(21);
    expect(
      (await server.resolveJava(resolutionContext(), process.execPath, { PATH: "" }))?.path ?? null,
    ).toBe(process.execPath);
    await expectAsync(server.resolveJava(resolutionContext(), "java")).toBeRejectedWithError(
      /absolute/,
    );
    await expectAsync(
      server.resolveJava(resolutionContext(), fixture.rootPath),
    ).toBeRejectedWithError(/executable/);
    server.javaMajorVersion.and.resolveTo(8);
    await expectAsync(
      server.resolveJava(resolutionContext(), process.execPath),
    ).toBeRejectedWithError(/Java 11/);
  });
  it("skips an unsupported Java runtime rather than hiding a later one", async () => {
    const directories = ["old", "new"].map((name) => path.join(fixture.rootPath, name));
    const executable = process.platform === "win32" ? "java.exe" : "java";
    for (const directory of directories) {
      fs.mkdirSync(directory);
      fs.copyFileSync(process.execPath, path.join(directory, executable));
    }
    spyOn(server, "javaMajorVersion").and.callFake(async (command) =>
      command.startsWith(directories[0]) ? 8 : 11,
    );
    expect(
      (
        await server.resolveJava(resolutionContext(), "", {
          PATH: directories.join(path.delimiter),
        })
      )?.path ?? null,
    ).toBe(path.join(directories[1], executable));
  });
  it("prefers explicit, managed, then environment JARs and checks archive signatures", async () => {
    const jars = ["explicit", "managed", "environment"].map((name) =>
      path.join(fixture.rootPath, `${name}.jar`),
    );
    for (const jar of jars) fs.writeFileSync(jar, Buffer.from([0x50, 0x4b, 3, 4]));
    const managed = { modulePath: jars[1] },
      env = { LEMMINX_JAR: jars[2] };
    expect(
      (await server.resolveJar(resolutionContext({ managedServer: managed }), jars[0], env))
        ?.path ?? null,
    ).toBe(jars[0]);
    expect(
      (await server.resolveJar(resolutionContext({ managedServer: managed }), "", env))?.path ??
        null,
    ).toBe(jars[1]);
    expect(
      (await server.resolveJar(resolutionContext({ managedServer: null }), "", env))?.path ?? null,
    ).toBe(jars[2]);
    fs.writeFileSync(jars[0], "not a jar");
    await expectAsync(
      server.resolveJar(resolutionContext({ managedServer: managed }), jars[0], env),
    ).toBeRejectedWithError(/archive/);
  });
  it("selects stable Maven metadata and refuses previews", async () => {
    spyOn(server, "fetchText").and.resolveTo("<metadata><release>0.31.2</release></metadata>");
    expect(await server.latestServerVersion()).toBe("0.31.2");
    expect(() => server.stableVersion("0.32.0-SNAPSHOT")).toThrowError(/stable/);
    server.fetchText.and.resolveTo("<metadata/>");
    await expectAsync(server.latestServerVersion()).toBeRejectedWithError(/stable release/);
  });
  it("downloads only the immutable complete artifact with its exact published SHA256", async () => {
    const url =
      "https://repo.eclipse.org/repository/lemminx-maven2-releases/org/eclipse/lemminx/org.eclipse.lemminx/0.31.2/org.eclipse.lemminx-0.31.2-uber.jar";
    spyOn(server, "fetchText").and.resolveTo(
      JSON.stringify({
        items: [
          {
            downloadUrl: url,
            maven2: { extension: "jar", version: "0.31.2" },
            checksum: { sha256: "a".repeat(64) },
          },
        ],
      }),
    );
    const downloadFile = jasmine
      .createSpy("downloadFile")
      .and.callFake(async (_url, target) =>
        fs.writeFileSync(target, Buffer.from([0x50, 0x4b, 3, 4])),
      );
    const installed = await server.installServer({
      storagePath: fixture.rootPath,
      version: "0.31.2",
      api: { downloadFile, setServerInstallationStatus() {} },
    });
    expect(downloadFile.calls.mostRecent().args).toEqual([
      url,
      path.join(fixture.rootPath, installed.module),
      { type: "uncompressed", digest: `sha256:${"a".repeat(64)}` },
    ]);
    expect(installed.module).toBe("org.eclipse.lemminx-0.31.2-uber.jar");
    server.fetchText.and.resolveTo(JSON.stringify({ items: [] }));
    await expectAsync(
      server.installServer({
        storagePath: fixture.rootPath,
        version: "0.31.2",
        api: { downloadFile, setServerInstallationStatus() {} },
      }),
    ).toBeRejectedWithError(/SHA-256/);
    expect(downloadFile.calls.count()).toBe(1);
  });
});
describe("ide-lemminx service edges and settings", () => {
  let main, adapter, edge, cleanup;
  beforeEach(async () => {
    main = (await lumine.packages.activatePackage("ide-lemminx")).mainModule;
    cleanup = jasmine.createSpy("cleanup");
    edge = main.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        return { dispose: cleanup };
      },
    });
  });
  afterEach(async () => {
    edge.dispose();
    for (const key of ["catalogs", "fileAssociations", "splitAttributes"])
      lumine.config.unset(`ide-lemminx.${key}`);
    await lumine.packages.deactivatePackage("ide-lemminx");
  });
  it("serves XML and XSL without advertising unsupported settings", () => {
    expect(adapter.grammarScopes).toEqual(["text.xml", "text.xml.xsl"]);
    const features = require("../package.json").configSchema.features.properties;
    for (const feature of [
      "signature",
      "callHierarchy",
      "typeHierarchy",
      "codeLens",
      "inlayHints",
      "semanticTokens",
    ]) {
      expect(adapter.isFeatureAvailable(feature)).toBe(false);
      expect(features[feature]).toBeUndefined();
    }
    expect(adapter.isFeatureAvailable("rename")).toBe(true);
    expect(main.provideBackgroundTips().packageName).toBe("ide-lemminx");
  });
  it("preserves upstream formatting defaults and forwards schema overrides", () => {
    expect(adapter.getSettings().xml.format).toBeUndefined();
    expect(adapter.getSettings().xml.validation.noGrammar).toBe("ignore");
    lumine.config.set("ide-lemminx.catalogs", ["catalog.xml"]);
    lumine.config.set("ide-lemminx.fileAssociations", [
      { pattern: "document.xml", systemId: "schema.xsd" },
    ]);
    lumine.config.set("ide-lemminx.splitAttributes", "yes");
    expect(adapter.getSettings().xml.catalogs).toEqual(["catalog.xml"]);
    expect(adapter.getSettings().xml.fileAssociations[0].systemId).toBe("schema.xsd");
    expect(adapter.getSettings().xml.format.splitAttributes).toBe(true);
    expect(adapter.getInitializationOptions().settings).toEqual(adapter.getSettings());
    expect(adapter.getWorkspaceConfiguration).toBeUndefined();
  });
  it("disposes only its provider edge and reacquires the current package generation", async () => {
    const secondCleanup = jasmine.createSpy("second cleanup");
    const second = main.consumeIdeClient({
      registerAdapter() {
        return { dispose: secondCleanup };
      },
    });
    edge.dispose();
    expect(cleanup).toHaveBeenCalled();
    expect(secondCleanup).not.toHaveBeenCalled();
    second.dispose();
    const packagePath = lumine.packages.getActivePackage("ide-lemminx").path;
    await lumine.packages.deactivatePackage("ide-lemminx");
    await lumine.packages.unloadPackage("ide-lemminx");
    await lumine.packages.loadPackage(packagePath);
    const current = (await lumine.packages.activatePackage("ide-lemminx")).mainModule;
    expect(current).not.toBe(main);
    expect(current.provideBackgroundTips().packageName).toBe("ide-lemminx");
  });
  it("reports missing dependencies through the client", async () => {
    spyOn(require("../lib/server"), "resolveServer").and.resolveTo(null);
    const missing = jasmine.createSpy("missing");
    let registered;
    const registration = main.consumeIdeClient({
      registerAdapter(value) {
        registered = value;
        return { dispose() {} };
      },
      reportMissingServer: missing,
    });
    try {
      expect(await registered.resolveServer({ rootPath: "/project" })).toBeNull();
      expect(missing.calls.mostRecent().args[0]).toBe("ide-lemminx");
    } finally {
      registration.dispose();
    }
  });
});
