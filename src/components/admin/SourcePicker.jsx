export const RESEARCH_SOURCES = [["huggingface", "HF"], ["paper", "논문"], ["merged", "AI 병합"]];

// What the AI merge took a value from, shown on its chip: "AI 병합(HF)".
const ORIGIN_LABELS = { huggingface: "HF", paper: "논문", combined: "HF+논문 결합", both: "HF=논문 동일", inherited: "상속" };
/** Chip label for a result; `origin` (merge only) is a key of ORIGIN_LABELS or null. */
export const sourceLabel = (label, origin) => (origin && ORIGIN_LABELS[origin] ? `${label}(${ORIGIN_LABELS[origin]})` : label);

const preview = (value) => {
  if (value == null || value === "" || (Array.isArray(value) && !value.length)) return "값 없음";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
};

/**
 * Chips that set one value (a field or a whole AIBOM area) from a research result:
 * Hugging Face, paper, AI merge - or leave it as typed ("수동 입력").
 *
 * `options`: [{ key, label, value, matches }] for the research results that exist; `matches` says
 * the current value equals that result's value.
 * Exactly one chip is marked. When several results hold the same value, it is the one the reviewer
 * picked last (`preferred`), otherwise the AI merge, then Hugging Face, then the paper.
 * "수동 입력" is marked when the value matches none of them, or as soon as the reviewer clicks it
 * (`onPick(MANUAL)`): the value stays as it is until they edit it.
 */
const PRIORITY = ["merged", "huggingface", "paper"];

// `preferred` value for "the reviewer chose to enter this value by hand".
export const MANUAL = "manual";

export function activeSource(options, preferred = null) {
  // Manual mode holds even while the value still equals a research result.
  if (preferred === MANUAL) return null;
  const matching = options.filter((option) => option.matches).map((option) => option.key);
  if (matching.includes(preferred)) return preferred;
  return PRIORITY.find((key) => matching.includes(key)) || matching[0] || null;
}

export default function SourcePicker({ options, onPick, scope = "값", preferred = null }) {
  if (!options?.length) return null;
  const active = activeSource(options, preferred);
  const manual = active === null;
  options = options.map((option) => ({ ...option, selected: option.key === active }));
  return <span className="source-picker" role="group" aria-label={`${scope} 출처 선택`}>
    {options.map((option) => <button type="button" key={option.key} className={option.selected ? "is-selected" : ""}
      aria-pressed={option.selected} title={`${option.label} 조사 ${scope}으로 바꾸기${option.matches && !option.selected ? " (현재 값과 같음)" : ""}\n\n${preview(option.value)}`}
      onClick={(event) => { event.preventDefault(); onPick(option.key); }}>
      {option.selected ? "✓ " : ""}{option.label}
    </button>)}
    <button type="button" className={`is-manual${manual ? " is-selected" : ""}`} aria-pressed={manual}
      title={manual ? "직접 입력하는 값입니다. 조사 결과 칩을 누르면 그 값으로 바뀝니다." : "직접 입력으로 전환합니다 (값은 그대로 두고 입력란으로 이동)."}
      onClick={(event) => {
        event.preventDefault();
        onPick(MANUAL);
        event.currentTarget.closest("label, .aibom-area")?.querySelector("input:not([disabled]), textarea, select")?.focus();
      }}>
      {manual ? "✓ " : ""}수동 입력
    </button>
  </span>;
}
