import { adminView } from "./admin.js";
import { catalogView } from "./catalog.js";
import { computeView } from "./compute.js";
import { dashboardView } from "./dashboard.js";
import { databaseView } from "./database.js";
import { monitoringView } from "./monitoring.js";
import { networkView } from "./network.js";
import { storageView } from "./storage.js";

export const views = [
  dashboardView,
  computeView,
  databaseView,
  networkView,
  storageView,
  catalogView,
  monitoringView,
  adminView,
];

export function getView(viewId) {
  return views.find((view) => view.id === viewId) || dashboardView;
}
