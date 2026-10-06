const { Point } = require("lumine");
const { createProject, removeProject, position } = require("./helpers/project");
const path = require("node:path");
const serverJar = process.env.LEMMINX_JAR;
const javaPath =
  process.env.JAVA_LSP_PATH ||
  (process.env.JAVA_HOME &&
    path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java"));
const liveSuite = serverJar && javaPath ? describe : () => {};
const until = async (check, label) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out`);
};
liveSuite("ide-lemminx actual editor providers", () => {
  let fixture, editors, paths, service, timeout, published, subscription;
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
    editors = {};
    paths = lumine.project.getPaths();
    published = [];
    lumine.config.set("ide-lemminx.serverJar", serverJar);
    lumine.config.set("ide-lemminx.javaPath", javaPath);
    for (const name of ["language-xml", "ide-client", "ide-lemminx"])
      await lumine.packages.activatePackage(name);
    service = lumine.packages.getActivePackage("ide-client").mainModule.provideIdeClient();
    subscription = service.onDidPublishDiagnostics((value) => published.push(value));
    lumine.project.setPaths([fixture.rootPath]);
    for (const key of ["main", "schema", "incomplete", "broken", "dtdBroken", "malformed", "xsl"]) {
      editors[key] = await lumine.workspace.open(fixture.files[key]);
      editors[key].setGrammar(
        lumine.grammars.grammarForScopeName(key === "xsl" ? "text.xml.xsl" : "text.xml"),
      );
    }
  });
  afterEach(async () => {
    subscription.dispose();
    for (const editor of Object.values(editors)) editor?.destroy();
    for (const editor of lumine.workspace.getTextEditors())
      if (editor.getPath()?.startsWith(fixture.rootPath)) editor.destroy();
    for (const name of ["ide-lemminx", "ide-client", "language-xml"])
      await lumine.packages.deactivatePackage(name);
    for (const key of [
      "serverJar",
      "javaPath",
      "features.format",
      "features.rename",
      "features.hover",
      "features.diagnostics",
      "features.codeActions",
      "features.autocomplete",
      "features.references",
      "features.symbols",
      "features.definition",
    ])
      lumine.config.unset(`ide-lemminx.${key}`);
    lumine.project.setPaths(paths);
    await lumine.fileWatchClient.settlePendingTeardown();
    removeProject(fixture.rootPath);
  });
  const point = (key, fragment, inside = 1) => {
    const p = position(fixture.texts[key], fragment, inside);
    return new Point(p.line, p.character);
  };
  const main = () => lumine.packages.getActivePackage("ide-client").mainModule;
  const ready = async () => {
    const session = await until(
      async () =>
        (await service.activeSessionsForEditor(editors.main)).find(
          ({ adapter }) => adapter.id === "ide-lemminx",
        ),
      "XML session",
    );
    await until(
      () => session.supports("textDocument/hover", editors.main),
      "XML dynamic capabilities",
    );
    return session;
  };
  it("routes schema completion, hover, references, symbols, formatting and Unicode rename", async () => {
    await ready();
    const m = main();
    const suggestions = await m.provideAutocomplete().getSuggestions({
      editor: editors.incomplete,
      bufferPosition: point("incomplete", "<ti", 3),
      prefix: "ti",
      activatedManually: true,
    });
    expect(
      suggestions.some(({ displayText, text, snippet }) =>
        (displayText || text || snippet || "").includes("title"),
      ),
    ).toBe(true);
    expect(
      JSON.stringify(await m.provideContextHelp().getHelp(editors.main, point("main", "<book", 2))),
    ).toContain("A documented book");
    const refs = await m
      .provideFindReferences()
      .findReferences(editors.schema, point("schema", 'name="book"', 8));
    expect(refs.references.some(({ path }) => path === fixture.files.schema)).toBe(true);
    const definitions = await m.provideDefinitionProvider().getDefinitions(editors.schema, {
      range: { start: point("schema", 'ref="book"', 6) },
    });
    expect(
      definitions.some(
        ({ path, position }) =>
          path === fixture.files.schema && Point.fromObject(position).row === 2,
      ),
    ).toBe(true);
    const documentSymbols = m.provideDocumentSymbolProvider();
    expect(
      documentSymbols
        .getDocumentSymbolSources(editors.main)
        .find(({ id }) => id === "ide-client:ide-lemminx").state,
    ).toBe("ready");
    expect(
      (
        await documentSymbols.getDocumentSymbols(editors.main, {
          sourceId: "ide-client:ide-lemminx",
        })
      ).some(({ name }) => name === "book"),
    ).toBe(true);
    expect((await m.provideCodeFormatFile().formatEntireFile(editors.main)).length).toBeGreaterThan(
      0,
    );
    expect(
      (
        await m.provideCodeFormatRange().formatCode(editors.main, [
          [0, 0],
          [1, 0],
        ])
      ).length,
    ).toBeGreaterThan(0);
    const rename = await m
      .provideRefactor()
      .rename(editors.main, point("main", "<title", 2), "heading", { dryRun: true });
    expect(rename.outcome).toBe("edits");
    const edits = rename.edits.get(fixture.files.main);
    expect(edits.length).toBe(2);
    expect(Point.fromObject(edits[1].oldRange.start || edits[1].oldRange[0]).column).toBe(
      position(fixture.texts.main, "</title", 2).character,
    );
    expect(service.adaptersForEditor(editors.xsl).map(({ id }) => id)).toContain("ide-lemminx");
  });
  it("applies a genuine XML quick fix and honours feature switches", async () => {
    const session = await ready(),
      m = main();
    await until(
      () =>
        published.some(
          ({ uri, diagnostics }) => uri === fixture.uris.malformed && diagnostics.length,
        ),
      "malformed XML diagnostics",
    );
    const actions = await m
      .provideIntentionsList()
      .getIntentions({ textEditor: editors.malformed, bufferPosition: new Point(0, 2) });
    const fix = actions.find(({ title }) => title.includes("Replace 'bok'"));
    expect(fix).toBeTruthy();
    await fix.selected();
    expect(editors.malformed.getText()).toContain("</book>");
    lumine.config.set("ide-lemminx.features.format", false);
    expect(await m.provideCodeFormatFile().formatEntireFile(editors.main)).toBeNull();
    lumine.config.set("ide-lemminx.features.rename", false);
    expect(
      await m.provideRefactor().rename(editors.main, point("main", "<title", 2), "heading"),
    ).toBeNull();
    lumine.config.set("ide-lemminx.features.hover", false);
    expect(
      await m.provideContextHelp().getHelp(editors.main, point("main", "<book", 2)),
    ).toBeNull();
    expect(session.supports("textDocument/hover", editors.main)).toBe(false);
    expect(session.supports("textDocument/codeLens", editors.main)).toBe(false);
    for (const [feature, method] of [
      ["autocomplete", "textDocument/completion"],
      ["references", "textDocument/references"],
      ["symbols", "textDocument/documentSymbol"],
      ["definition", "textDocument/definition"],
      ["codeActions", "textDocument/codeAction"],
    ]) {
      lumine.config.set(`ide-lemminx.features.${feature}`, false);
      expect(session.supports(method, editors.main)).toBe(false);
    }
    expect(
      await m.provideAutocomplete().getSuggestions({
        editor: editors.incomplete,
        bufferPosition: point("incomplete", "<ti", 3),
        prefix: "ti",
        activatedManually: true,
      }),
    ).toEqual([]);
    expect(
      await m
        .provideFindReferences()
        .findReferences(editors.schema, point("schema", 'name="book"', 8)),
    ).toBeNull();
    expect(
      await m.provideDocumentSymbolProvider().getDocumentSymbols(editors.main, {
        sourceId: "ide-client:ide-lemminx",
      }),
    ).toBeNull();
    expect(
      await m.provideDefinitionProvider().getDefinitions(editors.schema, {
        range: { start: point("schema", 'ref="book"', 6) },
      }),
    ).toBeNull();
    expect(
      await m
        .provideIntentionsList()
        .getIntentions({ textEditor: editors.malformed, bufferPosition: new Point(0, 2) }),
    ).toEqual([]);
    lumine.config.set("ide-lemminx.features.diagnostics", false);
    expect(service.featureEnabled(session.adapter, "diagnostics", editors.broken)).toBe(false);
  });
  it("publishes XSD and DTD diagnostics, clears edits and restarts an unloaded generation", async () => {
    const previous = await ready();
    for (const key of ["broken", "dtdBroken"])
      await until(
        () =>
          published.some(({ uri, diagnostics }) => uri === fixture.uris[key] && diagnostics.length),
        `${key} validation`,
      );
    const before = published.length;
    editors.broken.setText(fixture.texts.broken.replace("<wrong/>", "<title>Ada</title>"));
    await until(
      () =>
        published
          .slice(before)
          .some(({ uri, diagnostics }) => uri === fixture.uris.broken && diagnostics.length === 0),
      "cleared XML diagnostics",
    );
    const pkg = lumine.packages.getActivePackage("ide-lemminx"),
      oldMain = pkg.mainModule,
      packagePath = pkg.path;
    await lumine.packages.deactivatePackage("ide-lemminx");
    await until(() => previous.state === "stopped", "XML teardown");
    expect(service.adaptersForEditor(editors.main)).toEqual([]);
    await lumine.packages.unloadPackage("ide-lemminx");
    await lumine.packages.loadPackage(packagePath);
    expect((await lumine.packages.activatePackage("ide-lemminx")).mainModule).not.toBe(oldMain);
    expect(await ready()).not.toBe(previous);
  });
});
