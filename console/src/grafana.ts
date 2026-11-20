// Appels à l'API classique de Grafana avec le compte administrateur serveur, en Basic auth,
// et l'en-tête X-Grafana-Org-Id pour viser l'org d'une ferme (spec V3 §6.2, §9.4).
import type { Config } from "./config.js";
import { ErreurApi } from "./ttn.js";

type Fetch = typeof fetch;

export class Grafana {
  constructor(private cfg: Config["grafana"], private fetchFn: Fetch = fetch) {}

  get configure(): boolean { return Boolean(this.cfg.url && this.cfg.user && this.cfg.password); }

  private async appel(methode: string, chemin: string, corps?: unknown, opts: { org?: number; absentOk?: boolean; existeOk?: boolean } = {}): Promise<any> {
    if (!this.configure) throw new ErreurApi("grafana", 0, "NON_CONFIGURE", "GRAFANA_ADMIN_USER ou GRAFANA_ADMIN_PASSWORD manquant", false);
    const headers: Record<string, string> = {
      authorization: "Basic " + Buffer.from(`${this.cfg.user}:${this.cfg.password}`).toString("base64"),
      "content-type": "application/json", accept: "application/json",
    };
    if (opts.org) headers["X-Grafana-Org-Id"] = String(opts.org);
    let rep: Response;
    try {
      rep = await this.fetchFn(`${this.cfg.url}${chemin}`, { method: methode, headers, signal: AbortSignal.timeout(20000),
        body: corps === undefined ? undefined : JSON.stringify(corps) });
    } catch (e: any) {
      throw new ErreurApi("grafana", 0, e?.name === "TimeoutError" ? "DELAI" : "RESEAU", `Grafana injoignable (${e?.name || "réseau"})`, true);
    }
    const texte = await rep.text();
    let json: any = {};
    try { json = texte ? JSON.parse(texte) : {}; } catch { json = { message: texte.slice(0, 120) }; }
    if (rep.ok) return json;
    if (rep.status === 404 && opts.absentOk) return null;
    if ((rep.status === 409 || rep.status === 412) && opts.existeOk) return { existe: true, ...json };
    throw new ErreurApi("grafana", rep.status, `HTTP_${rep.status}`, `Grafana ${rep.status} : ${String(json.message || "").slice(0, 160)}`,
      rep.status >= 500 || rep.status === 429);
  }

  // -------------------------------------------------------------- instance
  sante() { return this.appel("GET", "/api/health"); }
  moi() { return this.appel("GET", "/api/user"); }

  // -------------------------------------------------------------- organisations
  org(id: number) { return this.appel("GET", `/api/orgs/${id}`, undefined, { absentOk: true }); }
  orgParNom(nom: string) { return this.appel("GET", `/api/orgs/name/${encodeURIComponent(nom)}`, undefined, { absentOk: true }); }
  async creerOrg(nom: string): Promise<number> {
    const r = await this.appel("POST", "/api/orgs", { name: nom });
    return Number(r.orgId);
  }
  renommerOrg(id: number, nom: string) { return this.appel("PUT", `/api/orgs/${id}`, { name: nom }); }
  supprimerOrg(id: number) { return this.appel("DELETE", `/api/orgs/${id}`, undefined, { absentOk: true }); }

  orgs(): Promise<{ id: number; name: string }[]> { return this.appel("GET", "/api/orgs?perpage=1000"); }
  sources(orgId: number): Promise<{ uid: string; name: string; type: string; user: string; url: string }[]> {
    return this.appel("GET", "/api/datasources", undefined, { org: orgId });
  }

  membres(orgId: number): Promise<{ userId: number; login: string; email: string; name: string; role: string }[]> {
    return this.appel("GET", `/api/orgs/${orgId}/users`);
  }

  /** Ajoute la personne à l'org avec ce rôle ; si elle y est déjà (409), corrige le rôle (spec §6.3, étape role). */
  async poserRole(orgId: number, login: string, userId: number | null, role: string) {
    const r = await this.appel("POST", `/api/orgs/${orgId}/users`, { loginOrEmail: login, role }, { existeOk: true });
    if (r?.existe) {
      const id = userId ?? (await this.utilisateurParLogin(login))?.id;
      if (id) await this.appel("PATCH", `/api/orgs/${orgId}/users/${id}`, { role });
    }
  }

