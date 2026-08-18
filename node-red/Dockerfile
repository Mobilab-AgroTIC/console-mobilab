FROM nodered/node-red:4.1

# Copie du package.json listant les nodes additionnels
COPY package.json /data/package.json

# Installation des dépendances dans /data (volume persistant)
RUN npm --unsafe-perm --prefix /data install
