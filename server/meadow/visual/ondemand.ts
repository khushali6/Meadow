import { getProject, parsedActivePlan } from "../projects";
import { captureRoutes, type Shot } from "./capture";
import { startPreview } from "./preview";

/** Capture the project's current state on request, starting (and always stopping) its preview server. */
export async function captureOnDemand(projectId: number, route: string | null): Promise<{ shots: Shot[]; skipped: string[] }> {
  const project = getProject(projectId);
  const active = parsedActivePlan(projectId);
  if (!active?.plan.preview) return { shots: [], skipped: ["This project has no preview block in its plan, so there is nothing to screenshot."] };
  const preview = active.plan.preview;
  const routes = route ? [route.startsWith("/") ? route : `/${route}`] : preview.routes;
  const handle = await startPreview(preview, project.path);
  try {
    return await captureRoutes({ baseUrl: preview.url, routes, projectPath: project.path, projectId, phaseId: null, folder: `on-demand-${Date.now()}` });
  } finally {
    handle.stop();
  }
}
