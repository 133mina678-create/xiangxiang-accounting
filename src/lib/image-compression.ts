import {
  MAX_PROOF_UPLOAD_BYTES,
  validateTransferProofFile,
} from "./transfer-state";

const TARGET_BYTES = 1_900_000;
const MAX_EDGE = 1600;

function canvasBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("圖片壓縮失敗"))),
      "image/webp",
      quality,
    ),
  );
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("無法讀取這張圖片"));
    image.src = url;
  });
}

export async function compressTransferProof(file: File) {
  const validation = validateTransferProofFile(file);
  if (validation) throw new Error(validation);
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(sourceUrl);
    const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    let width = Math.max(1, Math.round(image.naturalWidth * scale));
    let height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("此瀏覽器無法處理圖片");
    let output: Blob | null = null;
    for (let resize = 0; resize < 4; resize += 1) {
      canvas.width = width;
      canvas.height = height;
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      for (const quality of [0.92, 0.86, 0.8, 0.74]) {
        output = await canvasBlob(canvas, quality);
        if (output.size <= TARGET_BYTES) break;
      }
      if (output && output.size <= TARGET_BYTES) break;
      width = Math.max(1, Math.round(width * 0.85));
      height = Math.max(1, Math.round(height * 0.85));
    }
    if (!output || output.size > MAX_PROOF_UPLOAD_BYTES)
      throw new Error("圖片壓縮後仍超過 2 MB，請改用較小的圖片。");
    return new File([output], "proof.webp", {
      type: "image/webp",
      lastModified: Date.now(),
    });
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}
