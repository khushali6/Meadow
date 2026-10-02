import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

export const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia(QUERY).matches;

/** Live reduced-motion preference for the GSAP and Anime.js layers (Motion reads it through MotionConfig). */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const media = window.matchMedia(QUERY);
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

export const isCompact = () => typeof window !== "undefined" && window.matchMedia("(max-width: 820px)").matches;
