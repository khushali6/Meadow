import { Command } from "cmdk";
import type { LucideIcon } from "lucide-react";
import { CornerDownLeft, FolderGit2, Moon, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "./animation/motion";
import { StatusTag } from "./common";
import type { ProjectSummary } from "../lib/types";

export type PaletteRoute = { key: string; label: string; icon: LucideIcon };

/** ⌘K / Ctrl-K: jump to any page, switch project, or toggle the theme. */
export function CommandPalette({ routes, projects, activeId, onNavigate, onProject, onToggleTheme }: { routes: readonly PaletteRoute[]; projects: ProjectSummary[]; activeId: number | null; onNavigate: (path: string) => void; onProject: (id: number) => void; onToggleTheme: () => void }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(value => !value);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("meadow:palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("meadow:palette", onOpen);
    };
  }, []);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div className="palette-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} onMouseDown={event => event.target === event.currentTarget && setOpen(false)}>
          <motion.div initial={{ opacity: 0, y: -8, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.985 }} transition={{ type: "spring", stiffness: 460, damping: 38 }}>
            <Command className="palette" label="Command menu" loop onKeyDown={event => event.key === "Escape" && setOpen(false)}>
              <div className="palette-input"><Search size={15} /><Command.Input autoFocus placeholder="Jump to a page or project…" /><kbd>esc</kbd></div>
              <Command.List className="palette-list">
                <Command.Empty className="palette-empty">Nothing matches.</Command.Empty>
                <Command.Group heading="Pages">
                  {routes.map((route, i) => (
                    <Command.Item key={route.key} value={`page ${route.label}`} onSelect={() => run(() => onNavigate(route.key))}>
                      <span className="palette-index">{String(i + 1).padStart(2, "0")}</span><route.icon size={15} /><span>{route.label}</span><CornerDownLeft size={12} className="palette-enter" />
                    </Command.Item>
                  ))}
                </Command.Group>
                {projects.length ? (
                  <Command.Group heading="Projects">
                    {projects.map(project => (
                      <Command.Item key={project.id} value={`project ${project.name} ${project.goal ?? ""}`} onSelect={() => run(() => onProject(project.id))}>
                        <span className="palette-index">{project.id === activeId ? "●" : ""}</span><FolderGit2 size={15} /><span>{project.name}</span><StatusTag status={project.status} />
                      </Command.Item>
                    ))}
                  </Command.Group>
                ) : null}
                <Command.Group heading="Actions">
                  <Command.Item value="toggle theme dark light" onSelect={() => run(onToggleTheme)}><span className="palette-index" /><Moon size={15} /><span>Toggle light / dark</span></Command.Item>
                </Command.Group>
              </Command.List>
            </Command>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
