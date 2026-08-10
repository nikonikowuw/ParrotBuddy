import { useState, type ReactNode } from "react";
import { ImageIcon, PlaySquare } from "lucide-react";
import { useTranslation } from "react-i18next";

import { FileReferenceIcon, fileKindForPath } from "@/components/FileReferenceChip";
import { cn } from "@/lib/utils";
import type { UIMediaAttachment } from "@/lib/types";

interface AttachmentTileProps {
  attachment: UIMediaAttachment;
  className?: string;
  inline?: boolean;
  variant?: "default" | "compact";
  /** When set, previewable file attachments open the preview panel instead of downloading. */
  onOpen?: (path: string) => void;
}

export function AttachmentTile({ attachment, className, inline = false, variant = "default", onOpen }: AttachmentTileProps) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const hasUrl = typeof attachment.url === "string" && attachment.url.length > 0;
  const label = attachmentLabel(attachment, t);

  if (attachment.kind === "image" && hasUrl && !failed) {
    return (
      <AttachmentFrame
        attachment={attachment}
        className={className}
        inline={inline}
        variant={variant}
      >
        <a
          href={attachment.url}
          target="_blank"
          rel="noreferrer noopener"
          className="block bg-muted/20"
          aria-label={attachment.name ? `Open ${attachment.name}` : t("lightbox.open", { defaultValue: "Open image" })}
        >
          <img
            src={attachment.url}
            alt={attachment.name ?? ""}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setFailed(true)}
            className={cn(
              "block h-auto max-w-full bg-background object-contain",
              variant === "compact" ? "max-h-40" : "max-h-[34rem]",
            )}
          />
        </a>
      </AttachmentFrame>
    );
  }

  if (attachment.kind === "video" && hasUrl) {
    return (
      <AttachmentFrame
        attachment={attachment}
        className={className}
        inline={inline}
        variant={variant}
      >
        <video
          src={attachment.url}
          controls
          preload="auto"
          className={cn(
            "block w-full bg-black",
            variant === "compact" ? "max-h-40" : "max-h-[26rem]",
          )}
          aria-label={attachment.name ? `${t("message.videoAttachment", { defaultValue: "Video attachment" })}: ${attachment.name}` : t("message.videoAttachment", { defaultValue: "Video attachment" })}
        />
      </AttachmentFrame>
    );
  }

  const Icon = attachment.kind === "video"
    ? PlaySquare
    : attachment.kind === "image"
      ? ImageIcon
      : null;
  const body = (
    <>
      {attachment.kind === "file" ? (
        <span
          className="flex h-4 w-4 flex-none items-center justify-center text-[1.05rem] leading-none"
          aria-hidden
        >
          <FileReferenceIcon kind={fileKindForPath(attachment.name ?? "")} />
        </span>
      ) : Icon ? (
        <Icon className="h-4 w-4 flex-none" aria-hidden />
      ) : null}
      <span className="min-w-0 truncate">{attachment.name ?? label}</span>
    </>
  );

  const previewable = attachment.kind === "file"
    && typeof onOpen === "function"
    && typeof attachment.path === "string"
    && attachment.path.length > 0;
  const tileClassName = cn(
    "flex max-w-[18rem] items-center gap-2 rounded-[14px]",
    "border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground",
    "transition-colors hover:bg-muted/55 hover:text-foreground",
    variant === "compact" && "max-w-[14rem] rounded-xl px-2.5 py-1.5 text-[11.5px]",
    className,
  );

  if (previewable) {
    return (
      <button
        type="button"
        onClick={() => onOpen(attachment.path as string)}
        title={attachment.name ?? undefined}
        aria-label={label}
        className={cn(
          tileClassName,
          "cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        {body}
      </button>
    );
  }

  if (hasUrl && !failed) {
    return (
      <a
        href={attachment.url}
        download={attachment.name ?? label}
        title={attachment.name ?? undefined}
        aria-label={label}
        className={tileClassName}
      >
        {body}
      </a>
    );
  }

  return (
    <div
      className={cn(
        "flex max-w-[18rem] items-center gap-2 rounded-[14px]",
        "border border-border/60 bg-muted/35 px-3 py-2 text-xs text-muted-foreground",
        variant === "compact" && "max-w-[14rem] rounded-xl px-2.5 py-1.5 text-[11.5px]",
        className,
      )}
      title={attachment.name ?? undefined}
      aria-label={label}
    >
      {body}
      <span className="sr-only">
        {t("message.attachmentUnavailable", { defaultValue: "Attachment unavailable" })}
      </span>
    </div>
  );
}

function AttachmentFrame({
  attachment,
  children,
  className,
  inline = false,
  variant = "default",
}: {
  attachment: UIMediaAttachment;
  children: ReactNode;
  className?: string;
  inline?: boolean;
  variant?: "default" | "compact";
}) {
  const frameClassName = cn(
    "not-prose my-3 block w-fit max-w-full overflow-hidden rounded-[14px]",
    "border border-border/60 bg-muted/40",
    attachment.kind === "image" && "bg-background/85",
    attachment.kind === "video" ? "w-[min(100%,32rem)]" : "",
    variant === "compact" && "my-1 rounded-xl shadow-none",
    variant === "compact" && attachment.kind === "video" && "w-[min(100%,20rem)]",
    className,
  );
  const bodyClassName = "block max-w-full";
  const body = inline ? (
    <span className={bodyClassName}>{children}</span>
  ) : (
    <div className={bodyClassName}>{children}</div>
  );
  return inline ? (
    <span className={frameClassName}>
      {body}
    </span>
  ) : (
    <figure className={frameClassName}>
      {body}
    </figure>
  );
}

function attachmentLabel(attachment: UIMediaAttachment, t: ReturnType<typeof useTranslation>["t"]): string {
  if (attachment.kind === "video") {
    return t("message.videoAttachment", { defaultValue: "Video attachment" });
  }
  if (attachment.kind === "image") {
    return t("message.imageAttachment", { defaultValue: "Image attachment" });
  }
  return t("message.fileAttachment", { defaultValue: "File attachment" });
}
