import type { Catalog } from "../types";
import { pruneCatalogForSimulation } from "../lib/catalogQuality";
import { catalogSchema } from "./schemas";

type CatalogSection = Catalog[keyof Catalog][number];

function sortedValues<T extends CatalogSection>(modules: Record<string, T>): T[] {
  return Object.values(modules).sort((left, right) => left.id.localeCompare(right.id));
}

const hardwareModules = import.meta.glob("../../data/hardware/*.json", {
  eager: true,
  import: "default"
}) as Record<string, Catalog["hardware"][number]>;

const modelModules = import.meta.glob("../../data/models/*.json", {
  eager: true,
  import: "default"
}) as Record<string, Catalog["models"][number]>;

const resultModules = import.meta.glob("../../data/results/*.json", {
  eager: true,
  import: "default"
}) as Record<string, Catalog["results"][number]>;

const scenarioModules = import.meta.glob("../../scenarios/*/script.json", {
  eager: true,
  import: "default"
}) as Record<string, Catalog["scenarios"][number]>;

const rawCatalog = {
  hardware: sortedValues(hardwareModules),
  models: sortedValues(modelModules),
  results: sortedValues(resultModules),
  scenarios: sortedValues(scenarioModules)
};

export function validateCatalog(input: unknown): Catalog {
  return catalogSchema.parse(input) as Catalog;
}

export const catalog = validateCatalog(pruneCatalogForSimulation(validateCatalog(rawCatalog)));

const parsedCatalog = catalog;

export const hardware = parsedCatalog.hardware;
export const models = parsedCatalog.models;
export const results = parsedCatalog.results;
export const scenarios = parsedCatalog.scenarios;

export function hardwareById(id: string) {
  return hardware.find((item) => item.id === id);
}

export function modelById(id: string) {
  return models.find((item) => item.id === id);
}

export function resultById(id: string) {
  return results.find((item) => item.id === id);
}

export function scenarioById(id: string) {
  return scenarios.find((item) => item.id === id);
}