  retirerMembre(orgId: number, userId: number) {
    return this.appel("DELETE", `/api/orgs/${orgId}/users/${userId}`, undefined, { absentOk: true });
  }

  // -------------------------------------------------------------- utilisateurs
  utilisateurParLogin(login: string) { return this.appel("GET", `/api/users/lookup?loginOrEmail=${encodeURIComponent(login)}`, undefined, { absentOk: true }); }
  utilisateur(id: number) { return this.appel("GET", `/api/users/${id}`, undefined, { absentOk: true }); }
  orgsUtilisateur(id: number): Promise<{ orgId: number; name: string; role: string }[]> { return this.appel("GET", `/api/users/${id}/orgs`); }
  async creerUtilisateur(u: { name: string; login: string; email?: string; password: string; orgId?: number }): Promise<number> {
    const corps: any = { name: u.name, login: u.login, password: u.password };
    if (u.email) corps.email = u.email;
    if (u.orgId) corps.OrgId = u.orgId;
    const r = await this.appel("POST", "/api/admin/users", corps);
    return Number(r.id);
  }
  motDePasse(id: number, password: string) { return this.appel("PUT", `/api/admin/users/${id}/password`, { password }); }
  orgCourante(userId: number, orgId: number) { return this.appel("POST", `/api/users/${userId}/using/${orgId}`); }
  supprimerUtilisateur(id: number) { return this.appel("DELETE", `/api/admin/users/${id}`, undefined, { absentOk: true }); }

  // -------------------------------------------------------------- source de données (§9.4)
  async ecrireSource(orgId: number, slug: string, motDePasse: string) {
    const uid = `pg-${slug}`;
    const corps = {
      uid, name: "Mesures", type: "grafana-postgresql-datasource", access: "proxy", url: this.cfg.dbHost, user: slug,
      isDefault: true,
      jsonData: { database: this.cfg.dbName, sslmode: "disable", timescaledb: true, postgresVersion: 1500,
                  maxOpenConns: 5, maxIdleConns: 2, connMaxLifetime: 14400 },
      secureJsonData: { password: motDePasse },
    };
    const existe = await this.appel("GET", `/api/datasources/uid/${uid}`, undefined, { org: orgId, absentOk: true });
    if (existe) await this.appel("PUT", `/api/datasources/uid/${uid}`, { ...corps, id: existe.id, version: existe.version }, { org: orgId });
    else await this.appel("POST", "/api/datasources", corps, { org: orgId });
  }

  async santeSource(orgId: number, slug: string): Promise<boolean> {
    try {
      const r = await this.appel("GET", `/api/datasources/uid/pg-${slug}/health`, undefined, { org: orgId });
      return String(r.status || "").toUpperCase() === "OK";
    } catch (e) {
      if (e instanceof ErreurApi && !e.temporaire) return false;
      throw e;
    }
  }

  // -------------------------------------------------------------- tableaux (§9.5)
  async dossier(orgId: number) {
    const r = await this.appel("GET", "/api/folders/mobilab-auto", undefined, { org: orgId, absentOk: true });
    if (!r) await this.appel("POST", "/api/folders", { uid: "mobilab-auto", title: "Mobilab (automatique)" }, { org: orgId, existeOk: true });
  }
  lireTableau(orgId: number, uid: string) { return this.appel("GET", `/api/dashboards/uid/${uid}`, undefined, { org: orgId, absentOk: true }); }
  async ecrireTableau(orgId: number, tableau: unknown, dossierUid: string | null, message: string): Promise<number> {
    const r = await this.appel("POST", "/api/dashboards/db", { dashboard: tableau, folderUid: dossierUid ?? undefined, overwrite: true, message }, { org: orgId });
    // Grafana 12.1 renvoie la version précédente quand le contenu n'a pas changé (il en crée pourtant une) : on relit.
    const uid = (tableau as { uid?: string }).uid;
    if (!uid) return Number(r.version);
    const lu = await this.lireTableau(orgId, uid);
    return Number(lu?.dashboard?.version ?? r.version);
  }
  preferences(orgId: number, prefs: Record<string, unknown>) { return this.appel("PATCH", "/api/org/preferences", prefs, { org: orgId }); }
  lirePreferences(orgId: number) { return this.appel("GET", "/api/org/preferences", undefined, { org: orgId }); }
}
