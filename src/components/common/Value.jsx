import { Fragment } from "react";

export default function Value({ value }) {
  if (Array.isArray(value)) {
    return value.map((item, index) => (
      <Fragment key={index}><Value value={item} />{index < value.length - 1 && <br />}</Fragment>
    ));
  }
  if (value && Array.isArray(value.datasetNames) && Array.isArray(value.datasetUrls)) {
    return value.datasetNames.map((name, index) => (
      <Fragment key={`${name}-${index}`}>
        {value.datasetUrls[index]
          ? <a className="table-link" href={value.datasetUrls[index]} target="_blank" rel="noreferrer noopener">{name}</a>
          : name}
        {index < value.datasetNames.length - 1 && <br />}
      </Fragment>
    ));
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  const displayValue = String(value ?? "Not found");
  if (/^https?:\/\//.test(displayValue)) {
    const label = displayValue.length > 72 ? `${displayValue.slice(0, 69)}...` : displayValue;
    return <a className="table-link" href={displayValue} target="_blank" rel="noreferrer noopener">{label}</a>;
  }
  const linkedValue = displayValue.match(/^(.*?) — (https?:\/\/\S+)$/);
  if (linkedValue) return <>{linkedValue[1]} — <Value value={linkedValue[2]} /></>;
  return displayValue;
}
