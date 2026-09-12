import Value from "../common/Value.jsx";

export default function AibomTable({ section }) {
  if (section.legacy) {
    return (
      <section className="aibom-section">
        <h4>{section.title}</h4>
        <div className="aibom-table-wrap">
          <table className="aibom-table">
            <thead><tr><th scope="col">Field</th><th scope="col">Value</th><th scope="col">Status</th></tr></thead>
            <tbody>{section.rows.map((entry) => (
              <tr key={entry.field}>
                <th scope="row">{entry.field}</th>
                <td><Value value={entry.value} /></td>
                <td><span className={`status-pill status-${entry.status.toLowerCase().replaceAll(" ", "-")}`}>{entry.status}</span></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>
    );
  }

  return (
    <section className="aibom-section">
      <h4>{section.title}</h4>
      <div className="aibom-table-wrap">
        <table className="aibom-table">
          <thead>
            <tr>
              <th scope="col">Status</th><th scope="col">Field</th><th scope="col">Value (CycloneDX 1.7)</th><th scope="col">Tier</th><th scope="col">Type</th>
            </tr>
          </thead>
          <tbody>{section.rows.map((entry) => (
            <tr key={entry.name}>
              <td><span className={`status-pill status-${entry.present ? "present" : "missing"}`}>{entry.present ? "Present" : "Missing"}</span></td>
              <th scope="row">{entry.name}</th>
              <td><Value value={entry.value} /></td>
              <td>{entry.tier}</td>
              <td>{entry.type}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}
