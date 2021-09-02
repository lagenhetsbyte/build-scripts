#!/bin/bash
set -e

#KEY
#PAYLOAD

echo "Variables:"

for ARGUMENT in "$@"
do

    KEY=$(echo $ARGUMENT | cut -f1 -d=)
    VALUE=$(echo $ARGUMENT | cut -f2 -d=)
        declare $KEY="$VALUE"
        echo "$KEY"

done


jwt_header=$(echo -n '{"alg":"HS256","typ":"JWT"}' | base64 | sed s/\+/-/g | sed 's/\//_/g' | sed -E s/=+$//)

payload=$(echo -n "$PAYLOAD" | base64 | sed s/\+/-/g |sed 's/\//_/g' |  sed -E s/=+$//)

secret="$KEY"

hexsecret=$(echo -n "$secret" | xxd -p | paste -sd "")

hmac_signature=$(echo -n "${jwt_header}.${payload}" |  openssl dgst -sha256 -mac HMAC -macopt hexkey:$hexsecret -binary | base64  | sed s/\+/-/g | sed 's/\//_/g' | sed -E s/=+$//)

jwt="${jwt_header}.${payload}.${hmac_signature}"

echo "$jwt"
