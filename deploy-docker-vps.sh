 #!/bin/bash
set -e

# Variables to define
#AWS_REGION
#AWS_DOMAIN
#AWS_REPONAME
#VPS_HOST
#VPS_USER
#SSH_KEY_DIR
#AWS_ACCESS_KEY_ID
#AWS_SECRET_ACCESS_KEY

echo "Variables:"

for ARGUMENT in "$@"
do

    KEY=$(echo $ARGUMENT | cut -f1 -d=)
    VALUE=$(echo $ARGUMENT | cut -f2 -d=)
        declare $KEY=$VALUE        
        echo $KEY=$VALUE

done

echo Logging in to Amazon ECR...

# login to AWS ECR
aws configure set default.region "$AWS_REGION"
aws configure set aws_access_key_id "$AWS_ACCESS_KEY_ID"
aws configure set aws_secret_access_key "$AWS_SECRET_ACCESS_KEY"

aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $AWS_DOMAIN

CONTAINER=container

REPOSITORY_URI=$AWS_DOMAIN/$AWS_REPONAME
IMAGE_TAG=${COMMIT_HASH:=latest}

echo Build started on `date`
echo Building the Docker image...
# build image
docker build -t $REPOSITORY_URI:latest .
docker tag $REPOSITORY_URI:latest $REPOSITORY_URI:$IMAGE_TAG

echo Build completed on `date`
echo Pushing the Docker images
# push image
docker push $REPOSITORY_URI:latest
docker push $REPOSITORY_URI:$IMAGE_TAG



echo Connecting and running commands on remote server
ssh -o StrictHostKeyChecking=no -i "$SSH_KEY_DIR" $VPS_USER@$VPS_HOST "aws configure set default.region "$AWS_REGION"; aws configure set aws_access_key_id "$AWS_ACCESS_KEY_ID"; aws configure set aws_secret_access_key $AWS_SECRET_ACCESS_KEY; aws ecr get-login-password --region $AWS_REGION | sudo docker login --username AWS --password-stdin $AWS_DOMAIN; sudo docker pull "$REPOSITORY_URI":latest; sudo docker stop $CONTAINER; sudo docker rm $CONTAINER -f; sudo docker run --name $CONTAINER -p 80:80 -p 443:443 "$REPOSITORY_URI":latest; sudo docker image prune -a -f"

echo All done.


