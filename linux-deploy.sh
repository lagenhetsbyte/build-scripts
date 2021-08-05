#!/bin/bash

AUTHENTICATED_REPOPATH = $1;
PROJECTNAME = $2;

if [ -d "./${PROJECTNAME}" ]; then
    git pull ${AUTHENTICATED_REPOPATH}
else
    git clone ${AUTHENTICATED_REPOPATH}
fi

cd ${PROJECTNAME}

echo "Checking npm..."
if ! type "npm" > /dev/null; then
    echo "Installing npm..."
    sudo apt-get update

    curl -sL https://deb.nodesource.com/setup_12.x | sudo -E bash -

    sudo apt-get -y install nodejs
else
    echo "Npm found!";
fi

echo "Checking pm2..."
if ! type "pm2" > /dev/null; then
  echo "Installing pm2..."
  sudo npm install pm2 -g
else
  echo "PM2 found!"
fi

npm install