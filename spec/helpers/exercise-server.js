const assert = require("node:assert/strict");
const { position } = require("./project");
const exerciseServer = async (client, fixture) => {
  for (const key of [
    "schema",
    "main",
    "incomplete",
    "broken",
    "dtdDocument",
    "dtdBroken",
    "malformed",
  ])
    client.open(fixture.uris[key], "xml", fixture.texts[key]);
  const request = (method, key, extra = {}) =>
    client.request(method, { textDocument: { uri: fixture.uris[key] }, ...extra });
  const diagnostic = async (key) =>
    client.waitFor(
      () =>
        client
          .messages("textDocument/publishDiagnostics")
          .find(({ params }) => params.uri === fixture.uris[key] && params.diagnostics.length)
          ?.params.diagnostics,
      `${key} diagnostics`,
    );
  const completion = await request("textDocument/completion", "incomplete", {
    position: position(fixture.texts.incomplete, "<ti", 3),
  });
  assert(completion.items.some(({ label }) => label === "title"));
  assert(
    JSON.stringify(
      await request("textDocument/hover", "main", {
        position: position(fixture.texts.main, "<book", 2),
      }),
    ).includes("A documented book"),
  );
  const definition = await request("textDocument/typeDefinition", "main", {
    position: position(fixture.texts.main, "<book", 2),
  });
  assert(definition.some((item) => (item.uri || item.targetUri) === fixture.uris.schema));
  const references = await request("textDocument/references", "schema", {
    position: position(fixture.texts.schema, 'name="book"', 8),
    context: { includeDeclaration: true },
  });
  assert(references.some(({ range }) => range.start.line === 8));
  const symbols = await request("textDocument/documentSymbol", "main");
  assert(symbols.some(({ name }) => name === "book"));
  assert(
    (
      await request("textDocument/formatting", "main", {
        options: { tabSize: 2, insertSpaces: true },
      })
    ).some(({ newText }) => newText.includes("\n")),
  );
  assert(
    (
      await request("textDocument/rangeFormatting", "main", {
        range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
        options: { tabSize: 2, insertSpaces: true },
      })
    ).length,
  );
  const rename = await request("textDocument/rename", "main", {
    position: position(fixture.texts.main, "<title", 2),
    newName: "heading",
  });
  assert.equal(rename.documentChanges[0].edits.length, 2);
  assert.equal(
    rename.documentChanges[0].edits[1].range.start.character,
    position(fixture.texts.main, "</title", 2).character,
  );
  assert((await diagnostic("broken")).some(({ code }) => code === "cvc-complex-type.2.4.a"));
  assert((await diagnostic("dtdBroken")).some(({ code }) => code === "MSG_ELEMENT_NOT_DECLARED"));
  const errors = await diagnostic("malformed");
  const actions = await request("textDocument/codeAction", "malformed", {
    range: errors[0].range,
    context: { diagnostics: errors },
  });
  assert(
    actions.some(({ edit }) =>
      edit?.documentChanges?.[0]?.edits.some(({ newText }) => newText === "book"),
    ),
  );
  const before = client.notifications.length;
  client.change(
    fixture.uris.broken,
    fixture.texts.broken.replace("<wrong/>", "<title>Ada</title>"),
  );
  await client.waitFor(
    () =>
      client.notifications
        .slice(before)
        .some(
          ({ method, params }) =>
            method === "textDocument/publishDiagnostics" &&
            params.uri === fixture.uris.broken &&
            params.diagnostics.length === 0,
        ),
    "cleared XSD diagnostics",
  );
  return [
    "schema completion",
    "schema hover",
    "schema type definition",
    "XSD references",
    "symbols",
    "document and range format",
    "Unicode tag rename",
    "XSD and DTD validation",
    "XML code action",
    "incremental diagnostics",
  ];
};
module.exports = { exerciseServer };
