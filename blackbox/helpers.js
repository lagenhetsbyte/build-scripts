const exec = require("child_process").exec;
const dns = require("dns");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

function runHostScript(command, failOnError = true, skipLog) {
  if (!skipLog) {
    console.log("Running command:", command);
  }

  return new Promise((resolve, reject) => {
    const commandExec = exec(command);
    let lines = [];

    commandExec.stdout.on("data", (data) => {
      lines.push(
        data
          .toString("utf8")
          .replace(/\r\n|\r|\n/g, "")
          .trim()
      );
    });

    commandExec.stderr.on("data", (data) => {
      lines.push(
        data
          .toString("utf8")
          .replace(/\r\n|\r|\n/g, "")
          .trim()
      );
    });

    commandExec.on("exit", (code) => {
      const toReturn = { code: code, lines };
      if (code !== 0 && failOnError) {
        console.error("Command error:");
        lines.map((x) => console.log(x));
        reject(toReturn);
      }

      if (!skipLog) {
        lines.map((x) => console.log(x));
      }

      resolve(toReturn);
    });
  });
}

function getDnsRecords(domain) {
  return new Promise((resolve) => {
    dns.lookup(
      domain,
      {
        all: true,
      },
      (err, addresses) => {
        if (err) {
          resolve([]);
        }

        resolve(addresses.filter((x) => x.family === 4).map((x) => x.address));
      }
    );
  });
}

async function waitForCorrectDnsIp(domain, expecting) {
  while (true) {
    console.log("Checking DNS record for:", domain, "Expecting:", expecting);

    const response = await getDnsRecords(domain);
    if (response.some((x) => x == expecting)) {
      break;
    } else {
      console.log("DNS records did not match expected.");
    }

    await new Promise((resolve) => setTimeout(3000, resolve));
  }

  console.log("Found correct DNS record.");
  return true;
}

async function getMk8sCurrentConfig(serviceQuery) {
  try {
    const currentConfig = await runHostScript(
      `microk8s kubectl get ${serviceQuery} -o json --namespace default`,
      false,
      true
    );

    const configStr = currentConfig.lines[0];
    if (!configStr) {
      return null;
    }

    const config = JSON.parse(configStr);
    return config;
  } catch (error) {}

  return null;
}

async function getCurrentServiceInfo() {
  try {
    const config = await getMk8sCurrentConfig("service");
    if (!config) {
      return [];
    }

    const currentInfo = config.items.map((x) => {
      return {
        port:
          x.spec.ports[0] && x.spec.ports[0].nodePort
            ? x.spec.ports[0].nodePort
            : null,
        name: x.metadata.name,
      };
    });

    return currentInfo;
  } catch (error) {
    return [];
  }
}

async function getServicePort(serviceName) {
  const currentServiceInfo = await getCurrentServiceInfo();
  const currentService = currentServiceInfo.find(
    (x) => x.name.trim() === serviceName.trim()
  );

  if (currentService) {
    return currentService.port;
  }

  const min = 30000;
  const max = 32768;

  let newPort = -1;
  while (currentServiceInfo.some((i) => i.port == newPort) || newPort === -1) {
    newPort = Math.floor(Math.random() * (max - min + 1)) + min;
  }

  return newPort;
}

async function getServicePorts(services) {
  const cServices = copy(services);
  for (const service of cServices) {
    const port = await getServicePort(service.name);
    service.servicePort = port;
  }

  return cServices;
}

function copy(item) {
  return JSON.parse(JSON.stringify(item));
}

function createConfigPath() {
  const uuid = crypto.randomBytes(10).toString("hex");
  const templatePath = path.join(uuid);

  fs.mkdirSync(templatePath, { recursive: true });

  return templatePath;
}

async function deleteConfigPath(templatePath) {
  await runHostScript(`sudo rm -r  ${templatePath}`, false);
}

async function deleteFile(path) {
  await runHostScript(`sudo rm ${path}`, false);
}

module.exports = {
  runHostScript,
  waitForCorrectDnsIp,
  getMk8sCurrentConfig,
  getCurrentServiceInfo,
  getServicePort,
  getServicePorts,
  copy,
  createConfigPath,
  deleteConfigPath,
  deleteFile,
};
