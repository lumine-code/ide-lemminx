const server = require("./server");
const setting = (name) => lumine.config.get(`ide-xml.${name}`);
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
      id: "ide-xml",
      displayName: "Eclipse LemMinX",
      grammarScopes: ["text.xml", "text.xml.xsl"],
      languageId: "xml",
      sessionScope: "project-root",
      settingsKeyPaths: ["ide-xml"],
      restartKeyPaths: ["ide-xml.serverJar", "ide-xml.javaPath", "ide-xml.maxHeap"],
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
          client.reportMissingServer("ide-xml", {
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
      packageName: "ide-xml",
      tips: [
        "XML files get completion, validation and documentation from Eclipse LemMinX when they refer to an XSD or DTD. XML catalogs and file associations can provide the schema without changing the document.",
      ],
    };
  },
};
