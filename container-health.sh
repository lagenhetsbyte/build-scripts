 #!/bin/bash

# Variables to define
#SLEEP
#CONTAINER

echo "Variables:"

for ARGUMENT in "$@"
do

    KEY=$(echo $ARGUMENT | cut -f1 -d=)
    VALUE=$(echo $ARGUMENT | cut -f2 -d=)
        declare $KEY="$VALUE"
        echo $KEY="$VALUE"

done

echo "Waiting $SLEEP secs for container to warm up"

sleep $SLEEP

if [ "$(sudo docker container inspect -f '{{.State.Running}}' "$CONTAINER")" == "true" ]; then 
  echo "Container is still up and OK"
  exit 0
else 
  echo "Container is not running"
  exit 1
fi
