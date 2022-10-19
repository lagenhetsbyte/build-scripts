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
docker build -t $REPOSITORY_URI:latest -t $REPOSITORY_URI:$IMAGE_TAG .

echo Build completed on $(date)
echo Pushing the Docker images
# push image
docker push $REPOSITORY_URI:latest
docker push $REPOSITORY_URI:$IMAGE_TAG

scp -o StrictHostKeyChecking=no -i "$SSH_KEY_DIR" $INSTRUCTION_FILE "$VPS_USER"@"$VPS_HOST":instruction.json

COMMAND_1="wget https://github.com/lagenhetsbyte/build-scripts/raw/master/blackbox/blackbox.zip && unzip -o blackbox.zip"
COMMAND_2="node replace_image.js "$REPOSITORY_URI:$IMAGE_TAG""
COMMAND_3="sudo node deploy.js"

echo Connecting and running commands on remote server
ssh -o StrictHostKeyChecking=no -i "$SSH_KEY_DIR" "$VPS_USER"@"$VPS_HOST" ""$COMMAND_1"; "$COMMAND_2";"
