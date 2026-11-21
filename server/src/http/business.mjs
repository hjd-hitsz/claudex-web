import { createMaintenanceHandler } from "./maintenance.mjs";
import { serveFile } from "../file-content.mjs";
import {
  createSummaryTranslationHandler,
  createTranslationSettingsHandler,
} from "../summary-translation.mjs";

export function createBusinessHttpHandler({ translation, maintenance }) {
  const handleMaintenance = createMaintenanceHandler(maintenance);
  const translate = createSummaryTranslationHandler(translation.translate);
  const translationSettings = createTranslationSettingsHandler(translation);
  return (request, response, path) => {
    if (path === "/api/files" || path === "/api/media")
      return serveFile(request, response);
    if (path === "/api/translation")
      return translationSettings(request, response);
    if (path === "/api/translate") return translate(request, response);
    if (/^\/api\/maintenance(?:\/|$)/.test(path))
      return handleMaintenance(request, response, path);
  };
}
