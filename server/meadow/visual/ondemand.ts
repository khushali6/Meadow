import { getProject, parsedActivePlan } from "../projects";
import { captureRoutes, type Shot } from "./capture";
import { detectLaunch, launchApp } from "./launch";

/** Capture the project's current state on request, starting (and always stopping) the app. */
export async function captureOnDemand(projectId: number, route: string | null): Promise<{ shots: Shot[]; skipped: string[] }> {
  const project = getProject(projectId);
  const spec = await detectLaunch(project.path, parsedActivePlan(projectId)?.plan ?? null);
  if (!spec) return { shots: [], skipped: ["This project has no web page to open (no preview block, dev script, Python web app or index.html)."] };
  const routes = route ? [route.startsWith("/") ? route : `/${route}`] : spec.routes;
  const handle = await launchApp(spec, project.path);
  try {
    return await captureRoutes({ baseUrl: handle.url, routes, projectPath: project.path, projectId, phaseId: null, folder: `on-demand-${Date.now()}` });
  } finally {
    handle.stop();
  }
}
