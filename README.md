# Console Mobilab

Console LoRaWAN : les capteurs remontent par un webhook The Things Stack vers Node-RED,
qui décode les trames, les enregistre dans TimescaleDB et dialogue avec les utilisateurs
par Telegram. Chaque client a son organisation Grafana et ne voit que ses données.

## Structure

| Chemin | Rôle |
|---|---|
| `docker-compose.yml` | Node-RED, Grafana, TimescaleDB |
| `node-red/` | `flows.json`, `settings.js`, dépendances (`package.json`) |
| `postgres/schema/` | une table par type de capteur, rejouable sans risque |
| `grafana/` | logos de l'interface |
| `visualisations/`, `specifications/` | modèles de panneaux et documents de conception |
| `data/` | données de l'installation (hors git) |

## Installation

```bash
cp .env.example .env          # puis remplir les valeurs, et chmod 600 .env
mkdir -p data/node-red data/grafana data/postgres
docker network create proxy   # si le réseau partagé avec le reverse proxy n'existe pas
docker compose up -d mobilab-postgres
# Modules Node-RED (une seule fois)
cp node-red/package.json data/node-red/
docker compose run --rm --no-deps -e HOME=/data --entrypoint npm mobilab-nodered \
  install --prefix /data --omit=dev --no-fund --no-audit --cache /data/.npm
docker compose up -d
```

Le reverse proxy (Caddy) rejoint Grafana et Node-RED sur le réseau `proxy` :
`mobilab-grafana:3000` et `mobilab-nodered:1880`. Ports ouverts sur la machine seule
(127.0.0.1), pour l'administration : Node-RED 1881, Grafana 3002, Postgres 5434.

Ensuite, dans l'éditeur Node-RED :

1. Saisir les identifiants des nœuds : Postgres (configuration `postgres`, hôte
   `mobilab-postgres`, base `mobilab`), compte admin Grafana (nœuds HTTP Request de l'onglet
   System Setup), token du bot Telegram.
2. Mettre l'ID du chat Telegram des administrateurs dans la fonction `adminChatId`.
3. Cliquer sur « trigger » (onglet System Setup) pour créer les tables.

Les flux appellent Grafana et Postgres par leurs noms uniques (`mobilab-grafana`,
`mobilab-postgres`) : sur le réseau `proxy`, partagé avec d'autres stacks, un nom générique
comme `grafana` peut désigner un autre conteneur.

## Modifier les flux

Node-RED enregistre ses flux directement dans `node-red/flows.json` : chaque Deploy apparaît
dans `git diff`. Les identifiants des nœuds sont chiffrés dans `node-red/flows_cred.json`,
hors git ; les garder avec `NR_CREDENTIAL_SECRET`, sans lequel ils sont illisibles.

## Ajouter un type de capteur

Créer `postgres/schema/<fabricant>/<capteur>.sql` sur le modèle des fichiers existants
(table, colonnes, hypertable, index, règle de lecture `tenant = current_user`), puis
cliquer sur « trigger ».

## V3 (en cours) : service console, deux bots, catalogue

La V3 suit la spec « Console Mobilab V3 ». Elle tourne **à côté** de la V2 : la V2 garde `/ttn/uplink`, son bot
et ses tables ; la V3 reçoit sur `/ttn/v3/*` et écrit dans `public.measures` (format long) et le schéma `app`.

| Dossier | Rôle |
|---|---|
| `db/migrations/` | Schéma `app`, `public.measures`, rôles `svc_nodered`, `svc_console`, `clients`, RLS `tenant = current_user` |
| `catalogue/` | Un YAML par modèle, décodeurs Dragino officiels copiés sans modification, trames de test |
| `ingest/` | Module chargé par Node-RED (`node-red/ingest-v3.js`) : secret, décodage, normalisation, alertes |
| `console/` | Service TypeScript : bot client, bot admin, jobs TTN, Grafana et Postgres, surveillance |
| `node-red/v3-reception.json` | Onglet Node-RED à importer (`/ttn/v3/uplink`, `/join`, `/downlink`, `/health`, `/redecode`) |

Mise en route, dans l'ordre :

1. Variables dans `.env` : `PG_SVC_NODERED_PASSWORD`, `PG_SVC_CONSOLE_PASSWORD`, `SECRETS_KEY` (64 caractères
   hexadécimaux : `openssl rand -hex 32`), `TTN_API_KEY` (clé de l'organisation TTS `mobilab`),
   `TELEGRAM_CLIENT_BOT_TOKEN` et `TELEGRAM_ADMIN_BOT_TOKEN` (deux **nouveaux** bots BotFather), `ADMIN_BOOTSTRAP_IDS`
   (ids Telegram des admins), et si besoin `MOBILAB_STAFF_LOGINS`.
2. Dépendances du module ingest (une fois) :
   `docker run --rm -u 1001:1001 -e HOME=/tmp -v $PWD/ingest:/w -w /w node:20-alpine npm ci --omit=dev`
3. Base : `docker compose --profile outils run --rm mobilab-migrate`
4. Node-RED : `docker compose up -d mobilab-nodered`, puis importer `node-red/v3-reception.json` dans l'éditeur.
5. Service : `docker compose --profile v3 up -d --build mobilab-console`

Tests (conteneurs jetables, jamais la base de prod) : `ingest/test/` (`node --test`), `console/test/` (`vitest`).
