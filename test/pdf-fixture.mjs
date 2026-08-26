import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";

export async function textPdf(pageTexts = ["First PDF page", "Second PDF page"]) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const text of pageTexts) {
    const page = document.addPage([612, 792]);
    page.drawText(text, { x: 72, y: 720, size: 20, font });
  }
  return new Uint8Array(await document.save());
}

export async function imagePdf() {
  const canvas = createCanvas(400, 240);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#1d4ed8";
  context.fillRect(30, 30, 340, 180);
  context.fillStyle = "#ffffff";
  context.font = "bold 28px sans-serif";
  context.fillText("SCANNED PAGE", 80, 130);

  const document = await PDFDocument.create();
  const image = await document.embedPng(canvas.toBuffer("image/png"));
  const page = document.addPage([612, 792]);
  page.drawImage(image, { x: 72, y: 360, width: 468, height: 281 });
  return new Uint8Array(await document.save());
}
