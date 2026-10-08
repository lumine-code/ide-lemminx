const path = require("node:path");

describe("LemMinX metadata request lifetime", () => {
  let server, controller;
  const version = "0.31.2";
  const metadata = `<metadata><release>${version}</release></metadata>`;
  const response = (text) => ({ ok: true, text: async () => text });
  function deferred() {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("ide-lemminx");
    server = require("../lib/server");
    controller = new AbortController();
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide-lemminx");
    await lumine.packages.deactivatePackage("ide");
  });
  it("does not fetch metadata for an already cancelled API", async () => {
    const fetch = spyOn(global, "fetch").and.resolveTo(response(metadata));
    controller.abort(new Error("cancelled lookup"));
    await expectAsync(
      server.latestServerVersion({ signal: controller.signal }),
    ).toBeRejectedWithError("cancelled lookup");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a cancelled lookup even when fetch completes later", async () => {
    const held = deferred();
    spyOn(global, "fetch").and.returnValue(held.promise);
    const pending = server.latestServerVersion({ signal: controller.signal });
    controller.abort(new Error("cancelled fetch"));
    held.resolve(response(metadata));
    await expectAsync(pending).toBeRejectedWithError("cancelled fetch");
  });
  it("rejects cancellation while the metadata body is pending", async () => {
    const held = deferred();
    let reading = false;
    spyOn(global, "fetch").and.resolveTo({
      ok: true,
      text() {
        reading = true;
        return held.promise;
      },
    });
    const pending = server.latestServerVersion({ signal: controller.signal });
    await conditionPromise(() => reading);
    controller.abort(new Error("cancelled body"));
    held.resolve(metadata);
    await expectAsync(pending).toBeRejectedWithError("cancelled body");
  });
  it("preserves the 30-second deadline across response-body parsing", async () => {
    const timeout = new AbortController(),
      held = deferred();
    const deadline = spyOn(AbortSignal, "timeout").and.returnValue(timeout.signal);
    let reading = false;
    spyOn(global, "fetch").and.resolveTo({
      ok: true,
      text() {
        reading = true;
        return held.promise;
      },
    });
    const pending = server.latestServerVersion({ signal: controller.signal });
    await conditionPromise(() => reading);
    timeout.abort(new Error("metadata deadline"));
    held.resolve(metadata);
    await expectAsync(pending).toBeRejectedWithError("metadata deadline");
    expect(deadline).toHaveBeenCalledOnceWith(30000);
  });
  it("keeps current HTTP and network failures visible", async () => {
    const fetch = spyOn(global, "fetch").and.resolveTo({ ok: false, status: 503 });
    await expectAsync(
      server.latestServerVersion({ signal: controller.signal }),
    ).toBeRejectedWithError(/Eclipse answered 503/);
    fetch.and.rejectWith(new Error("network offline"));
    await expectAsync(
      server.latestServerVersion({ signal: controller.signal }),
    ).toBeRejectedWithError("network offline");
  });
  it("does not download or validate a JAR after artifact metadata cancellation", async () => {
    const held = deferred();
    let reading = false;
    spyOn(global, "fetch").and.resolveTo({
      ok: true,
      text() {
        reading = true;
        return held.promise;
      },
    });
    const storagePath = path.join(lumine.getConfigDirPath(), "unused-jar-stage");
    const api = {
      signal: controller.signal,
      setServerInstallationStatus() {},
      downloadFile: jasmine.createSpy("download").and.resolveTo(),
    };
    spyOn(server, "validateJar").and.resolveTo("unused.jar");
    const pending = server.installServer({ storagePath, version, api });
    await conditionPromise(() => reading);
    controller.abort(new Error("cancelled metadata"));
    held.resolve(
      JSON.stringify({
        items: [
          {
            downloadUrl: `https://repo.eclipse.org/repository/lemminx-maven2-releases/org/eclipse/lemminx/org.eclipse.lemminx/${version}/org.eclipse.lemminx-${version}-uber.jar`,
            maven2: { extension: "jar", version },
            checksum: { sha256: "a".repeat(64) },
          },
        ],
      }),
    );
    await expectAsync(pending).toBeRejectedWithError("cancelled metadata");
    expect(api.downloadFile).not.toHaveBeenCalled();
    expect(server.validateJar).not.toHaveBeenCalled();
  });
  for (const mode of ["caller cancellation", "adapter withdrawal"]) {
    it(`cancels the real managed-server lookup transport on ${mode}`, async () => {
      await lumine.packages.deactivatePackage("ide-lemminx");
      const ide = (await lumine.packages.activatePackage("ide")).mainModule;
      await lumine.packages.activatePackage("ide-lemminx");
      const managed = ide.ensureManagedServers(),
        held = deferred();
      let signal;
      spyOn(global, "fetch").and.callFake((_url, options) => {
        signal = options.signal;
        return held.promise;
      });
      const pending = managed.latestVersion(managed.adapterFor("ide-lemminx"), {
        force: true,
        signal: controller.signal,
      });
      await conditionPromise(() => signal);
      if (mode === "caller cancellation") controller.abort();
      else await lumine.packages.deactivatePackage("ide-lemminx");
      await expectAsync(pending).toBeRejected();
      expect(signal.aborted).toBe(true);
      held.resolve(response(metadata));
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      expect(managed.latest.has("ide-lemminx")).toBe(false);
    });
  }
});
