// Fiche à imprimer (spec V3 §5.4) : une page par ferme, nom, QR d'activation, adresse Grafana, login,
// mot de passe. Générée en mémoire, envoyée à l'admin, gardée nulle part.
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { admin as T } from "./textes.fr.js";

export interface PageFiche { ferme: string; lien: string; adresse: string; login: string; motDePasse: string }

export async function qrPng(texte: string): Promise<Buffer> {
  return QRCode.toBuffer(texte, { type: "png", errorCorrectionLevel: "M", margin: 2, width: 600 });
}

export async function fichePdf(pages: PageFiche[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 56, autoFirstPage: false, info: { Title: "Mobilab", Author: "Mobilab" } });
  const morceaux: Buffer[] = [];
  doc.on("data", (d: Buffer) => morceaux.push(d));
  const fini = new Promise<void>(r => doc.on("end", () => r()));
  for (const p of pages) {
    doc.addPage();
    doc.font("Helvetica-Bold").fontSize(26).text(p.ferme, { align: "center" });
    doc.moveDown(0.5).font("Helvetica").fontSize(13).fillColor("#444").text("Vos capteurs Mobilab : mesures, alertes, graphiques.", { align: "center" });
    doc.fillColor("black");
    const qr = await qrPng(p.lien);
    const taille = 260;
    doc.image(qr, (doc.page.width - taille) / 2, 170, { width: taille });
    doc.font("Helvetica-Bold").fontSize(15).text(T.fiche_scanner, 56, 450, { align: "center", width: doc.page.width - 112 });
    doc.moveDown(2).font("Helvetica-Bold").fontSize(14).text("Vos graphiques");
    doc.font("Helvetica").fontSize(13).text(`Adresse : ${p.adresse}`).text(`Identifiant : ${p.login}`).text(`Mot de passe : ${p.motDePasse}`);
    doc.moveDown(1).fontSize(10).fillColor("#666").text("Gardez cette fiche en lieu sûr : le mot de passe n'est écrit nulle part ailleurs.");
    doc.fillColor("black");
  }
  doc.end();
  await fini;
  return Buffer.concat(morceaux);
}
