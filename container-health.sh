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

sleep $SLEEP

if [ "$(sudo docker container inspect -f '{{.State.Running}}' "$CONTAINER")" == "true" ]; then 
  exit 0
else 
  exit 1
fi
