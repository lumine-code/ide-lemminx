const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const createProject = () => {
  const temporaryRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ide-xml-"));
  const rootPath = path.join(temporaryRoot, "project");
  fs.mkdirSync(rootPath);
  const texts = {
    schema: `<?xml version="1.0"?>\n<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">\n  <xs:element name="book">\n    <xs:annotation><xs:documentation>A documented book.</xs:documentation></xs:annotation>\n    <xs:complexType><xs:sequence>\n      <xs:element name="title" type="xs:string"/>\n    </xs:sequence><xs:attribute name="id" type="xs:ID" use="required"/></xs:complexType>\n  </xs:element>\n  <xs:element name="library"><xs:complexType><xs:sequence><xs:element ref="book" maxOccurs="unbounded"/></xs:sequence></xs:complexType></xs:element>\n</xs:schema>\n`,
    main: `<book xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="book.xsd" id="ada"><title>😀 Ada</title></book>\n`,
    incomplete: `<book xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="book.xsd" id="ada">\n  <ti\n</book>\n`,
    broken: `<book xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="book.xsd" id="ada"><wrong/></book>\n`,
    dtd: `<!ELEMENT book (title)>\n<!ELEMENT title (#PCDATA)>\n<!ATTLIST book id ID #REQUIRED>\n`,
    dtdDocument: `<!DOCTYPE book SYSTEM "book.dtd">\n<book id="ada"><title>Ada</title></book>\n`,
    dtdBroken: `<!DOCTYPE book SYSTEM "book.dtd">\n<book id="ada"><wrong/></book>\n`,
    malformed: `<book><title>Ada</title></bok>\n`,
    xsl: `<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform" version="1.0"><xsl:template match="/"><book/></xsl:template></xsl:stylesheet>\n`,
    associated: `<book id="ada"><wrong/></book>\n`,
  };
  const names = {
    schema: "book.xsd",
    dtd: "book.dtd",
    main: "main.xml",
    incomplete: "incomplete.xml",
    broken: "broken.xml",
    dtdDocument: "dtd.xml",
    dtdBroken: "dtd-broken.xml",
    malformed: "malformed.xml",
    xsl: "transform.xsl",
    associated: "associated.xml",
  };
  const files = {},
    uris = {};
  for (const [key, name] of Object.entries(names)) {
    files[key] = path.join(rootPath, name);
    uris[key] = pathToFileURL(files[key]).href;
    fs.writeFileSync(files[key], texts[key]);
  }
  return { rootPath, files, texts, uris, configDirPath: path.join(temporaryRoot, ".client") };
};
const removeProject = (rootPath) => {
  const target = path.dirname(path.resolve(rootPath));
  if (
    path.dirname(target) !== fs.realpathSync.native(os.tmpdir()) ||
    !path.basename(target).startsWith("ide-xml-")
  )
    throw new Error(`Refusing to remove a non-test directory: ${target}`);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
};
const position = (text, fragment, inside = 0) => {
  const offset = text.indexOf(fragment);
  if (offset < 0) throw new Error(`Missing fixture fragment ${fragment}`);
  const before = text.slice(0, offset + inside).split("\n");
  return { line: before.length - 1, character: before.at(-1).length };
};
module.exports = { createProject, removeProject, position };
