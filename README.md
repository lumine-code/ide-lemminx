# ide-xml

Provide XML intelligence with Eclipse LemMinX.

Eclipse LemMinX runs as a separate Java process and provides schema-aware XML editing through ide-client.

## Features

- **Schemas**: complete and validate elements and attributes using XML Schema and DTD declarations.
- **Navigation**: show schema documentation, locate declarations and find XML Schema references.
- **Editing**: format documents and selections, rename matching tags and apply XML fixes.
- **Documents**: serve XML, XML Schema and XSL documents recognised by language-xml.
- **Managed server**: install, update and remove the complete Eclipse uber JAR with its published SHA-256 checksum.

## Installation

To install `ide-xml` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/ide-xml`.

Install `ide-client` and `language-xml`, then install Eclipse LemMinX through the language server management view. A Java 11 or newer runtime is required on Windows, macOS and Linux; Java 21 is a suitable supported runtime. The package does not install Java or change the system environment.

## Usage

Open the project folder containing your XML files. A document can reference an XSD with `xsi:noNamespaceSchemaLocation` or `xsi:schemaLocation`, or a DTD with `DOCTYPE`. XML catalogs and file associations resolve schemas for documents that do not declare them themselves.

The managed server uses the immutable release artifact from [Eclipse Maven](https://repo.eclipse.org/repository/lemminx-maven2-releases/org/eclipse/lemminx/org.eclipse.lemminx/). A configured Server JAR takes precedence over the managed copy and `LEMMINX_JAR`; Java discovery tries Java Path, `JDK_HOME`, `JAVA_HOME`, then `PATH`. Configure the complete `uber` JAR rather than the artifact that omits its dependencies.

Schema references are supported where LemMinX understands the declaration, especially inside XSD documents; this is not a search for every matching tag name across a project. Tag rename changes the paired start and end tags. Signature help, call and type hierarchies, inlay hints and semantic tokens are unavailable. Upstream code lenses use client-specific XML commands, so this adapter omits them.

The wrapper is MIT licensed. [Eclipse LemMinX](https://github.com/eclipse-lemminx/lemminx) is a separately downloaded project licensed under EPL-2.0, with notices and dependency licenses retained in its JAR.

## Services

- `ide-client`: consumed to register the XML server and route its supported language features.
- `background-tips.provider`: provided to background-tips with XML schema guidance.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
