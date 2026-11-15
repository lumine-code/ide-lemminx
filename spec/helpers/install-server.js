const fs = require("node:fs");
const path = require("node:path");
const server = require("../../lib/server");
const downloadFile = require("./server-download");

async function install(version, storagePath, environmentFile) {
  if (!path.isAbsolute(storagePath)) throw new Error("Installation storage must be absolute.");
  await fs.promises.mkdir(storagePath, { recursive: true });
  const installed = await server.installServer({
    storagePath,
    version,
    api: { downloadFile, setServerInstallationStatus() {} },
  });
  const jar = path.join(storagePath, installed.module);
  if (environmentFile) await fs.promises.appendFile(environmentFile, `LEMMINX_JAR=${jar}\n`);
  return { ...installed, path: jar };
}
module.exports = { install };
if (require.main === module) {
  const [version, storagePath, environmentFile] = process.argv.slice(2);
  install(version, storagePath, environmentFile).then(
    (result) => console.log(JSON.stringify(result)),
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
