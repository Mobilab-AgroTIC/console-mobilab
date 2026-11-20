# Trame des montages Mobilab

Comment une carte construite par Mobilab doit envoyer ses mesures pour que la console les comprenne
sans écrire de décodeur. Format décidé le 19/11/2026, dans la lignée du cahier des charges V2
(fiche « AA 01 01 0B 3A » sur le port 10).

## En bref

| Port LoRaWAN | Quand | Contenu |
|---|---|---|
| **10** | au démarrage, puis une fois par jour | la **fiche** : `AA`, type du montage, version du programme, pile |
| **11** | à chaque mesure | la **pile**, puis les **valeurs**, toujours dans le même ordre |

- Tous les nombres sont écrits **poids fort en premier** (comme Dragino).
- La **pile** est en **millivolts, sur 2 octets** (3600 mV → `0E 10`).
- Une valeur **absente** (sonde débranchée, lecture ratée) vaut **`7F FF`** sur 2 octets
  (`7F FF FF FF` sur 4 octets).

Le port fait partie de chaque message LoRaWAN : s'en servir pour dire « fiche » ou « mesures » ne coûte
aucun octet. Les ports 10 et 11 ne servent à aucun capteur Dragino (ports 2 à 5), et la fiche commence
par `AA` : un montage ne peut pas être pris pour un Dragino.

## Port 10 : la fiche

| Octet | Contenu | Exemple |
|---|---|---|
| 0 | `AA` : « montage Mobilab » | `AA` |
| 1 | type du montage, de 1 à 255 (voir la liste plus bas) | `01` (Pilowtech) |
| 2 | version du programme de la carte, de 0 à 255 | `01` |
| 3-4 | pile en mV | `0B 3A` = 2874 mV |

`AA 01 01 0B 3A` : Pilowtech, programme version 1, pile à 2,874 V.

La fiche permet de reconnaître un montage jamais déclaré dans Telegram, de voir la version du programme,
et de repérer un montage déclaré avec le mauvais type. Si elle se perd, rien n'est cassé : le type est
connu depuis la déclaration.

## Port 11 : les mesures

| Octets | Contenu |
|---|---|
| 0-1 | pile en mV |
| puis | les valeurs, chacune sur 1, 2 ou 4 octets, dans l'ordre décrit au catalogue |

Pas de type, pas de nom : la console sait ce qu'est chaque valeur grâce à la fiche du montage dans le
catalogue (`catalogue/modeles/mobilab/mobilab-<nom>.yaml`).

### Écrire une valeur

- **2 octets par défaut**, en entier **signé** (−32768 à 32767) : une température négative passe.
- **Décimales** : envoyer l'entier multiplié (21,4 °C → 214), le catalogue divise (`facteur: 0.1`).
- **1 octet** pour un état (porte, fuite : 0 ou 1) ou un petit nombre ; **4 octets** pour un compteur
  qui dépasse 32767 (impulsions cumulées, par exemple).
- Une valeur qui ne peut jamais être négative et dépasse 32767 sur 2 octets : `signe: false` au catalogue
  (0 à 65535).
- **Nombre de sondes variable** (1 à 3 sondes selon la carte) : garder les places de toutes les sondes et
  mettre `7F FF` pour celles qui manquent. Une trame plus courte est aussi acceptée : les valeurs qui
  manquent à la fin sont considérées comme absentes.

### Exemple

Un montage avec une température (dixièmes de °C), une humidité (dixièmes de %), un compteur et un niveau :

```
0E 10   FF 9C   02 58   00 01 23 45   07
pile    temp.   hum.    compteur      niveau
3600 mV -10,0 °C 60,0 % 74 565        7
```

## La fiche du montage au catalogue

```yaml
cle: mobilab-essai
prefixe_id: essai                  # id dans TTN : essai-<4 derniers caractères du DevEUI>
marque: Mobilab
modele: Essai
libelle: Station d'essai Mobilab Essai   # usage, puis « Mobilab », puis le nom
bouton: Essai
type: capteur                      # capteur, interface (entrées libres) ou actionneur
lorawan: {mac: MAC_V1_0_3, phy: PHY_V1_0_3_REV_A, classe: A}
intervalle_defaut_s: 1200
trame:
  format: mobilab
  type: 1                          # l'octet 1 de la fiche : unique, voir la liste
  champs:                          # dans l'ordre de la trame, après la pile
    - {cle: temperature, octets: 2}                 # signé par défaut
    - {cle: humidite, octets: 2, signe: false}
    - {cle: impulsions, octets: 4, signe: false}
    - {cle: niveau, octets: 1, signe: false}
batterie: {pile: lithium}          # la chimie, pour le % (voir piles.yaml)
mesures:
  temperature: {nom: temperature, libelle: Température, unite: "°C", decimales: 1, facteur: 0.1,
                principale: true, alerte: seuil, hysteresis: 0.5}
  humidite: {nom: humidity, libelle: Humidité, unite: "%", decimales: 0, facteur: 0.1,
             principale: true, alerte: seuil, hysteresis: 3}
  impulsions: {nom: count, libelle: Impulsions, unite: "", decimales: 0, alerte: aucune}
  niveau: {nom: level, libelle: Niveau, unite: "%", decimales: 0, alerte: aucune}
grafana: {panneaux: [{type: courbe, mesures: [temperature, humidity]}, {type: batterie}, {type: radio}]}
```

Les ports (10 et 11) et la pile (2 premiers octets) n'ont pas à être écrits : ils découlent de
`format: mobilab`. Chaque fiche a ses trames d'exemple dans `catalogue/tests/mobilab/<cle>.yaml`, vérifiées par
les tests.

## Les cartes d'avant ce format

Les cartes déjà posées (1 octet de pile = tension ÷ 50, puis des valeurs sur 2 octets) continuent de
marcher sans être reprogrammées : leur fiche décrit leur trame telle qu'elle est.

```yaml
trame:
  format: libre
  port: 1                          # le port où la carte envoie
  champs:
    - {cle: pile, octets: 1, signe: false}
    - {cle: valeur, octets: 2, signe: false}
batterie: {cle: pile, facteur_mv: 50, pile: lithium}   # 74 × 50 = 3700 mV
```

## Commandes vers une carte (actionneur)

Une commande est décrite dans la fiche du montage (`actions` : bouton, port, octets envoyés), comme pour
les actionneurs du commerce. Pour Lancelot, par exemple : port 15, octet `01` = fermer.

## Types attribués

| Type | Montage |
|---|---|
| 1 (`01`) | Pilowtech (cahier des charges V2) |

Prendre le numéro suivant pour un nouveau montage et l'ajouter ici : le catalogue refuse deux montages
du même type.

## Combien coûte un octet ?

Le temps d'émission dépend de l'éloignement de l'antenne (le « SF ») :

| | SF7 (proche) | SF12 (loin) |
|---|---|---|
| un octet de plus | ≈ 1,5 ms | ≈ 33 ms |
| un message de 10 octets (+ 13 octets LoRaWAN) | ≈ 60 ms | ≈ 1,5 s |

TTN autorise 30 s d'émission par jour et par capteur. Au SF12, cela fait une vingtaine de messages par
jour : c'est là que les octets comptent. D'où la fiche à part (envoyée une fois par jour) et des mesures
sans en-tête.
