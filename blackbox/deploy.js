const dns = require("dns");
const fs = require("fs");
const exec = require("child_process").exec;

const instruction = JSON.parse(fs.readFileSync("instruction.json"));
const timeout = instruction.deploymentTimeout || 60;

async function deploy() {
  try {
    if (!instruction.forceDeployment) {
      const podStatus = await runHostScript(
        "microk8s kubectl rollout status deployment"
      );

      if (podStatus.code !== 0) {
        console.log("Not ready for rollout!");
        process.exit(1);
      }
    }

    if (instruction.dockerLoginCommand) {
      await runHostScript(instruction.dockerLoginCommand);
      await runHostScript(
        "sudo cp /root/.docker/config.json /var/snap/microk8s/common/var/lib/kubelet/"
      );
    }

    await runHostScript(
      "microk8s kubectl apply -f generated-storage.json",
      false
    );
    await runHostScript("microk8s kubectl apply -f generated-service.json");

    for (const service of instruction.services) {
      for (const domain of service.domains) {
        await waitForCorrectDnsIp(domain, instruction.serverExternalIp);
      }
    }

    await runHostScript("microk8s kubectl apply -f generated-proxy.json");

    for (const service of instruction.services) {
      // Let the rollout deploy in 60 sec, or timeout and start rollback
      const deployResult = await runHostScript(
        `microk8s kubectl rollout status deployment ${service.name} --watch --timeout ${timeout}s`,
        false
      );

      // Rollback
      if (deployResult.code !== 0) {
        await runHostScript(
          `microk8s kubectl rollout undo deployment ${service.name}`
        );

        await runHostScript(
          `microk8s kubectl rollout status deployment ${service.name} --watch --timeout ${timeout}s`
        );

        process.exit(1);
      }
    }

    process.exit(0);
  } catch (error) {
    process.exit(1);
  }
}

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

