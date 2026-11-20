// npm run textes : recopie les gabarits d'alertes de textes.fr.ts (seule source) vers ingest/textes-alertes.json,
// que Node-RED lit pour rédiger les alertes (spec §2.1, §8.6). La CI vérifie que les deux sont identiques.
import fs from "node:fs";
import path from "node:path";
import { alertes } from "./textes.fr.js";
import { racineDepot } from "./config.js";

const cible = path.join(racineDepot(), "ingest", "textes-alertes.json");
fs.writeFileSync(cible, JSON.stringify(alertes, null, 2) + "\n");
console.log(`écrit : ${cible}`);
