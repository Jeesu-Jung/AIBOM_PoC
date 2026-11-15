import { WHOLE } from "../../domain/evidence.js";

const SOURCE_LABELS = { huggingface: "HF", paper: "논문", merged: "AI 병합", manual: "수동" };

/**
 * Evidence URLs shown directly under the value they support (catalog field, AIBOM field or item).
 * `rows` are evidence rows already filtered for that value; one line per URL.
 *   target="field"  also names the sub-field a URL backs (e.g. `architecture.parameter_count`)
 *   target="item"   also names the item (e.g. a safety item's description)
 */
export default function EvidenceLinks({ rows, label = "근거", target = null, hideField = null }) {
  if (!rows?.length) return null;
  // One line per URL and place in it: the same page cited for two tables stays two lines.
  const byUrl = new Map();
  rows.forEach((row) => {
    const key = `${row.url}\u0000${row.locator || ""}`;
    if (!byUrl.has(key)) byUrl.set(key, { ...row, targets: [] });
    const entry = byUrl.get(key);
    const name = target === "item" ? row.itemKey : target === "field" && row.field !== WHOLE && row.field !== hideField ? row.field : null;
    if (name && !entry.targets.includes(name)) entry.targets.push(name);
    entry.confidence = entry.confidence || row.confidence;
    entry.note = entry.note || row.note;
  });
  return <div className="evidence-links">
    <span className="evidence-links-label">{label} {byUrl.size}</span>
    <ul>
      {[...byUrl.entries()].map(([key, row]) => <li key={key}>
        <a href={row.url} target="_blank" rel="noreferrer" title={row.url}>{row.url} ↗</a>
        {row.locator && <strong className="evidence-locator">{row.locator}</strong>}
        {row.confidence && <em className={`is-${row.confidence}`}>근거 {row.confidence}</em>}
        {row.source && <em>{SOURCE_LABELS[row.source] || row.source}</em>}
        {row.targets.map((name) => <code key={name}>{name}</code>)}
        {row.note && <p>{row.note}</p>}
      </li>)}
    </ul>
  </div>;
}
