// Journal du service (spec V3 §10.7) : une ligne JSON par événement, jamais de secret.
// Les URL de l'API Telegram (qui contiennent le jeton) et les clés sont masquées par précaution.

const MASQUES: RegExp[] = [
  /bot\d+:[A-Za-z0-9_-]{20,}/g,                 // jeton Telegram dans une URL
  /NNSXS\.[A-Z0-9.]{20,}/g,                      // clé API The Things Stack
  /SCRAM-SHA-256\$[^\s'"]+/g,                    // vérificateur de mot de passe
  /"(password|app_key|key|secret)"\s*:\s*"[^"]*"/gi,
];

export function masquer(s: string): string {
  let r = s;
  for (const m of MASQUES) r = r.replace(m, "‹masqué›");
  return r;
}

function ecrire(niveau: string, message: string, extra?: Record<string, unknown>) {
  const ligne: Record<string, unknown> = { t: new Date().toISOString(), niveau, message: masquer(message) };
  if (extra) for (const [k, v] of Object.entries(extra)) ligne[k] = typeof v === "string" ? masquer(v) : v;
  const out = JSON.stringify(ligne);
  if (niveau === "erreur") console.error(out); else console.log(out);
}

export const log = {
  info: (m: string, e?: Record<string, unknown>) => ecrire("info", m, e),
  warn: (m: string, e?: Record<string, unknown>) => ecrire("alerte", m, e),
  error: (m: string, e?: Record<string, unknown>) => ecrire("erreur", m, e),
};
