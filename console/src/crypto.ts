// Secrets du service (spec V3 §6.1, §10.5) : AppKey chiffrée (AES-256-GCM), jetons d'invitation,
// vérificateur SCRAM des rôles de fermes, mots de passe Grafana lisibles.
import crypto from "node:crypto";

export function chiffrer(cle: Buffer, clair: string): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", cle, iv);
  const corps = Buffer.concat([c.update(clair, "utf8"), c.final()]);
  return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), corps]);
}

export function dechiffrer(cle: Buffer, paquet: Buffer): string {
  if (paquet[0] !== 1) throw new Error("format de secret inconnu");
  const iv = paquet.subarray(1, 13), tag = paquet.subarray(13, 29), corps = paquet.subarray(29);
  const d = crypto.createDecipheriv("aes-256-gcm", cle, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(corps), d.final()]).toString("utf8");
}

/** Jeton de lien : 32 octets aléatoires en base64url sans « = » (43 caractères, spec §4.3). */
export function jeton(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Seule l'empreinte SHA-256 du jeton est stockée (spec §4.3). */
export function empreinte(j: string): string {
  return crypto.createHash("sha256").update(j).digest("hex");
}

/** Vérificateur SCRAM-SHA-256 : le mot de passe en clair ne passe jamais dans une requête (spec §6.2, étape 6). */
export function verificateurScram(motDePasse: string, iterations = 4096): string {
  const sel = crypto.randomBytes(16);
  const salted = crypto.pbkdf2Sync(motDePasse.normalize("NFKC"), sel, iterations, 32, "sha256");
  const clientKey = crypto.createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = crypto.createHash("sha256").update(clientKey).digest();
  const serverKey = crypto.createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${sel.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** Mot de passe technique long (rôle Postgres de ferme, comptes jetables). */
export function motDePasseTechnique(): string {
  return crypto.randomBytes(24).toString("base64url");
}

const MOTS = [
  "Pomme", "Tracteur", "Vigne", "Prairie", "Grange", "Sillon", "Verger", "Moisson", "Fourche", "Ruche",
  "Colza", "Luzerne", "Bocage", "Etable", "Semoir", "Charrue", "Houblon", "Noyer", "Chataigne", "Silo",
  "Meule", "Rosee", "Faucille", "Tournesol", "Avoine", "Seigle", "Brebis", "Genisse", "Paille", "Treille",
  "Cerisier", "Orge", "Lavande", "Mirabelle", "Bergerie", "Abreuvoir", "Rigole", "Talus", "Haie", "Jachere",
];

/** Mot de passe Grafana lisible et conforme à password_policy : trois mots, un chiffre, un symbole (spec §9.6). */
export function motDePasseLisible(): string {
  const pick = () => MOTS[crypto.randomInt(MOTS.length)];
  let a = pick(), b = pick(), c = pick();
  while (b === a) b = pick();
  while (c === a || c === b) c = pick();
  const symbole = "!?#%+"[crypto.randomInt(5)];
  return `${a}-${b}-${c}-${crypto.randomInt(10, 100)}${symbole}`;
}

/** Identifiant court d'erreur interne, donné aux admins (spec §4.14). */
export function codeErreur(): string {
  return "E-" + crypto.randomBytes(2).toString("hex").toUpperCase();
}
