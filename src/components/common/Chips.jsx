import { RELATION_LABELS } from "../../constants/relationships.js";
import { toTitleCase } from "../../utils/format.js";

export function RelationChip({ relation }) {
  return <span className={`chip rel-${relation}`}>{RELATION_LABELS[relation] || relation}</span>;
}

export function KindChip({ kind }) {
  return <span className={`chip kind-${kind}`}>{toTitleCase(kind)}</span>;
}
