const server = require("./server");
const setting = (name) => lumine.config.get(`ide-lemminx.${name}`);
const settings = () => {
  const xml = { codeLens: { enabled: false }, validation: { noGrammar: "ignore" } };
  const catalogs = setting("catalogs");
  if (catalogs?.length) xml.catalogs = catalogs;
  const associations = setting("fileAssociations");
  if (associations?.length) xml.fileAssociations = associations;
  const splitAttributes = setting("splitAttributes");
  if (splitAttributes !== "server-default")
    xml.format = { splitAttributes: splitAttributes === "yes" };
  return { xml };
};
const unsupported = new Set([
  "signature",
  "callHierarchy",
  "typeHierarchy",
  "inlayHints",
  "codeLens",
  "semanticTokens",
]);
module.exports = {
  consumeIdeClient(client) {
    return client.registerAdapter({
      id: "ide-lemminx",
      displayName: "Eclipse LemMinX",
      grammarScopes: ["text.xml", "text.xml.xsl"],
      languageId: "xml",
      sessionScope: "project-root",
      settingsKeyPaths: ["ide-lemminx"],
      restartKeyPaths: ["ide-lemminx.serverJar", "ide-lemminx.javaPath", "ide-lemminx.maxHeap"],
      installServer: server.installServer,
      latestServerVersion: server.latestServerVersion,
      isFeatureAvailable: (feature) => !unsupported.has(feature),
      async resolveServer(context) {
        const launch = await server.resolveServer({
          serverJar: setting("serverJar"),
          javaPath: setting("javaPath"),
          maxHeap: setting("maxHeap"),
          context,
        });
        if (!launch)
          client.reportMissingServer("ide-lemminx", {
            description:
              "Install Eclipse LemMinX through Manage Servers and a Java 11 or newer runtime. Set Java Path to its java executable and Server JAR to an existing complete LemMinX uber JAR when needed.",
          });
        return launch;
      },
      getInitializationOptions: () => ({ settings: settings() }),
      getSettings: settings,
      getWorkspaceConfiguration(section) {
        const configuration = settings();
        return section
          ? section.split(".").reduce((value, key) => value?.[key], configuration)
          : configuration;
      },
    });
  },
  provideBackgroundTips() {
    return {
      packageName: "ide-lemminx",
      tips: [
        "XML files get completion, validation and documentation from Eclipse LemMinX when they refer to an XSD or DTD. XML catalogs and file associations can provide the schema without changing the document.",
      ],
    };
  },
};
