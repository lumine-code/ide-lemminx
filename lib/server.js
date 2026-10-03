const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const MAVEN =
  "https://repo.eclipse.org/repository/lemminx-maven2-releases/org/eclipse/lemminx/org.eclipse.lemminx";
const SEARCH = "https://repo.eclipse.org/service/rest/v1/search/assets";

exports.fetchText = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Eclipse answered ${response.status} for ${url}.`);
  return response.text();
};
exports.stableVersion = (value) => {
  const version = String(value).replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`Choose a stable LemMinX release, not '${value}'.`);
  return version;
};
exports.latestServerVersion = async () => {
  const metadata = await exports.fetchText(`${MAVEN}/maven-metadata.xml`);
  const version = /<release>([^<]+)<\/release>/.exec(metadata)?.[1];
  if (!version) throw new Error("Eclipse Maven metadata did not identify a stable release.");
  return exports.stableVersion(version);
};
exports.installServer = async ({ storagePath, version, api }) => {
  api.setServerInstallationStatus("checking");
  const selected = exports.stableVersion(version || (await exports.latestServerVersion()));
  const artifact = `org.eclipse.lemminx-${selected}-uber.jar`;
  const query = new URLSearchParams({
    repository: "lemminx-maven2-releases",
    "maven.groupId": "org.eclipse.lemminx",
    "maven.artifactId": "org.eclipse.lemminx",
    "maven.baseVersion": selected,
    "maven.classifier": "uber",
  });
  const metadata = JSON.parse(await exports.fetchText(`${SEARCH}?${query}`));
  const url = `${MAVEN}/${selected}/${artifact}`;
  const item = metadata.items?.find(
    (entry) =>
      entry.downloadUrl === url &&
      entry.maven2?.extension === "jar" &&
      entry.maven2?.version === selected,
  );
  const checksum = item?.checksum?.sha256;
  if (!/^[a-f0-9]{64}$/i.test(checksum || ""))
    throw new Error(
      "Eclipse did not publish a SHA-256 checksum for the complete LemMinX uber JAR.",
    );
  api.setServerInstallationStatus("downloading");
  const target = path.join(storagePath, artifact);
  await api.downloadFile(url, target, { type: "uncompressed", digest: `sha256:${checksum}` });
  await exports.validateJar(target);
  return { version: selected, module: artifact, checksum: `sha256:${checksum}`, artifact };
};
exports.javaMajorVersion = (command) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      ["-version"],
      { windowsHide: true, timeout: 10000 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`Could not run Java: ${error.message}`));
        const match = `${stderr}\n${stdout}`.match(/version\s+"(\d+)(?:\.(\d+))?/);
        if (!match) return reject(new Error("Could not determine the Java runtime version."));
        resolve(Number(match[1] === "1" ? match[2] : match[1]));
      },
    );
  });
exports.validateJava = async (command) => {
  if (!path.isAbsolute(command)) throw new Error("Java Path must be an absolute executable path.");
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command))
    throw new Error("Java Path must name java.exe, not a shell wrapper.");
  if (!(await fs.promises.stat(command)).isFile())
    throw new Error("Java Path must name a Java executable.");
  await fs.promises.access(command, fs.constants.X_OK);
  const major = await exports.javaMajorVersion(command);
  if (major < 11) throw new Error(`LemMinX requires Java 11 or newer; found Java ${major}.`);
  return command;
};
exports.resolveJava = async (configuredPath = "", env = process.env) => {
  if (configuredPath) return exports.validateJava(configuredPath);
  const executable = process.platform === "win32" ? "java.exe" : "java";
  const candidates = [
    ...[env.JDK_HOME, env.JAVA_HOME]
      .filter(Boolean)
      .map((directory) => path.join(directory, "bin", executable)),
    ...(env.PATH || env.Path || "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, executable)),
  ];
  for (const candidate of candidates) {
    try {
      return await exports.validateJava(candidate);
    } catch {
      /* Keep looking past unsupported runtimes. */
    }
  }
  return null;
};
exports.validateJar = async (jar) => {
  if (!path.isAbsolute(jar)) throw new Error("Server JAR must be an absolute path.");
  if (!(await fs.promises.stat(jar)).isFile() || !/\.jar$/i.test(jar))
    throw new Error("Server JAR must name a JAR file.");
  const file = await fs.promises.open(jar, "r");
  try {
    const signature = Buffer.alloc(4);
    await file.read(signature, 0, 4, 0);
    if (!signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
      throw new Error("Server JAR is not a valid Java archive.");
  } finally {
    await file.close();
  }
  return jar;
};
exports.resolveJar = async (configured = "", managed = null, env = process.env) => {
  const jar = configured || managed?.modulePath || env.LEMMINX_JAR;
  return jar ? exports.validateJar(jar) : null;
};
exports.resolveServer = async ({ serverJar, javaPath, maxHeap, context, env = process.env }) => {
  const jar = await exports.resolveJar(serverJar, context.managedServer, env);
  const command = await exports.resolveJava(javaPath, env);
  if (!jar || !command) return null;
  const cache = path.join(
    context.configDirPath || context.rootPath,
    "language-server-caches",
    "ide-xml",
  );
  await fs.promises.mkdir(cache, { recursive: true });
  return {
    command,
    args: [`-Xmx${maxHeap || 512}m`, `-Dlemminx.workdir=${cache}`, "-jar", jar],
    cwd: context.rootPath,
    transport: "stdio",
    version: serverJar ? undefined : context.managedServer?.version,
  };
};
