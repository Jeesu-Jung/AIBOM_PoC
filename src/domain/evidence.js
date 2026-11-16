// Per-value evidence rows: { area, itemKey, field, url, locator, confidence, note, source }.
// `locator` says where in the source the value is (e.g. "Table 2 (Main results), row ...").
// The backend builds them for every research result (backend/app/evidence.py) and stores the ones
// of the registered values in `model_evidence`.

import { aibomDerivedFields } from "../constants/researchFields.js";

const AIBOM_AREAS = ["model", "provenance", "transformation", "dataset", "evaluation", "safety_ethics", "license_policy"];
export const WHOLE = "*";

// Same key as evaluation_key() in backend/app/evidence.py.
export function evaluationKey(evaluation) {
  const shots = evaluation?.configuration?.shots;
  const parts = [(evaluation?.configuration?.benchmark || "").trim() || "-", (evaluation?.metric || "").trim() || "-"];
  if (shots != null) parts.push(`${shots}-shot`);
  return parts.join(" | ");
}

// `architecture` also covers `architecture.parameter_count`.
const coversField = (rowField, field) => rowField === field || rowField.startsWith(`${field}.`);

/** Rows for one field of an area: those naming the field, and separately the area-wide (`*`) ones. */
export function evidenceForField(rows, area, field) {
  const inArea = (rows || []).filter((row) => row.area === area);
  return {
    field: inArea.filter((row) => coversField(row.field, field)),
    whole: inArea.filter((row) => row.field === WHOLE)
  };
}

const uniqueUrls = (rows) => [...new Set(rows.map((row) => row.url))];

/** Tooltip text and badge label for a value card. */
export function describeEvidence(rows, area, field, { listArea = false } = {}) {
  const { field: own, whole } = listArea
    ? { field: (rows || []).filter((row) => row.area === area), whole: [] }
    : evidenceForField(rows, area, field);
  const ownUrls = uniqueUrls(own);
  const wholeUrls = uniqueUrls(whole).filter((url) => !ownUrls.includes(url));
  if (!ownUrls.length && !wholeUrls.length) return { label: null, tooltip: null };
  const confidence = own.find((row) => row.confidence)?.confidence;
  const lines = [];
  if (ownUrls.length) {
    lines.push(`${listArea ? "항목별 출처" : "이 값의 출처"} ${ownUrls.length}개${confidence ? ` (근거 ${confidence})` : ""}`);
    if (listArea) own.forEach((row) => lines.push(`• ${row.itemKey || "-"} → ${row.url}${row.locator ? ` (${row.locator})` : ""}`));
    else ownUrls.forEach((url) => lines.push(`• ${url}`));
    const note = own.find((row) => row.note)?.note;
    if (note) lines.push(`메모: ${note}`);
  }
  if (wholeUrls.length) {
    lines.push(`${ownUrls.length ? "\n" : ""}영역 전체 출처 ${wholeUrls.length}개`);
    wholeUrls.forEach((url) => lines.push(`• ${url}`));
  }
  return {
    label: ownUrls.length ? `${confidence ? `근거 ${confidence} · ` : ""}출처 ${ownUrls.length}` : `영역 출처 ${wholeUrls.length}`,
    tooltip: lines.join("\n")
  };
}

/**
 * Evidence of the values the reviewer actually kept: every catalog field and AIBOM area / field
 * takes its rows from the research result its value was selected from.
 */
