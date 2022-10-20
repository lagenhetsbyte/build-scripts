# Blackbox

Microk8s with automatic SSL certs, automatic rollback, and zero downtime (except when adding a domain, which restarts the proxy). Inspired by AWS Lightsail.

## Prep

1. Install Ubuntu.
2. Run setup.sh.

## Deploy from github action

deploy.sh is made for AWS ECR, but can be modified to work with other services.

```yaml
- name: Deploy
  run: curl -L https://raw.githubusercontent.com/lagenhetsbyte/build-scripts/master/blackbox/deploy.sh | bash -s AWS_REGION="eu-north-1" AWS_DOMAIN="123123.dkr.ecr.eu-north-1.amazonaws.com" AWS_REPONAME="testing" VPS_HOST="13.13.13.13" VPS_USER="ubuntu" AWS_ACCESS_KEY_ID="${{ secrets.SOMESECRET }}" AWS_SECRET_ACCESS_KEY="${{ secrets.MORESECRET }}" SSH_KEY_DIR="../ssh_key.pem" INSTRUCTION_FILE="./deploy-prod.json" IMAGE_TAG="${{ github.run_number }}"
```

## Instruction file

Should be placed in the github repo (e.g. ./deploy-prod.json).

Simple example:

```json
{
  "serverExternalIp": "13.13.13.13",
  "dockerLoginCommand": "sudo aws ecr get-login-password --region eu-north-1 | sudo docker login --username AWS --password-stdin 123123123.dkr.ecr.eu-north-1.amazonaws.com",
  "services": [
    {
      "domains": ["somedomain.com"],
      "name": "service1",
      "appPort": 3001,
      "servicePort": 32000,
      "instances": 1
    }
  ]
}
```

All options:

```json
{
  "serverExternalIp": "13.13.13.13", // Required. Deploy script will ensure that domains A record matches the IP to prevent being banned from Lets encrypt.
  "dockerLoginCommand": "sudo aws ecr get-login-password --region eu-north-1 | sudo docker login --username AWS --password-stdin 123123123.dkr.ecr.eu-north-1.amazonaws.com",
  // dockerLoginCommand is required. Bash command line, to be able to pull images from private repos.
  "services": [
    {
      "domains": ["somedomain.com"], // Required. These will be added to the proxy.
      "name": "my-service1", // Required, must be unique.
      "image": "", // deploy.sh adds the new image here. Otherwise, this field is required. Don't use :latest, it brakes automatic rollback.
      "appPort": 3001, // Requred.
      "servicePort": 31000, // Requred. Unique and must be between 30000-32768
      "env": {
        // Optional.
        "NODE_ENV": "development"
      },
      "volumes": [
        // Optional.
        {
          "name": "data", // Unique name.
          "containerPath": "/etc/resty-auto-ssl",
          "size": 5 // In GB. Optional, default is 1.
        }
      ],
      "healthCheck": {
        // Optional, defaults to false.
        "disabled": false
      },
      "instances": 1 // Optional, default is 1. Lowest amount of instances running at the same time.
    }
  ],
  // Optional
  "sslProductionMode": false, // For testing automatic SSL, without being banned from lets encrypt for trying too many times.
  "forceDeployment": false, // Continues deployment without waiting for current deployment to complete.
  "deploymentTimeout": 60, // Default to 60 (sec). Rollsback on timeout. Why? Because if a pod fails to start, it can take 30 minutes to change state to failed, which is too long.
  "removeServices": [
    // This is to be able to remove a service that is no longer in use.
    {
      "name": "my-service2",
      "domain": "somedomain2.com"
    }
  ]
}
```