function generateTemplates() {
  const serviceVolumes = instruction.services
    .filter((x) => x.volumes)
    .map((x) => x.volumes.map((s) => ({ ...s, name: `${x.name}-${s.name}` })))
    .flat();

  generateStorageTemplate([
    ...serviceVolumes,
    { name: "proxy-volume", containerPath: "/etc/resty-auto-ssl", size: 1 },
  ]);

  generateServiceTemplate(instruction.services);
  generateProxyTemplate(
    instruction.services,
    instruction.sslProductionMode,
    instruction.removeServices
  );
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

async function generateStorageTemplate(storages) {
  const template = JSON.parse(fs.readFileSync("./templates/storage.json"));
  const t1 = template.items[0];
  const t2 = template.items[1];
  template.items = [];

  for (const storage of storages.flat()) {
    const t1c = copy(t1);
    const t2c = copy(t2);

    const fullPath = `/mnt/${storage.name}`;

    t1c.metadata.name = storage.name;
    t1c.spec.hostPath.path = fullPath;
    t1c.spec.capacity.storage = `${storage.size}Gi`;
    t2c.metadata.name = `${storage.name}-claim`;
    t2c.spec.resources.requests.storage = `${storage.size}Gi`;

    template.items.push(t1c);
    template.items.push(t2c);

    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
  }

  fs.writeFileSync("generated-storage.json", JSON.stringify(template));
}

async function generateServiceTemplate(services) {
  const template = JSON.parse(fs.readFileSync("./templates/service.json"));
  const tService = template.items[0];
  const tDeployment = template.items[1];
  template.items = [];

  for (const service of services) {
    const cTService = copy(tService);
    cTService.metadata.name = service.name;
    cTService.metadata.labels.app = service.name;
    cTService.spec.ports = [
      {
        name: `${service.appPort}-${service.appPort}`,
        protocol: "TCP",
        port: service.appPort,
        targetPort: service.appPort,
        nodePort: service.servicePort,
      },
    ];
    cTService.spec.selector.app = service.name;

    const cTDeployment = copy(tDeployment);
    cTDeployment.metadata.name = service.name;
    cTDeployment.metadata.labels.app = service.name;
    cTDeployment.spec.selector.matchLabels.app = service.name;
    cTDeployment.spec.replicas = service.instances || 1;
    cTDeployment.spec.template.metadata.labels.app = service.name;

    if (service.volumes) {
      cTDeployment.spec.template.spec.volumes = [];
      for (const storage of service.volumes) {
        cTDeployment.spec.template.spec.volumes.push({
          name: `${service.name}-${storage.name}`,
          persistentVolumeClaim: {
            claimName: `${service.name}-${storage.name}-claim`,
          },
        });
      }
    }

    const container = copy(cTDeployment.spec.template.spec.containers[0]);
    cTDeployment.spec.template.spec.containers = [];
    container.name = service.name;
    container.image = service.image;
    container.ports = [{ containerPort: service.appPort }];
    container.readinessProbe.httpGet.port = service.appPort;

    if (service.volumes) {
      container.volumeMounts = [];
      for (const storage of service.volumes) {
        container.volumeMounts.push({
          mountPath: storage.containerPath,
          name: `${service.name}-${storage.name}`,
        });
      }
    }

    if (Array.isArray(service.env)) {
      container.env = [];
      for (const key of Object.keys(service.env)) {
        container.env.push({ name: key, value: service.env[key] });
      }
    }

    if (service.healthCheck && service.healthCheck.disabled) {
      delete container.readinessProbe;
    }
    cTDeployment.spec.template.spec.containers.push(container);

    template.items.push(cTService);
    template.items.push(cTDeployment);
  }

  fs.writeFileSync("generated-service.json", JSON.stringify(template));
}

async function generateProxyTemplate(
  services,
  production,
  removeServices = []
) {
  const template = JSON.parse(fs.readFileSync("./templates/proxy.json"));
  const container = template.spec.template.spec.containers[0];
  let sites = "";

  const prodMode =
    production === null || production === undefined || production === true;

  const currentSites = await getCurrentProxySitesConfig();
  if (currentSites) {
    const arr = currentSites.split(";").map((x) => x.trim());
    const filtered = arr.filter(
      (x) =>
        !services.some((s) => s.domains.some((d) => x.includes(`${d}=`))) &&
        !removeServices.some((rs) => x.includes(`${rs.domain}=`))
    );

    sites = filtered.join(";");
    if (filtered.length === 1) {
      sites += ";";
    }
  }

  for (const service of services) {
    for (const domain of service.domains) {
      sites += `${domain}=localhost:${service.servicePort};`;
    }
  }

  container.env.push({
    name: "SITES",
    value: sites,
  });

  container.env.push({
    name: "LETSENCRYPT_URL",
    value: prodMode
      ? "https://acme-v02.api.letsencrypt.org/directory"
      : "https://acme-staging-v02.api.letsencrypt.org/directory",
  });

  const currentProdMode = await getCurrentProxyProductionMode();
  if (currentProdMode !== prodMode) {
    await runHostScript("sudo rm -r  /mnt/proxy-volume/", false);
    await runHostScript("sudo mkdir -p /mnt/proxy-volume/", false);
  }

  template.spec.template.spec.containers = [container];

  fs.writeFileSync("generated-proxy.json", JSON.stringify(template));
}

function copy(item) {
  return JSON.parse(JSON.stringify(item));
}

async function getCurrentProxySitesConfig() {
  const currentConfig = await runHostScript(
    "microk8s kubectl get ds/proxy-auto-ssl -o json",
    false,
    true
  );

  const configStr = currentConfig.lines[0];
  if (!configStr) {
    return null;
  }

  const config = JSON.parse(configStr);
  const env = config.spec.template.spec.containers[0].env.find(
    (x) => x.name === "SITES"
  );
  return env.value;
}

async function getCurrentProxyProductionMode() {
  const currentConfig = await runHostScript(
    "microk8s kubectl get ds/proxy-auto-ssl -o json",
    false,
    true
  );

  const configStr = currentConfig.lines[0];
  if (!configStr) {
    return null;
  }

  const config = JSON.parse(configStr);
  const env = config.spec.template.spec.containers[0].env.find(
    (x) => x.name === "LETSENCRYPT_URL"
  );

  return env.value === "https://acme-v02.api.letsencrypt.org/directory";
}

async function removeServices() {
  if (!Array.isArray(instruction.removeServices)) {
    return;
  }

  for (const service of instruction.removeServices) {
    await runHostScript(
      `microk8s kubectl delete -n default service ${service.name}`,
      false
    );

    await runHostScript(
      `microk8s kubectl delete -n default deployment ${service.name}`,
      false
    );
  }
}

async function run() {
  try {
    generateTemplates();
    await deploy();
    await removeServices();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

run();