export function composeEvidence({ results, baseKey, aibomKey, catalogFields, overrides, aibomOverrides, aibomFieldOverrides }) {
  const rowsOf = (key) => results[key]?.evidence || [];
  const rows = [];
  catalogFields.forEach((field) => {
    rows.push(...rowsOf(overrides[field] || baseKey).filter((row) => row.area === "catalog" && row.field === field));
  });
  // Catalog fields copied from the AIBOM (the release date) follow the result the AIBOM came from.
  if (aibomKey) rows.push(...rowsOf(aibomKey).filter((row) => row.area === "catalog" && aibomDerivedFields.includes(row.field)));
  AIBOM_AREAS.forEach((area) => {
    const areaSource = aibomOverrides[area] || aibomKey;
    if (!areaSource) return;
    let areaRows = rowsOf(areaSource).filter((row) => row.area === area);
    Object.entries(aibomFieldOverrides).forEach(([fieldKey, source]) => {
      const [fieldArea, ...rest] = fieldKey.split(".");
      const field = rest.join(".");
      if (fieldArea !== area || !source || source === areaSource) return;
      areaRows = areaRows.filter((row) => !coversField(row.field, field))
        .concat(rowsOf(source).filter((row) => row.area === area && coversField(row.field, field)));
    });
    rows.push(...areaRows);
  });
  const seen = new Set();
  return rows.filter((row) => {
    const key = [row.area, row.itemKey, row.field, row.url].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Drop rows of list items the reviewer removed in the editor before registering the model. */
export function pruneEvidence(rows, aibom) {
  if (!aibom) return rows;
  const keep = {
    dataset: new Set((aibom.dataset || []).map((item) => item.identity)),
    evaluation: new Set((aibom.evaluation || []).map(evaluationKey)),
    license_policy: new Set((aibom.license_policy || []).map((item) => item.license))
  };
  const safety = aibom.safety_ethics || {};
  const description = (item) => (typeof item === "object" && item ? item.description : item) || "";
  return rows.filter((row) => {
    if (keep[row.area]) return keep[row.area].has(row.itemKey);
    if (row.area === "safety_ethics") {
      return (safety[row.field] || []).some((item) => description(item).slice(0, 512) === row.itemKey);
    }
    if (row.area === "transformation") return Boolean(aibom.transformation);
    return true;
  });
}

/** Rows of one area, with the selectors the editor uses to place them under each field. */
export function areaEvidence(rows, area) {
  const inArea = (rows || []).filter((row) => row.area === area);
  return {
    rows: inArea,
    /** Rows backing `field` or one of its sub-fields. */
    of: (field) => inArea.filter((row) => coversField(row.field, field)),
    /**
     * Evidence to list under a field: its own rows, or - when the research gave none for this field
     * but the field has a value - the area-wide rows, so the reviewer sees a source next to every
     * value even though the same URLs repeat under several fields.
     */
    under: (field, value) => {
      const own = inArea.filter((row) => coversField(row.field, field));
      if (own.length) return { rows: own, label: "근거" };
      const empty = value == null || value === "" || (Array.isArray(value) && !value.length)
        || (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length);
      return empty ? { rows: [], label: "근거" } : { rows: inArea.filter((row) => row.field === WHOLE), label: "영역 근거" };
    },
    /** Rows of one list item (dataset identity, evaluation key, license). */
    item: (itemKey) => inArea.filter((row) => row.itemKey === itemKey),
    /** Area-wide rows and rows for fields that have no input of their own (e.g. `artifact.format`). */
    except: (fields) => inArea.filter((row) => !fields.some((field) => coversField(row.field, field)))
  };
}

/** Follow list items whose key the reviewer edited: `renames` = [{ area, from, to }]. */
export function rekeyEvidence(rows, renames) {
  if (!renames?.length) return rows;
  const next = new Map(renames.map((item) => [`${item.area}\u0000${item.from}`, item.to]));
  return rows.map((row) => {
    const to = next.get(`${row.area}\u0000${row.itemKey}`);
    return to === undefined ? row : { ...row, itemKey: to };
  });
}

/**
 * Take the evidence of one value from another research result: drop the current rows of
 * `area` (only those of `field` when given) and add that result's rows for the same value.
 */
export function swapEvidence(rows, sourceRows, area, field = null) {
  const hit = (row) => row.area === area && (field == null || coversField(row.field, field));
  return (rows || []).filter((row) => !hit(row)).concat((sourceRows || []).filter(hit));
}
