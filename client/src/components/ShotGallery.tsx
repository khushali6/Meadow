import { ChevronLeft, ChevronRight, ExternalLink, Maximize2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, UI_EASE } from "./animation/motion";
import { relativeTime } from "./common";
import { screenshotUrl } from "../lib/api";

export type Shot = { id: number; label: string; meta?: string; ts?: string };

/** One featured screenshot, a thumbnail strip to switch it, and a full-screen viewer with arrow-key navigation. */
export function ShotGallery({ shots, empty }: { shots: Shot[]; empty?: string }) {
  const [index, setIndex] = useState(0);
  const [viewer, setViewer] = useState(false);
  const safe = Math.min(index, Math.max(0, shots.length - 1));
  const shot = shots[safe];

  useEffect(() => {
    if (!viewer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setViewer(false);
      if (event.key === "ArrowRight") setIndex(i => Math.min(shots.length - 1, i + 1));
      if (event.key === "ArrowLeft") setIndex(i => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer, shots.length]);

  if (!shot) return empty ? <div className="event-empty">{empty}</div> : null;
  const caption = (item: Shot) => [item.meta, item.ts ? relativeTime(item.ts) : ""].filter(Boolean).join(" · ");

  return (
    <div className="gallery">
      <figure className="gallery-feature">
        <button className="gallery-frame" onClick={() => setViewer(true)} aria-label={`Open ${shot.label} full screen`}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.img key={shot.id} src={screenshotUrl(shot.id)} alt={shot.label} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.22, ease: UI_EASE }} />
          </AnimatePresence>
          <span className="gallery-expand"><Maximize2 size={13} /></span>
        </button>
        <figcaption>
          <span className="gallery-count">{String(safe + 1).padStart(2, "0")} / {String(shots.length).padStart(2, "0")}</span>
          <strong>{shot.label}</strong>
          <span>{caption(shot)}</span>
        </figcaption>
      </figure>
      {shots.length > 1 ? (
        <div className="gallery-strip" role="listbox" aria-label="Screenshots">
          {shots.map((item, i) => (
            <button key={item.id} role="option" aria-selected={i === safe} className={i === safe ? "selected" : undefined} onClick={() => setIndex(i)} title={item.label}>
              <img src={screenshotUrl(item.id)} alt="" loading="lazy" />
              {i === safe ? <motion.span layoutId="gallery-marker" className="gallery-marker" transition={{ type: "spring", stiffness: 520, damping: 40 }} /> : null}
            </button>
          ))}
        </div>
      ) : null}
      {createPortal(
        <AnimatePresence>
          {viewer ? (
            <motion.div className="viewer" role="dialog" aria-modal="true" aria-label={shot.label} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} onMouseDown={event => event.target === event.currentTarget && setViewer(false)}>
              <div className="viewer-bar">
                <span className="gallery-count">{String(safe + 1).padStart(2, "0")} / {String(shots.length).padStart(2, "0")}</span>
                <strong>{shot.label}</strong>
                <a className="icon-button" href={screenshotUrl(shot.id)} target="_blank" rel="noreferrer" aria-label="Open the image in a new tab"><ExternalLink size={15} /></a>
                <button className="icon-button" onClick={() => setViewer(false)} aria-label="Close"><X size={16} /></button>
              </div>
              <motion.img key={shot.id} className="viewer-image" src={screenshotUrl(shot.id)} alt={shot.label} initial={{ opacity: 0, y: 10, scale: 0.99 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 380, damping: 36 }} />
              {shots.length > 1 ? (
                <>
                  <button className="viewer-nav prev" disabled={safe === 0} onClick={() => setIndex(safe - 1)} aria-label="Previous screenshot"><ChevronLeft size={20} /></button>
                  <button className="viewer-nav next" disabled={safe === shots.length - 1} onClick={() => setIndex(safe + 1)} aria-label="Next screenshot"><ChevronRight size={20} /></button>
                </>
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
