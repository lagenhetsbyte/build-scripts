const dns = require("dns");
const fs = require("fs");
const exec = require("child_process").exec;

const instruction = JSON.parse(fs.readFileSync("instruction.json"));
const timeout = instruction.deploymentTimeout || 60;

async function deploy() {
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
    await waitForCorrectDnsIp(service.domain, instruction.serverExternalIp);
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
  generateStorageTemplate([
    { name: "proxy-volume", containerPath: "/etc/resty-auto-ssl", size: 1 },
    instruction.services
      .map(
        (x) =>
          x.volumes &&
          x.volumes.map((s) => ({ ...s, name: `${x.name}-${s.name}` }))
      )
      .filter((x) => x)
      .flat(),
  ]);

  generateServiceTemplate(instruction.services);
  generateProxyTemplate(
    instruction.services,
    instruction.sslProductionMode,
    instruction.removeDomains
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
    cTDeployment.spec.template.metadata.labels.app = service.name;

    cTDeployment.spec.template.spec.volumes = [];

    if (service.volumes) {
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

    container.volumeMounts = [];

    if (service.volumes) {
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

async function generateProxyTemplate(services, production, removeDomains = []) {
  const template = JSON.parse(fs.readFileSync("./templates/proxy.json"));
  const container = template.spec.template.spec.containers[0];
  let sites = "";

  const currentSites = await getCurrentProxySitesConfig();
  if (currentSites) {
    const arr = currentSites.split(";");
    const filtered = arr.filter(
      (x) =>
        !services.some((s) => x.trim().includes(`${s.domain}=`)) &&
        !removeDomains.some((d) => x.trim().includes(`${d}=`))
    );

    sites = filtered.join(";");
  }

  for (const service of services) {
    sites += `${service.domain}=localhost:${service.servicePort};`;
  }

  container.env.push({
    name: "SITES",
    value: sites,
  });

  container.env.push({
    name: "LETSENCRYPT_URL",
    value: production
      ? "https://acme-v02.api.letsencrypt.org/directory"
      : "https://acme-staging-v02.api.letsencrypt.org/directory",
  });

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
  const sites = config.spec.template.spec.containers[0].env.find(
    (x) => x.name === "SITES"
  );
  return sites.value;
}

generateTemplates();
deploy();
