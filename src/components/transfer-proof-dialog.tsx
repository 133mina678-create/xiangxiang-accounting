"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { ImagePlus, RefreshCw, ShieldCheck, Upload } from "lucide-react";
import { compressTransferProof } from "@/lib/image-compression";
import { transferProofUrl } from "@/lib/api";
import { validateTransferProofFile } from "@/lib/transfer-state";
import { money } from "@/lib/types";
import type { Member } from "@/lib/types";
import { Modal, Person } from "./forms";

export function TransferProofDialog({
  payer,
  recipient,
  amount,
  reupload = false,
  onClose,
  onSubmit,
}: {
  payer: Member;
  recipient: Member;
  amount: number;
  reupload?: boolean;
  onClose: () => void;
  onSubmit: (file: File) => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [stage, setStage] = useState<"idle" | "compressing" | "uploading">("idle");
  const input = useRef<HTMLInputElement>(null);
  const previewRef = useRef("");
  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );
  const choose = (next: File | undefined) => {
    if (!next) return;
    const message = validateTransferProofFile(next);
    if (message) {
      setError(message);
      setFile(null);
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = "";
      setPreview("");
      return;
    }
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = URL.createObjectURL(next);
    setError("");
    setFile(next);
    setPreview(previewRef.current);
  };
  const submit = async () => {
    if (!file || stage !== "idle") return;
    try {
      setError("");
      setStage("compressing");
      const compressed = await compressTransferProof(file);
      setStage("uploading");
      await onSubmit(compressed);
    } catch (caught) {
      setError((caught as Error).message);
      setStage("idle");
    }
  };
  const working = stage !== "idle";
  return (
    <Modal title={reupload ? "重新上傳轉帳證明" : "上傳轉帳證明"} onClose={working ? () => undefined : onClose}>
      <div className="proof-transfer-summary">
        <Person member={payer} />
        <span>轉給</span>
        <Person member={recipient} />
        <strong>{money(amount)}</strong>
      </div>
      <p className="hint">請選擇一張清楚的轉帳截圖。確認完成後，圖片會立即刪除。</p>
      <input
        ref={input}
        className="visually-hidden"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        aria-label="選擇轉帳證明圖片"
        onChange={(event) => choose(event.target.files?.[0])}
      />
      {!preview ? (
        <button className="proof-picker" type="button" disabled={working} onClick={() => input.current?.click()}>
          <ImagePlus size={26} />
          <strong>從相簿選擇或拍照</strong>
          <span>JPG、PNG、WebP，原始圖片上限 10 MB</span>
        </button>
      ) : (
        <div className="proof-preview">
          <div className="proof-image-frame">
            <Image src={preview} alt="待上傳的轉帳證明預覽" fill unoptimized sizes="(max-width: 600px) 90vw, 520px" />
          </div>
          <button className="secondary full" type="button" disabled={working} onClick={() => input.current?.click()}>
            <RefreshCw size={16} /> 重新選擇
          </button>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="privacy-inline"><ShieldCheck size={17} /> 私密儲存，僅付款雙方可在完成前查看。</div>
      <div className="two-col">
        <button className="secondary" disabled={working} onClick={onClose}>取消</button>
        <button className="primary" disabled={!file || working} onClick={() => void submit()}>
          <Upload size={17} />
          {stage === "compressing" ? "正在壓縮…" : stage === "uploading" ? "正在上傳…" : "確認提交"}
        </button>
      </div>
    </Modal>
  );
}

export function TransferProofViewer({
  secret,
  paymentId,
  actor,
  onClose,
}: {
  secret: string;
  paymentId: string;
  actor: string;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void transferProofUrl(secret, paymentId, actor)
      .then((next) => {
        if (active) setUrl(next);
      })
      .catch((caught) => {
        if (active) setError((caught as Error).message);
      });
    return () => {
      active = false;
    };
  }, [actor, paymentId, secret]);
  return (
    <Modal title="轉帳證明" onClose={onClose}>
      {!url && !error && <p className="proof-loading">正在取得私密圖片…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {url && (
        <div className="proof-viewer-frame">
          <Image src={url} alt="轉帳證明" fill unoptimized sizes="(max-width: 600px) 94vw, 680px" />
        </div>
      )}
      <p className="hint">此檢視連結只有短時間有效，交易完成後圖片會立即刪除。</p>
    </Modal>
  );
}
