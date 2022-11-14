#!/bin/bash
set -e

# Variables to define
#IMAGE_TAG
#REGISTRY_DOMAIN
#REPONAME
#HOST
#USER
#SSH_KEY_DIR
#INSTRUCTION_FILE

echo "Variables:"

for ARGUMENT in "$@"; do

    KEY=$(echo $ARGUMENT | cut -f1 -d=)
    VALUE=$(echo $ARGUMENT | cut -f2 -d=)
    declare $KEY="$VALUE"
    echo $KEY="$VALUE"

done

REPOSITORY_URI=$DOMAIN/$REPONAME

echo "Build started on $(date)"
echo "Building the Docker image..."
docker build -t $REPOSITORY_URI:$IMAGE_TAG .
echo "Build completed on $(date)"
echo "Pushing the Docker images"
docker push $REPOSITORY_URI:$IMAGE_TAG

RANDOM_STR=$(cat /proc/sys/kernel/random/uuid | sed 's/[-]//g' | head -c 20)
DEPLOYMENT_INSTRUCTION_FILE="$IMAGE_TAG-deploy-$RANDOM_STR.json"

scp -o StrictHostKeyChecking=no -i "$SSH_KEY_DIR" $INSTRUCTION_FILE "$USER"@"$HOST":"$DEPLOYMENT_INSTRUCTION_FILE"

COMMAND_1="wget -N https://github.com/lagenhetsbyte/build-scripts/raw/master/blackbox/blackbox.zip && unzip -o blackbox.zip"
COMMAND_2="node replace_image.js "$DEPLOYMENT_INSTRUCTION_FILE" "$REPOSITORY_URI:$IMAGE_TAG""
COMMAND_3="sudo node deploy.js "$DEPLOYMENT_INSTRUCTION_FILE""

echo "Connecting and running commands on remote server"
ssh -o StrictHostKeyChecking=no -i "$SSH_KEY_DIR" "$VPS_USER"@"$VPS_HOST" ""$COMMAND_1"; "$COMMAND_2"; "$COMMAND_3";"
