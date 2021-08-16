 #!/bin/bash
set -e

sudo apt update
sudo apt install jq -y

# Variables to define
#REGION
#SERVICE
#CONTAINER
#PORT

echo "Variables:"

for ARGUMENT in "$@"
do

    KEY=$(echo $ARGUMENT | cut -f1 -d=)
    VALUE=$(echo $ARGUMENT | cut -f2 -d=)
        declare $KEY=$VALUE        
        echo $KEY=$VALUE

done

# These files will be generated
CONFIG_CONTAINER=lightsail-container.json
CONFIG_ENDPOINT=lightsail-endpoint.json

# Build image
echo "Building Docker image" 
docker build -t $CONTAINER:latest .

# Push image
echo "Pushing Docker image" 
aws lightsail push-container-image --region $REGION --service-name $SERVICE --label $CONTAINER --image $CONTAINER:latest

# Get latest image and set to variable 
IMAGE=$(aws lightsail get-container-images --service-name $SERVICE | grep -oP '(?<="image": ")[^"]*' | head -n1)

# Get env variables in JSON
echo "Getting env variables"
ENV=$(aws lightsail get-container-service-deployments --service-name "$SERVICE" | jq [.deployments[0]][0].containers.\""$CONTAINER"\".environment)

# Write container config to json file
echo "{\""$CONTAINER"\":{\"image\":\"$IMAGE""\",\"ports\":{\""$PORT"\":\"HTTP\"},\"environment\":"$ENV"}}" > $CONFIG_CONTAINER

# Write endpoint config to json file
echo "{\"containerName\":\""$CONTAINER"\",\"containerPort\":"$PORT"}" > $CONFIG_ENDPOINT

# Wait for service to be in READY mode before deploying
while [ "$STATE" != "\"ACTIVE\"" ]; do
STATE=$(aws lightsail get-container-service-deployments --service-name $SERVICE | jq [.deployments[0]][0].state)
echo "Current service state: "$STATE""
sleep 5
done

# Deploy container with new image
aws lightsail create-container-service-deployment --service-name $SERVICE --containers file://$CONFIG_CONTAINER --public-endpoint file://$CONFIG_ENDPOINT | echo "Done!"

# Wait for lightsail to leave deployment stage to be sure that when this script ends, the application is deployed
sleep 5
while [ "$STATE" != "\"ACTIVATING\"" ]; do
STATE=$(aws lightsail get-container-service-deployments --service-name $SERVICE | jq [.deployments[0]][0].state)
echo "Current service state: "$STATE""
sleep 5
done

echo "All done."


