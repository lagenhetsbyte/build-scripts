#!/bin/bash
set -e

# Variables to define
#IMAGE_TAG
#AWS_REGION
#AWS_DOMAIN
#AWS_REPONAME
#VPS_HOST
#VPS_USER
#SSH_KEY_DIR
#AWS_ACCESS_KEY_ID
#AWS_SECRET_ACCESS_KEY
#INSTRUCTION_FILE

echo "Variables:"

for ARGUMENT in "$@"; do

    KEY=$(echo $ARGUMENT | cut -f1 -d=)
    VALUE=$(echo $ARGUMENT | cut -f2 -d=)
    declare $KEY="$VALUE"
    echo $KEY="$VALUE"

done

echo Logging in to Amazon ECR...

# login to AWS ECR
aws configure set default.region "$AWS_REGION"
aws configure set aws_access_key_id "$AWS_ACCESS_KEY_ID"
aws configure set aws_secret_access_key "$AWS_SECRET_ACCESS_KEY"

aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $AWS_DOMAIN

REPOSITORY_URI=$AWS_DOMAIN/$AWS_REPONAME

echo Build started on $(date)
echo Building the Docker image...
# build image
docker build -t $REPOSITORY_URI:$IMAGE_TAG .

echo Build completed on $(date)
echo Pushing the Docker images
# push image
docker push $REPOSITORY_URI:$IMAGE_TAG

RANDOM_STR=$(tr </dev/urandom -dc 'a-zA-Z0-9' | fold -w 20 | head -n 1)
DEPLOYMENT_INSTRUCTION_FILE="$IMAGE_TAG-deploy-$RANDOM_STR.json"

scp -o StrictHostKeyChecking=no -i "$SSH_KEY_DIR" $INSTRUCTION_FILE "$VPS_USER"@"$VPS_HOST":"$DEPLOYMENT_INSTRUCTION_FILE"

COMMAND_1="wget -N https://github.com/lagenhetsbyte/build-scripts/raw/master/blackbox/blackbox.zip && unzip -o blackbox.zip"
COMMAND_2="node replace_image.js "$DEPLOYMENT_INSTRUCTION_FILE" "$REPOSITORY_URI:$IMAGE_TAG""
COMMAND_3="sudo node deploy.js "$DEPLOYMENT_INSTRUCTION_FILE""

echo Connecting and running commands on remote server
ssh -o StrictHostKeyChecking=no -i "$SSH_KEY_DIR" "$VPS_USER"@"$VPS_HOST" ""$COMMAND_1"; "$COMMAND_2"; "$COMMAND_3";"
