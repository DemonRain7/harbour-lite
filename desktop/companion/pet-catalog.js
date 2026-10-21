"use strict";

const SAFE_PET_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SAFE_MAIN_AGENT = /^main-[a-z0-9][a-z0-9_-]{0,79}$/;

const BUILTIN_PETS = Object.freeze({
  elaina: Object.freeze({ id: "elaina", agentName: "main-elaina", displayName: "Elaina" }),
  aemeath: Object.freeze({ id: "aemeath", agentName: "main-aemeath", displayName: "Aemeath" }),
});

function displayNameFromId(id) {
  return String(id || "")
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Companion";
}

/**
 * A future main character can be enabled with just `pets: ["name"]`.  An object form is
 * available when the agent name or display label does not follow the conventional mapping.
 */
function normalizePetDefinition(input) {
  const source = typeof input === "string" ? { id: input } : input && typeof input === "object" ? input : {};
  const id = String(source.id || "").trim().toLowerCase();
  if (!SAFE_PET_ID.test(id)) return null;
  const builtin = BUILTIN_PETS[id] || {};
  const requestedAgent = String(source.agentName || source.agent || builtin.agentName || `main-${id}`).trim().toLowerCase();
  const agentName = SAFE_MAIN_AGENT.test(requestedAgent) ? requestedAgent : `main-${id}`;
  const requestedLabel = String(source.displayName || source.label || builtin.displayName || displayNameFromId(id))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 80);
  return { id, agentName, displayName: requestedLabel || displayNameFromId(id) };
}

function resolvePetDefinitions(inputs) {
  const rows = new Map();
  for (const input of Array.isArray(inputs) ? inputs : []) {
    const pet = normalizePetDefinition(input);
    if (pet) rows.set(pet.id, pet);
  }
  return [...rows.values()];
}

function buildPetCatalog(configured = []) {
  const catalog = { ...BUILTIN_PETS };
  for (const pet of resolvePetDefinitions(configured)) catalog[pet.id] = pet;
  return catalog;
}

module.exports = {
  BUILTIN_PETS,
  buildPetCatalog,
  displayNameFromId,
  normalizePetDefinition,
  resolvePetDefinitions,
};
