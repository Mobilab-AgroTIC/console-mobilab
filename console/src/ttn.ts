// Appels HTTP à The Things Stack, sans SDK (spec V3 §2.2, §6.2, §6.5, §6.8). La clé n'est jamais journalisée.
import type { Config } from "./config.js";

export class ErreurApi extends Error {
  constructor(public service: string, public status: number, public code: string, message: string,
              public temporaire: boolean) {
    super(message);
  }
}

export interface Ids { device_id: string; dev_eui: string; join_eui: string; application_ids: { application_id: string } }
export interface VersionIds { brand_id: string; model_id: string; firmware_version?: string; band_id?: string; hardware_version?: string }

type Fetch = typeof fetch;

export class Ttn {
  constructor(private cfg: Config["ttn"], private fetchFn: Fetch = fetch) {}

  get configure(): boolean { return Boolean(this.cfg.host && this.cfg.apiKey); }

  private async appel(methode: string, chemin: string, corps?: unknown, opts: { absentOk?: boolean; existeOk?: boolean } = {}): Promise<any> {
    if (!this.configure) throw new ErreurApi("ttn", 0, "NON_CONFIGURE", "TTN_HOST ou TTN_API_KEY manquant", false);
    let rep: Response;
    try {
      rep = await this.fetchFn(`${this.cfg.baseUrl}${chemin}`, {
        method: methode,
        headers: { authorization: `Bearer ${this.cfg.apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: corps === undefined ? undefined : JSON.stringify(corps),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e: any) {
      throw new ErreurApi("ttn", 0, e?.name === "TimeoutError" ? "DELAI" : "RESEAU", `TTN injoignable (${e?.name || "réseau"})`, true);
    }
    const texte = await rep.text();
    let json: any = {};
    try { json = texte ? JSON.parse(texte) : {}; } catch { json = {}; }
    if (rep.ok) return json;
    const nom: string = (json.details || []).map((d: any) => d.name).find(Boolean) || "";
    if (rep.status === 404 && opts.absentOk) return null;
    if (rep.status === 409 && opts.existeOk && nom !== "end_device_euis_taken") return { existe: true };
    const code = nom || codeGrpc(json.code) || `HTTP_${rep.status}`;
    const temporaire = rep.status >= 500 || rep.status === 429 || json.code === 14;
    throw new ErreurApi("ttn", rep.status, code, `${code}${json.message ? " : " + String(json.message).slice(0, 160) : ""}`, temporaire);
  }

  private ids(appId: string, devEui: string, joinEui: string, deviceId?: string): Ids {
    return { device_id: deviceId || devEui.toLowerCase(), dev_eui: devEui.toUpperCase(), join_eui: joinEui.toUpperCase(),
             application_ids: { application_id: appId } };
  }

  // ------------------------------------------------------------ applications et webhook (§6.2)

  /** L'attribut mobilab_ferme dit à qui est l'application : une reprise ne prend jamais l'app d'un autre. */
  async creerApplication(appId: string, nom: string, slug: string) {
    return this.appel("POST", `/api/v3/organizations/${enc(this.cfg.orgId)}/applications`, {
      application: { ids: { application_id: appId }, name: nom.slice(0, 50), attributes: { mobilab_ferme: slug },
        network_server_address: this.cfg.host, application_server_address: this.cfg.host, join_server_address: this.cfg.host },
    }, { existeOk: true });
  }

  /** null : l'id est libre ; { attributes } : elle existe ; { inaccessible } : elle existe, chez quelqu'un d'autre. */
  async lireApplication(appId: string): Promise<{ attributes?: Record<string, string>; inaccessible?: boolean } | null> {
    try {
      return await this.appel("GET", `/api/v3/applications/${enc(appId)}?field_mask=attributes`, undefined, { absentOk: true });
    } catch (e) {
      if (e instanceof ErreurApi && e.status === 403) return { inaccessible: true };
      throw e;
    }
  }

  async supprimerApplication(appId: string) {
    return this.appel("DELETE", `/api/v3/applications/${enc(appId)}`, undefined, { absentOk: true });
  }

  async ecrireWebhook(appId: string) {
    const chemins = ["uplink_message", "join_accept", "downlink_queued", "downlink_sent", "downlink_ack", "downlink_nack", "downlink_failed"];
    const corps: any = {
      webhook: {
        ids: { application_ids: { application_id: appId }, webhook_id: "mobilab" },
        base_url: this.cfg.webhookUrl, format: "json",
        headers: { "X-Mobilab-Secret": this.cfg.webhookSecret },
        uplink_message: { path: "/uplink" }, join_accept: { path: "/join" },
        downlink_queued: { path: "/downlink" }, downlink_sent: { path: "/downlink" }, downlink_ack: { path: "/downlink" },
        downlink_nack: { path: "/downlink" }, downlink_failed: { path: "/downlink" },
      },
      field_mask: { paths: ["base_url", "format", "headers", ...chemins] },
    };
    return this.appel("PUT", `/api/v3/as/webhooks/${enc(appId)}/mobilab`, corps);
  }

  async lireWebhook(appId: string) {
    return this.appel("GET", `/api/v3/as/webhooks/${enc(appId)}/mobilab?field_mask=base_url,health_status,headers`, undefined, { absentOk: true });
  }

  async supprimerWebhook(appId: string) {
    return this.appel("DELETE", `/api/v3/as/webhooks/${enc(appId)}/mobilab`, undefined, { absentOk: true });
  }

  // ------------------------------------------------------------ devices (§6.5)

  async creerDeviceIS(appId: string, devEui: string, joinEui: string, nom: string, tenant: string, modele: string | null,
    version?: VersionIds | null, deviceId?: string) {
    const end_device: any = {
      ids: this.ids(appId, devEui, joinEui, deviceId), name: nom.slice(0, 50),
      attributes: { tenant, ...(modele ? { model: modele } : {}) },
      join_server_address: this.cfg.host, network_server_address: this.cfg.host, application_server_address: this.cfg.host,
    };
    const paths = ["name", "attributes", "join_server_address", "network_server_address", "application_server_address"];
    if (version) { end_device.version_ids = version; paths.push("version_ids"); }
    return this.appel("POST", `/api/v3/applications/${enc(appId)}/devices`, { end_device, field_mask: { paths } }, { existeOk: true });
  }

  async ecrireCleJS(appId: string, devEui: string, joinEui: string, appKey: string, deviceId?: string) {
    const ids = { ...this.ids(appId, devEui, joinEui), device_id: deviceId || devEui.toLowerCase() };
    return this.appel("PUT", `/api/v3/js/applications/${enc(appId)}/devices/${enc(ids.device_id)}`, {
      end_device: { ids, root_keys: { app_key: { key: appKey.toUpperCase() } },
        network_server_address: this.cfg.host, application_server_address: this.cfg.host },
      field_mask: { paths: ["root_keys.app_key.key", "network_server_address", "application_server_address"] },
    });
  }

  async ecrireNS(appId: string, devEui: string, joinEui: string, lorawan: { mac?: string; phy?: string } = {}, version?: VersionIds | null, deviceId?: string) {
    const end_device: any = {
      ids: this.ids(appId, devEui, joinEui, deviceId), supports_join: true,
      lorawan_version: lorawan.mac || this.cfg.defaultMac, lorawan_phy_version: lorawan.phy || this.cfg.defaultPhy,
      frequency_plan_id: this.cfg.frequencyPlan, mac_settings: { supports_32_bit_f_cnt: true },
    };
    const paths = ["supports_join", "lorawan_version", "lorawan_phy_version", "frequency_plan_id", "mac_settings.supports_32_bit_f_cnt"];
    if (version) { end_device.version_ids = version; paths.push("version_ids"); }
    return this.appel("PUT", `/api/v3/ns/applications/${enc(appId)}/devices/${enc(end_device.ids.device_id)}`, { end_device, field_mask: { paths } });
  }

  async ecrireAS(appId: string, devEui: string, joinEui: string, version?: VersionIds | null, deviceId?: string) {
    const end_device: any = { ids: this.ids(appId, devEui, joinEui, deviceId) };
    const paths = ["ids.device_id", "ids.dev_eui", "ids.join_eui", "ids.application_ids.application_id"];
    if (version) { end_device.version_ids = version; paths.push("version_ids"); }
    return this.appel("PUT", `/api/v3/as/applications/${enc(appId)}/devices/${enc(end_device.ids.device_id)}`, { end_device, field_mask: { paths } });
  }

  async ecrireIS(appId: string, devEui: string, champs: { name?: string; version_ids?: VersionIds }) {
    const paths = Object.keys(champs);
    return this.appel("PUT", `/api/v3/applications/${enc(appId)}/devices/${enc(devEui.toLowerCase())}`, {
      end_device: { ids: { device_id: devEui.toLowerCase(), application_ids: { application_id: appId } }, ...champs },
      field_mask: { paths },
    });
  }

  async supprimerDevice(serveur: "as" | "ns" | "js" | "is", appId: string, devEui: string) {
    const prefixe = serveur === "is" ? "" : `/${serveur}`;
    return this.appel("DELETE", `/api/v3${prefixe}/applications/${enc(appId)}/devices/${enc(devEui.toLowerCase())}`, undefined, { absentOk: true });
  }

  /** Les 4 suppressions, dans l'ordre de la CLI : AS, NS, JS, IS. */
  async supprimerPartout(appId: string, devEui: string) {
    for (const s of ["as", "ns", "js", "is"] as const) await this.supprimerDevice(s, appId, devEui);
  }

  async lireDevice(serveur: "as" | "ns" | "js" | "is", appId: string, devEui: string) {
    const prefixe = serveur === "is" ? "" : `/${serveur}`;
    const champs = { is: "name,version_ids", js: "root_keys.app_key", ns: "frequency_plan_id,lorawan_version", as: "ids" }[serveur];
    return this.appel("GET", `/api/v3${prefixe}/applications/${enc(appId)}/devices/${enc(devEui.toLowerCase())}?field_mask=${champs}`, undefined, { absentOk: true });
  }

  async listerDevices(appId: string): Promise<string[]> {
    const r = await this.appel("GET", `/api/v3/applications/${enc(appId)}/devices?field_mask=ids&limit=1000`, undefined, { absentOk: true });
    return ((r && r.end_devices) || []).map((d: any) => String(d.ids?.dev_eui || d.ids?.device_id || "").toLowerCase());
  }

  /** Capteurs d'une application, avec leurs identifiants et version_ids (reprise d'une app existante). */
  async devicesDetail(appId: string): Promise<{ device_id: string; dev_eui: string; join_eui: string; name: string; version_ids: any }[]> {
    const r = await this.appel("GET", `/api/v3/applications/${enc(appId)}/devices?field_mask=name,version_ids&limit=1000`);
    return (r.end_devices || []).map((d: any) => ({ device_id: d.ids?.device_id, dev_eui: String(d.ids?.dev_eui || "").toLowerCase(),
      join_eui: String(d.ids?.join_eui || "").toLowerCase(), name: d.name || "", version_ids: d.version_ids || null }));
  }

  async webhooks(appId: string): Promise<{ id: string; base_url: string }[]> {
    const r = await this.appel("GET", `/api/v3/as/webhooks/${enc(appId)}?field_mask=base_url`);
    return (r.webhooks || []).map((w: any) => ({ id: w.ids?.webhook_id, base_url: w.base_url || "" }));
  }

  async supprimerWebhookId(appId: string, id: string) {
    return this.appel("DELETE", `/api/v3/as/webhooks/${enc(appId)}/${enc(id)}`, undefined, { absentOk: true });
  }

  // ------------------------------------------------------------ downlinks (§6.8)

  async pousserDownlink(appId: string, devEui: string, d: { f_port: number; payload_hex: string; confirmed: boolean; correlation: string }) {
    return this.appel("POST", `/api/v3/as/applications/${enc(appId)}/devices/${enc(devEui.toLowerCase())}/down/push`, {
      downlinks: [{ f_port: d.f_port, frm_payload: Buffer.from(d.payload_hex, "hex").toString("base64"), priority: "NORMAL",
                    confirmed: d.confirmed, correlation_ids: [d.correlation] }],
    });
  }

  async viderFile(appId: string, devEui: string) {
    return this.appel("POST", `/api/v3/as/applications/${enc(appId)}/devices/${enc(devEui.toLowerCase())}/down/replace`, { downlinks: [] });
  }

  async lireFile(appId: string, devEui: string): Promise<any[]> {
    const r = await this.appel("GET", `/api/v3/as/applications/${enc(appId)}/devices/${enc(devEui.toLowerCase())}/down`, undefined, { absentOk: true });
    return (r && r.downlinks) || [];
  }

  // ------------------------------------------------------------ contrôles (§2.5)

  async droits(appId: string): Promise<string[]> {
    const r = await this.appel("GET", `/api/v3/applications/${enc(appId)}/rights`);
    return r.rights || [];
  }

  async plansFrequence(): Promise<string[]> {
    const r = await this.appel("GET", `/api/v3/configuration/frequency-plans`);
    return (r.frequency_plans || []).map((p: any) => p.id);
  }

  async listerApplications(): Promise<string[]> {
    const r = await this.appel("GET", `/api/v3/organizations/${enc(this.cfg.orgId)}/applications?field_mask=ids&limit=1000`);
    return (r.applications || []).map((a: any) => a.ids?.application_id);
  }
}

function enc(s: string) { return encodeURIComponent(s); }

function codeGrpc(n: unknown): string {
  const codes: Record<number, string> = { 3: "INVALID_ARGUMENT", 5: "NOT_FOUND", 6: "ALREADY_EXISTS", 7: "PERMISSION_DENIED",
    9: "FAILED_PRECONDITION", 14: "UNAVAILABLE", 16: "UNAUTHENTICATED" };
  return typeof n === "number" ? codes[n] || "" : "";
}
